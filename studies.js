const axios = require('axios');

// ─── Simple in-memory cache with TTL ─────────────────────────────────────────
const cache    = new Map();
const CACHE_MS = 30 * 60 * 1000; // 30 minutes

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_MS) { cache.delete(key); return null; }
  return entry.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, ts: Date.now() });
}

// ─── Rate limiter (PubMed: 3 req/s without key, 10 with key) ─────────────────
let lastCall = 0;
const MIN_INTERVAL = 350; // ms between calls

async function throttle() {
  const wait = MIN_INTERVAL - (Date.now() - lastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

// ─── PubMed search ────────────────────────────────────────────────────────────
const PUBMED_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

async function fetchAbstracts(ids) {
  await throttle();
  const res = await axios.get(`${PUBMED_BASE}/efetch.fcgi`, {
    params: { db: 'pubmed', id: ids.join(','), retmode: 'text', rettype: 'abstract' },
    timeout: 8000,
  });
  return res.data;
}

function cleanAbstract(raw) {
  // Keep only title + abstract, remove PMID/author blocks, trim whitespace
  return raw
    .split('\n\n')
    .filter((block) => block.trim().length > 40)
    .slice(0, 4)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, 1800); // safe context limit
}

async function searchStudies(query) {
  const cacheKey = query.toLowerCase().trim();
  const cached   = cacheGet(cacheKey);
  if (cached) {
    console.log(`[pubmed] cache hit: "${query}"`);
    return cached;
  }

  console.log(`[pubmed] searching: "${query}"`);

  try {
    await throttle();

    // Step 1: search for IDs
    const searchRes = await axios.get(`${PUBMED_BASE}/esearch.fcgi`, {
      params: {
        db:      'pubmed',
        term:    `${query}[Title/Abstract] AND (clinical trial[pt] OR review[pt])`,
        retmax:  3,
        retmode: 'json',
        sort:    'relevance',
        mindate: '2019',
        datetype:'pdat',
      },
      timeout: 8000,
    });

    const ids = searchRes.data?.esearchresult?.idlist || [];

    if (ids.length === 0) {
      const result = 'No published studies found for this specific query. This will be escalated to the Medical Affairs team.';
      cacheSet(cacheKey, result);
      return result;
    }

    // Step 2: fetch abstracts
    const raw    = await fetchAbstracts(ids);
    const result = cleanAbstract(raw);

    cacheSet(cacheKey, result);
    console.log(`[pubmed] found ${ids.length} results for "${query}"`);
    return result;

  } catch (err) {
    console.error('[pubmed] error:', err.message);
    return 'PubMed search temporarily unavailable. This question will be escalated to the Medical Affairs team.';
  }
}

module.exports = { searchStudies };
