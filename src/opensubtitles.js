'use strict';

// ---------------------------------------------------------------------------
// Minimal OpenSubtitles.com REST API client.
//   POST /api/v1/login     -> JWT (with the Api-Key header)
//   GET  /api/v1/subtitles -> search by video_hash / imdb_id
//   POST /api/v1/download  -> temporary download link
// Downloaded source subtitle files are cached on disk to spare the daily
// download quota.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const USER_AGENT = 'StremioAISubtitles/1.0';
const SRC_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let sourceCacheDir = null;
function setSourceCacheDir(dir) { sourceCacheDir = dir; }

async function readSourceCache(fileId) {
  if (!sourceCacheDir) return null;
  const file = path.join(sourceCacheDir, String(fileId));
  try {
    const st = await fs.promises.stat(file);
    if (Date.now() - st.mtimeMs > SRC_TTL_MS) return null;
    const content = await fs.promises.readFile(file, 'utf8');
    return content || null;
  } catch (e) {
    return null;
  }
}

async function writeSourceCache(fileId, content) {
  if (!sourceCacheDir) return;
  try {
    await fs.promises.mkdir(sourceCacheDir, { recursive: true });
    const tmp = path.join(sourceCacheDir, `${fileId}.tmp`);
    await fs.promises.writeFile(tmp, content, 'utf8');
    await fs.promises.rename(tmp, path.join(sourceCacheDir, String(fileId)));
  } catch (e) { /* caching is best effort */ }
}

class OpenSubtitles {
  constructor(apiKey, baseUrl) {
    this.apiKey = apiKey;
    this.base = `${(baseUrl || 'https://api.opensubtitles.com').replace(/\/+$/, '')}/api/v1`;
    this.token = null;
  }

  baseHeaders(withAuth) {
    const h = {
      'User-Agent': USER_AGENT,
      'Api-Key': this.apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (withAuth && this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async ensureToken() {
    if (this.token) return this.token;
    let res;
    try {
      res = await fetch(`${this.base}/login`, {
        method: 'POST',
        headers: this.baseHeaders(false),
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw new Error(`Could not reach OpenSubtitles: ${err.message}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error('OpenSubtitles login failed (HTTP ' + res.status + ') — check your OpenSubtitles.com API key');
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenSubtitles login failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
    }
    const data = await res.json().catch(() => null);
    if (!data || !data.token) throw new Error('OpenSubtitles login returned no token');
    this.token = data.token;
    return this.token;
  }

  // Search and return raw "attributes" objects.
  async search(params, type) {
    await this.ensureToken();
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, v);
    }
    if (type) qs.set('type', type);
    const url = `${this.base}/subtitles?${qs.toString()}`;
    const res = await fetch(url, { headers: this.baseHeaders(true), signal: AbortSignal.timeout(15000) });
    if (res.status === 401) {
      this.token = null; // token expired; retry once with a fresh one
      await this.ensureToken();
      const res2 = await fetch(url, { headers: this.baseHeaders(true), signal: AbortSignal.timeout(15000) });
      if (res2.ok) {
        const data2 = await res2.json().catch(() => null);
        return (data2 && data2.data) || [];
      }
      throw new Error('OpenSubtitles search failed (HTTP ' + res2.status + ')');
    }
    if (!res.ok) throw new Error(`OpenSubtitles search failed (HTTP ${res.status})`);
    const data = await res.json().catch(() => null);
    return (data && data.data) || [];
  }

  // Try hash first (most accurate), then IMDB id, with and without a language
  // filter. Score results: prefer non-hearing-impaired, non-machine-translated
  // subtitles with many downloads.
  async searchBest({ videoHash, imdbId, type, languages }) {
    const attempts = [];
    if (languages && languages.length) {
      attempts.push({ video_hash: videoHash, languages: languages.join(',') });
      if (imdbId) attempts.push({ imdb_id: imdbId, languages: languages.join(',') });
    }
    attempts.push({ video_hash: videoHash });
    if (imdbId) attempts.push({ imdb_id: imdbId });

    const byFile = new Map();
    for (const params of attempts) {
      let data = [];
      try {
        data = await this.search(params, type);
      } catch (err) {
        continue; // try the next strategy
      }
      for (const item of data) {
        const attr = item.attributes || {};
        const files = attr.files || [];
        if (!files.length) continue;
        const fileId = files[0].file_id;
        if (fileId === undefined || byFile.has(fileId)) continue;
        const machine = !!(attr.machine_translated || attr.ai_translated);
        const hi = !!attr.hearing_impaired;
        const score = (hi ? 0 : 2) + (machine ? 0 : 1) + Math.min(attr.download_count || 0, 1000) / 1000;
        byFile.set(fileId, {
          fileId,
          fileName: files[0].file_name || 'subtitle.srt',
          language: attr.language || 'unknown',
          downloadCount: attr.download_count || 0,
          hi,
          machine,
          score,
        });
      }
      if (byFile.size >= 5) break;
    }
    const list = [...byFile.values()].sort((a, b) => b.score - a.score);
    return list.slice(0, 5);
  }

  async downloadLink(fileId) {
    await this.ensureToken();
    const res = await fetch(`${this.base}/download`, {
      method: 'POST',
      headers: this.baseHeaders(true),
      body: JSON.stringify({ file_id: Number(fileId) }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 406) {
      throw new Error('OpenSubtitles daily download limit reached (406). Upgrade the API key or try again tomorrow.');
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenSubtitles download failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
    }
    const data = await res.json().catch(() => null);
    if (!data || !data.link) throw new Error('OpenSubtitles returned no download link');
    return data;
  }

  // Returns the source subtitle file content (cached on disk).
  async fetchFile({ fileId, fileName }) {
    const cached = await readSourceCache(fileId);
    if (cached) return { content: cached, fromCache: true };
    const { link } = await this.downloadLink(fileId);
    let res;
    try {
      res = await fetch(link, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(45000) });
    } catch (err) {
      throw new Error(`Could not download source subtitle: ${err.message}`);
    }
    if (!res.ok) throw new Error(`Could not download source subtitle (HTTP ${res.status})`);
    const content = await res.text();
    if (!content || !content.trim()) throw new Error('Downloaded subtitle file is empty');
    await writeSourceCache(fileId, content);
    return { content, fromCache: false };
  }
}

module.exports = OpenSubtitles;
module.exports.setSourceCacheDir = setSourceCacheDir;
