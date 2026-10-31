'use strict';

// ---------------------------------------------------------------------------
// Minimal OpenSubtitles.com REST API client.
//   GET  /api/v1/subtitles -> search by moviehash / imdb_id
//   POST /api/v1/download  -> temporary download link
// Both endpoints authenticate with the Api-Key header alone. The consumer API
// key is tied to the user's account, so it carries the download quota — no
// username/password login is needed. Downloaded source files are cached on
// disk to spare the daily download quota.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const USER_AGENT = 'StremioAISubtitles/1.0';
const SRC_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// OpenSubtitles expects IMDb ids as integers (tt0111161 -> 111161) and the
// file hash as "moviehash". Passing the Stremio-style "tt..." string or
// "video_hash" silently yields zero search results.
function numericImdb(id) {
  if (id === null || id === undefined) return null;
  const m = /(\d+)/.exec(String(id));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function markAuthError(message) {
  const err = new Error(message);
  err.auth = true;
  return err;
}

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
  }

  baseHeaders() {
    return {
      'User-Agent': USER_AGENT,
      'Api-Key': this.apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  // Search and return raw "attributes" objects.
  async search(params, type) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, v);
    }
    if (type) qs.set('type', type);
    const url = `${this.base}/subtitles?${qs.toString()}`;
    const res = await fetch(url, { headers: this.baseHeaders(), signal: AbortSignal.timeout(15000) });
    if (res.status === 401 || res.status === 403) {
      throw markAuthError('OpenSubtitles search failed (HTTP ' + res.status + ') — check your OpenSubtitles.com API key');
    }
    if (!res.ok) throw new Error(`OpenSubtitles search failed (HTTP ${res.status})`);
    const data = await res.json().catch(() => null);
    return (data && data.data) || [];
  }

  // Try hash first (most accurate), then IMDb id, with and without a language
  // filter. Score results: prefer non-hearing-impaired, non-machine-translated
  // subtitles with many downloads.
  //
  // API parameter names matter: `moviehash` / `moviebytesize` (not
  // `video_hash`), and `imdb_id` / `parent_imdb_id` must be numeric. Series
  // episodes are looked up by the show's IMDb id plus season/episode numbers.
  async searchBest({ videoHash, videoSize, imdbId, type, season, episode, languages, limit = 15 }) {
    const imdb = numericImdb(imdbId);

    const hashParams = {};
    if (videoHash) hashParams.moviehash = String(videoHash);
    if (videoSize !== undefined && videoSize !== null && videoSize !== '') {
      hashParams.moviebytesize = String(videoSize);
    }

    const idParams = {};
    if (imdb) {
      if (type === 'episode') {
        idParams.parent_imdb_id = imdb;
        if (Number.isInteger(season)) idParams.season_number = season;
        if (Number.isInteger(episode)) idParams.episode_number = episode;
      } else {
        idParams.imdb_id = imdb;
      }
    }

    const langFilter = languages && languages.length ? languages.join(',') : null;
    const attempts = [];
    if (langFilter) {
      if (hashParams.moviehash) attempts.push({ ...hashParams, languages: langFilter });
      if (Object.keys(idParams).length) attempts.push({ ...idParams, languages: langFilter });
    }
    if (hashParams.moviehash) attempts.push(hashParams);
    if (Object.keys(idParams).length) attempts.push(idParams);
    if (!attempts.length) return [];

    const byFile = new Map();
    const errors = [];
    for (const params of attempts) {
      let data = [];
      try {
        data = await this.search(params, type);
      } catch (err) {
        errors.push(err);
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
      if (byFile.size >= limit) break;
    }

    // If every lookup failed (bad API key, network, malformed request), report
    // the real error instead of pretending there were no subtitles.
    if (!byFile.size) {
      const authErr = errors.find((e) => e.auth);
      if (authErr) throw authErr;
      if (errors.length === attempts.length) throw errors[0];
    }

    const list = [...byFile.values()].sort((a, b) => b.score - a.score);
    return list.slice(0, limit);
  }

  async requestDownload(fileId) {
    return fetch(`${this.base}/download`, {
      method: 'POST',
      headers: this.baseHeaders(),
      body: JSON.stringify({ file_id: Number(fileId) }),
      signal: AbortSignal.timeout(15000),
    });
  }

  async parseDownload(res) {
    if (res.status === 407) {
      throw new Error('OpenSubtitles daily download limit reached (407). Upgrade your OpenSubtitles plan or try again tomorrow.');
    }
    if (res.status === 406 || res.status === 401 || res.status === 403) {
      throw markAuthError('OpenSubtitles download failed (HTTP ' + res.status + ') — check your OpenSubtitles.com API key');
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenSubtitles download failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
    }
    const data = await res.json().catch(() => null);
    if (!data || !data.link) throw new Error('OpenSubtitles returned no download link');
    return data;
  }

  async downloadLink(fileId) {
    return this.parseDownload(await this.requestDownload(fileId));
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
