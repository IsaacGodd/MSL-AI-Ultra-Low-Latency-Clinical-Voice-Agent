# MSL AI — Clinical Voice Agent

**The bottleneck in medical AI is latency and hallucinations.** This architecture solves both: Groq's Llama 3.3 70B delivers sub-500ms inference, and a hybrid context router eliminates hallucinations by answering standard queries from strictly embedded, citation-locked clinical evidence — falling back to real-time PubMed API calls only for novel research questions.

## Architecture

| Layer | Technology |
|---|---|
| Voice orchestration | Vapi.ai |
| Speech-to-text | Deepgram nova-2 (EN + ES) |
| Text-to-speech | ElevenLabs eleven_multilingual_v2 |
| LLM | Groq — Llama-3.3-70b-versatile @ temp 0.2 |
| Evidence retrieval | PubMed E-utilities API (cached, rate-limited) |
| Backend | Node.js / Express |
| Storage | JSON (zero native dependencies) |

## Key Design Decisions

- **Embedded evidence first.** Clinical data for common queries lives in the system prompt. No tool call → no latency spike → no filler phrases.
- **PubMed fallback.** Novel questions trigger a `searchPubMed` tool call with 30-min cache and 350ms rate limiting.
- **Temperature 0.2.** Chosen deliberately to minimize clinical hallucinations while preserving natural phrasing.
- **No SQLite.** JSON file storage avoids native compilation issues across environments.

## Features

- Bilingual voice calls (English / Spanish) with per-language voice, transcriber, and system prompt overrides
- Real-time transcript with role differentiation
- Text input channel alongside voice during active calls
- Structured PDF summaries auto-generated post-call (pdfmake, dark-themed, markdown-parsed)
- Call history sidebar with per-call PDF download

## Setup

```bash
git clone https://github.com/IsaacGodd/MSL-AI-Ultra-Low-Latency-Clinical-Voice-Agent.git
cd MSL-AI-Ultra-Low-Latency-Clinical-Voice-Agent
npm install
node build-vapi.mjs   # bundles @vapi-ai/web for the browser
cp .env.example .env  # fill in your keys
node server.js
```

Open `http://localhost:3000`.

## Environment Variables

```
VAPI_API_KEY=
VAPI_PUBLIC_KEY=
GROQ_API_KEY=
NGROK_AUTH_TOKEN=     # local only — omit on Render/Railway
SERVER_URL=           # production URL (replaces ngrok tunnel)
PORT=3000
```

## Deploy (Render)

- Build command: `npm install && node build-vapi.mjs`
- Start command: `node server.js`
- Set `SERVER_URL` to your Render service URL after first deploy
- Do **not** set `NGROK_AUTH_TOKEN` in production

## Live Demo on YT
https://youtu.be/-THQERncIUA
