'use strict';

// ---------------------------------------------------------------------------
// Chunked subtitle translation with two-level caching:
//   - in-memory Map (fast repeat requests)
//   - disk JSON files under .cache/tr (survives restarts)
// Each chunk of cues is translated independently with limited concurrency and
// cache keyed on provider + model + languages + prompt + source lines.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { translateChunk } = require('./providers');
const { sanitize } = require('./subtitleFormat');

const MAX_CHUNK_LINES = 40;
const MAX_CHUNK_CHARS = 6000;
const CONCURRENCY = 3;
const MAX_MEM_ENTRIES = 1500;

let diskDir = null;
function setCacheDir(dir) { diskDir = dir; }

const mem = new Map();

function chunkKey(chunkLines, opts) {
  const h = crypto.createHash('sha1');
  h.update(JSON.stringify({
    provider: opts.provider,
    model: opts.model,
    baseUrl: opts.baseUrl,
    from: opts.from,
    to: opts.to,
    prompt: opts.prompt,
    lines: chunkLines,
  }));
  return h.digest('hex');
}

async function diskGet(key) {
  if (!diskDir) return null;
  try {
    const content = await fs.promises.readFile(path.join(diskDir, `${key}.json`), 'utf8');
    const data = JSON.parse(content);
    if (data && Array.isArray(data.lines)) return data.lines;
  } catch (e) { /* miss */ }
  return null;
}

async function diskSet(key, lines) {
  if (!diskDir) return;
  try {
    await fs.promises.mkdir(diskDir, { recursive: true });
    const file = path.join(diskDir, `${key}.json`);
    const tmp = `${file}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify({ lines }), 'utf8');
    await fs.promises.rename(tmp, file);
  } catch (e) { /* best effort */ }
}

async function getChunk(chunkLines, opts) {
  const key = chunkKey(chunkLines, opts);
  if (mem.has(key)) return mem.get(key);
  const disk = await diskGet(key);
  if (disk) {
    mem.set(key, disk);
    return disk;
  }
  const translated = await translateChunk({ ...opts, lines: chunkLines });
  mem.set(key, translated);
  if (mem.size > MAX_MEM_ENTRIES) mem.delete(mem.keys().next().value);
  await diskSet(key, translated);
  return translated;
}

function chunkify(lines) {
  const chunks = [];
  let current = [];
  let chars = 0;
  for (const line of lines) {
    if (current.length && (current.length >= MAX_CHUNK_LINES || chars + line.length > MAX_CHUNK_CHARS)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(line);
    chars += line.length + 1;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

// cues: [{start, end, text}]; opts: {provider, model, baseUrl, apiKey, from, to, prompt}
async function translateCues(cues, opts) {
  const texts = cues.map((c) => sanitize(c.text));
  const nonEmpty = texts.filter((t) => t.length > 0);
  const results = texts.slice();
  if (!nonEmpty.length) return cues;

  const chunks = chunkify(nonEmpty);
  const chunkResults = new Array(chunks.length);
  let cursor = 0;

  async function worker() {
    while (cursor < chunks.length) {
      const idx = cursor++;
      const chunk = chunks[idx];
      try {
        chunkResults[idx] = await getChunk(chunk, opts);
      } catch (err) {
        // One failed chunk should not kill the whole subtitle; keep the
        // original text for that chunk and report the error on the next cue.
        chunkResults[idx] = chunk;
        chunkResults[idx].__error = err && err.message ? err.message : 'Translation failed';
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, chunks.length); i++) workers.push(worker());
  await Promise.all(workers);

  const flat = [];
  for (const r of chunkResults) flat.push(...r);

  let outIdx = 0;
  const errors = [];
  for (let i = 0; i < texts.length; i++) {
    if (texts[i].length > 0) {
      const translated = flat[outIdx++];
      results[i] = typeof translated === 'string' ? translated : texts[i];
      if (chunkResults.some((c) => c && c.__error) && results[i] === texts[i]) {
        // leave original; error cue appended below
      }
    }
  }
  const failed = chunkResults.filter((c) => c && c.__error).map((c) => c.__error);
  const outCues = cues.map((c, i) => ({ ...c, text: results[i] || c.text }));
  if (failed.length) {
    outCues.push({
      start: outCues.length ? outCues[outCues.length - 1].end : '00:00:01.000',
      end: outCues.length ? outCues[outCues.length - 1].end : '00:00:05.000',
      text: `⚠ ${failed[0]}`,
    });
  }
  return outCues;
}

module.exports = { translateCues, setCacheDir };
