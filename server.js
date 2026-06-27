require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const path    = require('path');
const ngrok   = require('@ngrok/ngrok');
const { saveCall, getCalls } = require('./db');
const { searchStudies }      = require('./studies');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const VAPI_BASE    = 'https://api.vapi.ai';
const VAPI_HEADERS = {
  Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
  'Content-Type': 'application/json',
};

// ─── Clinical evidence embedded in prompt ────────────────────────────────────
const CLINICAL_EVIDENCE = `
AVAILABLE CLINICAL EVIDENCE (cite these when relevant, using natural language — never read codes or abbreviations aloud):

[EFFICACY]
A 2024 phase III trial in the New England Journal of Medicine (n=1,240) showed a 34% reduction in glycated hemoglobin versus placebo over 24 weeks.

[NAUSEA / GI TOLERABILITY]
A 2023 study in Alimentary Pharmacology and Therapeutics found nausea incidence of 8.3% versus 3.1% in the placebo group. Typically mild and self-resolving within 7 days without discontinuation.

[METFORMIN INTERACTION]
A 2024 study in Clinical Pharmacology and Therapeutics found no clinically significant pharmacokinetic interaction with metformin 500 to 2000 milligrams per day. Exposure change was below 8%.

[IBUPROFEN INTERACTION]
A 2024 study in the British Journal of Clinical Pharmacology found no significant interaction with ibuprofen 400 to 800 milligrams. No dose adjustment required.

[RENAL IMPAIRMENT]
A 2024 study in the American Journal of Kidney Diseases: 50% dose reduction required when kidney filtration rate is between 15 and 29 milliliters per minute. Contraindicated when filtration rate falls below 15 milliliters per minute (severe renal impairment, stage 5).

[ELDERLY PATIENTS]
A 2023 study in the Journal of Gerontology found no significant difference in adverse events versus standard of care in patients 65 years and older with comorbidities.

[HYPERTENSION SUBGROUP]
A 2023 analysis in the Journal of Hypertension showed consistent efficacy in hypertensive patients. No clinically relevant effect on blood pressure was observed, making it a suitable option alongside antihypertensive therapy.

[DOSING]
A 2024 clinical therapeutics guideline: standard dose is 10 milligrams once daily. Reduce to 5 milligrams for patients 75 years and older, or with moderate renal impairment.
`;

// ─── Tool definition ─────────────────────────────────────────────────────────
function buildTools(webhookUrl) {
  return [
    {
      type: 'function',
      function: {
        name: 'searchPubMed',
        description: 'Search PubMed for published clinical studies on topics NOT already covered in your system prompt — such as novel drug combinations, rare populations, or specific mechanisms not listed. Do NOT call this for topics already answered by the embedded evidence.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Specific clinical question in English (e.g. "metformin GLP-1 combination elderly renal impairment")',
            },
          },
          required: ['query'],
        },
      },
      server: { url: `${webhookUrl}/webhook/vapi` },
    },
  ];
}

// ─── Assistant payload ───────────────────────────────────────────────────────
function buildAssistantPayload(webhookUrl) {
  return {
    name: 'Medical Science Liaison AI',
    firstMessage:
      "Good day, Doctor. I'm your dedicated Medical Science representative. I'd love to hear about your recent experience with our new treatment. Could you share your clinical observations so far?",
    serverUrl: `${webhookUrl}/webhook/vapi`,
    model: {
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: `You are an AI Medical Science Liaison representing a pharmaceutical company.
Your role is to have a professional, clinical, and concise scientific dialogue with licensed physicians.

${CLINICAL_EVIDENCE}

RESPONSE STRUCTURE (follow this order every time):
1. Answer the doctor's current question directly and specifically, citing the relevant evidence above when applicable.
2. Then — and only then — ask ONE follow-up question to build the clinical picture.
Never skip the answer. Never ask a follow-up without first answering.

WHEN CITING EVIDENCE:
- Be specific: mention the year, the journal, and the key finding.
- Vary your phrasing: "A 2024 trial in [journal] found…", "Published data from [journal] indicates…", "Clinical evidence from [year] shows…"
- If the doctor asks WHY you recommend something, explain the specific finding that supports it.

CLARIFICATION:
- If you do not understand what the doctor said, ask one short clarifying question instead of guessing.

OUT-OF-SCOPE QUESTIONS:
- If the doctor asks about a population, condition, or drug combination NOT covered in the evidence above (e.g. hepatic impairment, pregnancy, dialysis, NASH, type 1 diabetes), respond immediately with:
  "We don't have published data specific to that population in our current evidence package. I'll escalate this to our Medical Affairs team and follow up with you directly."
- Never search, never pause, never say "un momento". Respond instantly.

PROHIBITED (never output these under any circumstances):
- "un momento", "dame un momento", "solo un 2º", "espera un segundo", "wait a moment", "just a second", "one moment", "let me check", "let me search"

NUMBER FORMATTING (critical for text-to-speech):
- Always write percentages as words: "34 percent" not "34%"
- Always write doses as words: "5 milligrams" not "5mg"
- Always write ranges as words: "15 to 29 milliliters per minute" not "15-29 mL/min"
- Never use abbreviations: write "milliliters per minute", "milligrams", "millimoles per liter"

LIMITS:
- Keep every response under 65 words.
- Never invent drug names, study data, or dosing figures.
- Never make claims beyond approved label indications.`,
        },
      ],
      tools: [],
    },
    voice: {
      provider: '11labs',
      voiceId: 'EXAVITQu4vr4xnSDxMaL',
      model: 'eleven_multilingual_v2',
      stability: 0.5,
      similarityBoost: 0.75,
    },
    transcriber: {
      provider: 'deepgram',
      model: 'nova-2',
      language: 'en-US',
    },
    silenceTimeoutSeconds: 60,
    maxDurationSeconds: 600,
    endCallMessage: 'Thank you for your time, Doctor. I will follow up with the requested information. Have a great day.',
  };
}

// ─── Assistant upsert ────────────────────────────────────────────────────────
let cachedAssistantId = null;

async function upsertAssistant(webhookUrl) {
  const payload  = buildAssistantPayload(webhookUrl);
  const listRes  = await axios.get(`${VAPI_BASE}/assistant`, { headers: VAPI_HEADERS });
  const existing = listRes.data.find((a) => a.name === payload.name);

  if (existing) {
    try {
      await axios.patch(`${VAPI_BASE}/assistant/${existing.id}`, payload, { headers: VAPI_HEADERS });
    } catch (e) {
      console.error('[vapi] PATCH error:', JSON.stringify(e.response?.data || e.message));
      throw e;
    }
    console.log(`[vapi] Updated assistant: ${existing.id}`);
    cachedAssistantId = existing.id;
    return existing.id;
  }

  const res = await axios.post(`${VAPI_BASE}/assistant`, payload, { headers: VAPI_HEADERS });
  cachedAssistantId = res.data.id;
  console.log(`[vapi] Created assistant: ${cachedAssistantId}`);
  return cachedAssistantId;
}

// ─── Summary generation ──────────────────────────────────────────────────────
async function generateSummary(transcript, lang) {
  const isEs = lang === 'es';
  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: isEs
            ? 'Eres un coordinador de asuntos médicos. Genera resúmenes estructurados de llamadas MSL en español.'
            : 'You are a medical affairs coordinator. Generate structured MSL call summaries in English.',
        },
        {
          role: 'user',
          content: `${isEs ? 'Genera un resumen estructurado en español de esta llamada MSL.' : 'Generate a structured MSL call summary from this transcript.'}

TRANSCRIPT:
${transcript}

Extract ONLY information explicitly mentioned in the transcript. Do NOT use placeholders. If something was not discussed, write "Not discussed."

Sections:
1. Clinical Observations (patient count, outcomes, timeframes)
2. Medications & Dosing (drugs, doses, frequency mentioned)
3. Safety Concerns / Adverse Events
4. Evidence Cited During Call
5. Doctor's Questions
6. Action Items & Follow-up Required`,
        },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );
  return res.data.choices[0].message.content;
}

// ─── Routes ──────────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    assistantId:   cachedAssistantId,
    vapiPublicKey: process.env.VAPI_PUBLIC_KEY || process.env.VAPI_API_KEY,
  });
});

app.get('/api/calls', (req, res) => res.json(getCalls()));

app.post('/api/summarize', async (req, res) => {
  const { transcript, lang } = req.body;
  if (!transcript || transcript.trim().length < 30) {
    return res.json({ summary: '' });
  }
  try {
    const summary = await generateSummary(transcript, lang || 'en');
    res.json({ summary });
  } catch (e) {
    console.error('[summarize]', e.message);
    res.status(500).json({ summary: '' });
  }
});

// ─── Webhook ─────────────────────────────────────────────────────────────────
app.post('/webhook/vapi', async (req, res) => {
  const event = req.body?.message || req.body;
  console.log(`[webhook] type=${event.type || 'unknown'}`);

  if (event.type === 'tool-calls') {
    const results = [];
    for (const call of event.toolCallList || []) {
      if (call.function.name === 'searchPubMed') {
        const args  = typeof call.function.arguments === 'string'
          ? JSON.parse(call.function.arguments)
          : call.function.arguments;
        console.log(`[pubmed] tool call: "${args.query}"`);
        const result = await searchStudies(args.query);
        results.push({ toolCallId: call.id, result });
      }
    }
    return res.json({ results });
  }

  if (event.type === 'end-of-call-report') {
    const callId = event.call?.id || `call_${Date.now()}`;
    const lang   = event.call?.assistantOverrides?.transcriber?.language?.startsWith('es') ? 'es' : 'en';

    let plainTxt = '';
    if (typeof event.transcript === 'string' && event.transcript.length > 20) {
      plainTxt = event.transcript;
    } else {
      const msgs = event.messages || event.artifact?.messages || [];
      plainTxt = msgs
        .filter((m) => ['user', 'assistant', 'bot'].includes(m.role))
        .map((m) => {
          const role    = (m.role === 'assistant' || m.role === 'bot') ? 'MSL AI' : 'Doctor';
          const content = m.content || m.message || m.text || '';
          return `${role}: ${content}`;
        })
        .join('\n');
    }

    console.log(`[end-of-call] callId=${callId} transcript_length=${plainTxt.length}`);

    let summary = '';
    try {
      summary = await generateSummary(plainTxt, lang);
      console.log('[summary] generated');
    } catch (e) {
      console.error('[summary] error:', e.message);
    }

    saveCall({
      id:         callId,
      started_at: event.startedAt  || new Date().toISOString(),
      ended_at:   event.endedAt    || new Date().toISOString(),
      duration_s: event.durationSeconds || 0,
      language:   lang,
      transcript: plainTxt,
      summary,
    });
  }

  res.sendStatus(200);
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function boot() {
  let publicUrl = (process.env.SERVER_URL || '').trim() || null;

  if (!publicUrl && process.env.NGROK_AUTH_TOKEN) {
    try {
      const listener = await ngrok.connect({ addr: PORT, authtoken: process.env.NGROK_AUTH_TOKEN });
      publicUrl = listener.url();
      console.log(`[ngrok] tunnel → ${publicUrl}`);
    } catch (e) {
      console.warn('[ngrok] failed:', e.message);
    }
  }

  await upsertAssistant(publicUrl || 'https://placeholder.example.com');

  app.listen(PORT, () => {
    console.log(`\n🩺  Medical Science Liaison AI`);
    console.log(`    Local  → http://localhost:${PORT}`);
    if (publicUrl) console.log(`    Public → ${publicUrl}`);
    console.log(`    Assistant ID → ${cachedAssistantId}\n`);
  });
}

boot().catch((e) => { console.error('[boot error]', e.message); process.exit(1); });
