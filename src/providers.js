'use strict';

// ---------------------------------------------------------------------------
// AI provider adapters. Every adapter exposes the same contract:
//   translate({ lines, from, to, prompt, model, baseUrl, apiKey }) -> Promise<string[]>
// "lines" is the source text array; the returned array must have the same
// length, one translation per entry.
// ---------------------------------------------------------------------------

const { PROVIDERS } = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, options = {}, retries = 2, timeout = 150000) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
      if (res.ok) return res;
      const body = await res.text().catch(() => '');
      lastErr = new Error(`HTTP ${res.status} from ${url}: ${body.slice(0, 300)}`);
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '', 10);
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 900 * Math.pow(2, attempt);
        await sleep(Math.min(wait, 15000));
        continue;
      }
      throw lastErr;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(900 * Math.pow(2, attempt));
        continue;
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Response parsing for LLM providers: we ask for a JSON array of strings and
// fall back to line splitting + length matching if the model misbehaves.
// ---------------------------------------------------------------------------

function parseArrayResponse(raw, expected, fallbackLines) {
  if (!raw) throw new Error('Empty response from translation provider');
  let text = String(raw).trim().replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const arr = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(arr)) {
        const flat = arr.map((x) => (Array.isArray(x) ? x[0] : x)).filter((x) => typeof x === 'string' && x.length > 0);
        if (flat.length) return matchLength(flat, fallbackLines);
      }
    } catch (e) { /* fall through */ }
  }
  // Fallback: one line per input line
  let parts = text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0 && !/^\d+$/.test(s));
  return matchLength(parts, fallbackLines);
}

function matchLength(parts, fallbackLines) {
  const out = [];
  for (let i = 0; i < fallbackLines.length; i++) {
    out.push(parts[i] || fallbackLines[i] || '');
  }
  return out;
}

function joinForLLM(lines) {
  return JSON.stringify(lines);
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

async function translateOpenAICompatible({ lines, from, to, prompt, model, baseUrl, apiKey }) {
  if (!model) throw new Error('No model configured for this provider');
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let body = {
    model,
    temperature: 0.2,
    max_tokens: 8192,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: joinForLLM(lines) },
    ],
  };
  let res;
  try {
    res = await fetchWithRetry(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    // Some models reject max_tokens=8192; retry with a lower cap.
    if (String(err.message).includes('max_tokens') || String(err.message).includes('400')) {
      body.max_tokens = 4096;
      res = await fetchWithRetry(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
    } else {
      throw err;
    }
  }
  const data = await res.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : null;
  return parseArrayResponse(content, lines.length, lines);
}

async function translateAnthropic({ lines, from, to, prompt, model, baseUrl, apiKey }) {
  if (!model) throw new Error('No model configured for this provider');
  if (!apiKey) throw new Error('Anthropic requires an API key');
  const res = await fetchWithRetry(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system: prompt,
      messages: [{ role: 'user', content: joinForLLM(lines) }],
    }),
  });
  const data = await res.json();
  const content = data && Array.isArray(data.content)
    ? data.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
    : null;
  return parseArrayResponse(content, lines.length, lines);
}

async function translateGemini({ lines, from, to, prompt, model, baseUrl, apiKey }) {
  if (!model) throw new Error('No model configured for this provider');
  if (!apiKey) throw new Error('Gemini requires an API key');
  const res = await fetchWithRetry(`${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: prompt }] },
      contents: [{ role: 'user', parts: [{ text: joinForLLM(lines) }] }],
      generationConfig: { temperature: 0.2 },
    }),
  });
  const data = await res.json();
  const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content
    ? (data.candidates[0].content.parts || [])
    : [];
  const content = parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('');
  return parseArrayResponse(content, lines.length, lines);
}

// DeepL: language codes for EN and PT need the uppercase regional variant.
function mapDeepL(code) {
  const map = {
    en: 'EN-US', 'en-US': 'EN-US', 'en-GB': 'EN-GB',
    pt: 'PT-BR', 'pt-BR': 'PT-BR', 'pt-PT': 'PT-PT',
    zh: 'ZH', 'zh-TW': 'ZH',
  };
  if (map[code]) return map[code];
  return (code || '').split('-')[0];
}

async function translateDeepL({ lines, from, to, prompt, model, baseUrl, apiKey }) {
  if (!apiKey) throw new Error('DeepL requires an API key');
  const targetLang = mapDeepL(to);
  const sourceLang = from && from !== 'auto' ? mapDeepL(from) : '';
  const results = [];
  // DeepL accepts many "text" params; keep batches small to stay safe.
  for (let i = 0; i < lines.length; i += 25) {
    const batch = lines.slice(i, i + 25);
    const body = new URLSearchParams();
    for (const line of batch) body.append('text', line);
    body.append('target_lang', targetLang);
    if (sourceLang) body.append('source_lang', sourceLang);
    const res = await fetchWithRetry(`${baseUrl}/v2/translate`, {
      method: 'POST',
      headers: { Authorization: `DeepL-Auth-Key ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await res.json();
    if (!data || !Array.isArray(data.translations)) throw new Error(`Unexpected DeepL response: ${JSON.stringify(data).slice(0, 200)}`);
    for (const t of data.translations) results.push(t.text);
  }
  return matchLength(results, lines);
}

// LibreTranslate: plain ISO 639-1 codes; no regional variants.
function mapLibre(code) {
  if (!code || code === 'auto') return 'auto';
  const map = { 'zh-TW': 'zt', 'pt-BR': 'pt', 'pt-PT': 'pt' };
  return map[code] || code.split('-')[0];
}

async function translateLibreTranslate({ lines, from, to, prompt, model, baseUrl, apiKey }) {
  const body = { q: lines, source: mapLibre(from), target: mapLibre(to), format: 'text' };
  if (apiKey) body.api_key = apiKey;
  let res = await fetchWithRetry(`${baseUrl}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = await res.json();
  if (data && data.error && /language/i.test(data.error) && mapLibre(to) === 'zt') {
    // Some LibreTranslate builds call traditional Chinese "zh"; retry once.
    body.target = 'zh';
    res = await fetchWithRetry(`${baseUrl}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    data = await res.json();
  }
  if (data && data.error) throw new Error(`LibreTranslate error: ${data.error}`);
  const out = data && Array.isArray(data.translatedText) ? data.translatedText : null;
  if (!out) throw new Error(`Unexpected LibreTranslate response: ${JSON.stringify(data).slice(0, 200)}`);
  return matchLength(out, lines);
}

function mapGoogle(code) {
  if (!code || code === 'auto') return 'auto';
  return code; // Google accepts pt-BR, zh-TW, etc.
}

async function translateGoogle({ lines, from, to, prompt, model, baseUrl, apiKey }) {
  const targetLang = mapGoogle(to);
  const results = [];
  let batch = [];
  let batchChars = 0;
  const flush = async () => {
    if (!batch.length) return;
    const q = batch.join('\n');
    const url = `${baseUrl}/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(q)}`;
    const res = await fetchWithRetry(url, { headers: { 'User-Agent': 'Mozilla/5.0 StremioAISubtitles/1.0' } }, 3);
    const data = await res.json();
    const segments = data && Array.isArray(data[0]) ? data[0] : [];
    const translated = segments.map((s) => (s && s[0]) || '').join('');
    for (const line of translated.split('\n')) results.push(line);
    batch = [];
    batchChars = 0;
  };
  for (const line of lines) {
    if (batch.length && batchChars + line.length > 1500) await flush();
    batch.push(line);
    batchChars += line.length + 1;
  }
  await flush();
  return matchLength(results, lines);
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

async function translateChunk(opts) {
  const { providerId, lines, from, to, prompt, model, baseUrl, apiKey } = opts;
  const provider = PROVIDERS[providerId] || PROVIDERS.custom;
  const kind = provider.kind;
  const resolvedModel = model || provider.defaultModel;
  const resolvedBaseUrl = (baseUrl || provider.defaultBaseUrl).replace(/\/+$/, '');
  if (!resolvedBaseUrl) throw new Error(`No base URL configured for provider "${providerId}"`);
  if (provider.needsKey && !apiKey && kind !== 'google') {
    throw new Error(`Provider "${providerId}" requires an API key`);
  }
  const args = { lines, from, to, prompt, model: resolvedModel, baseUrl: resolvedBaseUrl, apiKey };
  switch (kind) {
    case 'openai-compatible': return translateOpenAICompatible(args);
    case 'anthropic': return translateAnthropic(args);
    case 'gemini': return translateGemini(args);
    case 'deepl': return translateDeepL(args);
    case 'libretranslate': return translateLibreTranslate(args);
    case 'google': return translateGoogle(args);
    default: throw new Error(`Unknown provider kind: ${kind}`);
  }
}

module.exports = { translateChunk };
