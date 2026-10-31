'use strict';

// ---------------------------------------------------------------------------
// Stremio "AI Subtitle Translator" addon server.
//
// Protocol notes:
//  - Stremio calls  GET [configPath/]subtitles/{type}/{id}[/{extra}].json
//    with extra = "videoHash=...&videoSize=...&filename=..." and expects
//    { "subtitles": [ { id, url, lang } ] } where url serves WebVTT.
//  - Configured values arrive as a URL path segment containing
//    encodeURIComponent(JSON.stringify(config)).
//  - Every route must allow CORS from any origin.
// ---------------------------------------------------------------------------

const express = require('express');
const path = require('path');

const config = require('./config');
const subtitleFormat = require('./subtitleFormat');
const translate = require('./translate');
const OpenSubtitles = require('./opensubtitles');

const PORT = parseInt(process.env.PORT || '7000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '..', '.cache');

translate.setCacheDir(path.join(CACHE_DIR, 'tr'));
OpenSubtitles.setSourceCacheDir(path.join(CACHE_DIR, 'src'));

const osClients = new Map();
function getOSClient(apiKey) {
  if (!apiKey) return null;
  if (!osClients.has(apiKey)) {
    osClients.set(apiKey, new OpenSubtitles(apiKey, process.env.OPENSUBTITLES_BASE));
  }
  return osClients.get(apiKey);
}

function buildManifest(configured) {
  const manifest = {
    id: 'com.stremio.aisubtitletranslator',
    version: config.VERSION,
    name: 'AI Subtitle Translator',
    description: 'Translates subtitles to a language you pick, using AI providers (OpenAI, Anthropic, DeepSeek, Grok, Gemini, DeepL and more).',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: {
      configurable: true,
      configurationRequired: true,
    },
    config: config.configSchema(),
  };
  if (configured) {
    // Keep `configurable` so Stremio shows the gear on the installed add-on
    // (clicking it opens /<config>/configure). The SDK drops this flag, but
    // then the only way into the settings page is a manual reinstall.
    manifest.behaviorHints.configurable = true;
    manifest.behaviorHints.configurationRequired = false;
  }
  return manifest;
}

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.get('/manifest.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.json(buildManifest(false));
});

app.get('/:configPath/manifest.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.json(buildManifest(true));
});

app.get('/configure', (req, res) => {
  const accept = req.headers.accept || '';
  if (/text\/html/.test(accept)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(config.configureHtml());
  }
  res.json({ config: config.configSchema() });
});

// Stremio's Configure gear opens "<transportUrl without manifest.json>/configure",
// i.e. this route for an installed add-on. Pre-fill the current settings.
app.get('/:configPath/configure', (req, res) => {
  const accept = req.headers.accept || '';
  const raw = config.parseConfigSegment(req.params.configPath);
  if (/text\/html/.test(accept)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(config.configureHtml(raw));
  }
  res.json({ config: config.configSchema() });
});

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(config.landingHtml());
});

app.get('/health', (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Subtitle list endpoint
// ---------------------------------------------------------------------------

function parseExtra(segment) {
  const out = {};
  try {
    const params = new URLSearchParams(segment);
    for (const [k, v] of params) out[k] = v;
  } catch (e) { /* ignore malformed extra */ }
  return out;
}

function firstHeader(value) {
  return String(value || '').split(',')[0].trim();
}

// PUBLIC_URL wins when set; otherwise trust the proxy headers. Some hosts
// (BeamUp) rewrite the Host header to the internal app slug, which would make
// every subtitle-track URL point at a non-existent host.
function baseUrl(req) {
  const publicUrl = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  if (publicUrl) return publicUrl;
  const proto = firstHeader(req.headers['x-forwarded-proto']) || (req.secure ? 'https' : 'http');
  const host = firstHeader(req.headers['x-forwarded-host']) || req.get('host');
  return `${proto}://${host}`;
}

// Stremio sends series episodes as "tt1234567:season:episode". The
// OpenSubtitles API needs the show id plus those numbers.
function parseVideoId(id) {
  const raw = String(id || '');
  const m = /(tt\d{5,})/i.exec(raw);
  let season = null;
  let episode = null;
  if (m) {
    const rest = raw.slice(m.index + m[0].length);
    const parts = rest.split(':').filter((p) => p !== '');
    if (parts.length >= 2) {
      const sn = Number(parts[0]);
      const ep = Number(parts[1]);
      if (Number.isInteger(sn)) season = sn;
      if (Number.isInteger(ep)) episode = ep;
    }
  }
  return { imdbId: m ? m[1] : null, season, episode };
}

function buildTrackUrl(base, cfg, type, id, videoHash, videoSize, candidate) {
  const qs = new URLSearchParams({
    id: `${type}:${id}`,
    hash: String(videoHash),
    size: String(videoSize || ''),
    lang: cfg.targetCode,
    source: cfg.sourceCode,
    provider: cfg.providerId,
    model: cfg.model || '',
    baseUrl: cfg.baseUrl || '',
    apiKey: cfg.apiKey || '',
    osKey: cfg.osApiKey || '',
    prompt: cfg.prompt,
  });
  if (candidate) {
    qs.set('fileId', String(candidate.fileId));
    qs.set('fileName', candidate.fileName || '');
  } else {
    // "Auto" variant: the best source is resolved when the track is selected.
    qs.set('mode', 'auto');
  }
  return `${base}/subtitle.vtt?${qs.toString()}`;
}

// ---------------------------------------------------------------------------
// Track variants: each source subtitle becomes a labeled variant under the
// target language, so the user can pick which subtitle to translate from.
// ---------------------------------------------------------------------------

const MAX_SOURCE_LANGUAGES = 6;
const MAX_PER_LANGUAGE = 2;
const MAX_SOURCE_TRACKS = 8;

function normalizeOsLang(code) {
  const c = String(code || '').toLowerCase();
  const map = { pb: 'pt-BR', 'pt-br': 'pt-BR', 'zh-cn': 'zh', 'zh-tw': 'zh-TW', zt: 'zh-TW' };
  return map[c] || c;
}

function trimFileName(fileName, max) {
  const base = String(fileName || '').replace(/\.(srt|vtt|ass|ssa)$/i, '');
  if (!base) return '';
  if (base.length <= max) return base;
  return `${base.slice(0, Math.max(1, max - 1))}…`;
}

function variantLabel(candidate, langName, duplicate) {
  let label = `AI from ${langName}`;
  if (duplicate) {
    const name = trimFileName(candidate.fileName, 24);
    label += name ? ` — ${name}` : ` — #${candidate.fileId}`;
  }
  if (candidate.hi) label += ' (HI)';
  if (candidate.machine) label += ' (MT)';
  return label;
}

function buildVariantTracks(base, cfg, candidates, type, id, videoHash, videoSize) {
  const hash8 = String(videoHash).slice(0, 8);
  const tracks = [];
  const withAutoTrack = cfg.sourceCode === 'auto';

  let pool = candidates;
  if (!withAutoTrack) {
    // A specific source language is configured: prefer only that language.
    const filtered = candidates.filter((c) =>
      normalizeOsLang(c.language).startsWith(cfg.sourceCode.toLowerCase()));
    if (filtered.length) pool = filtered;
  }

  // One variant per source subtitle, grouped by source language (best first).
  const byLang = new Map();
  for (const c of pool) {
    const langKey = normalizeOsLang(c.language);
    if (!byLang.has(langKey)) byLang.set(langKey, []);
    if (byLang.get(langKey).length < MAX_PER_LANGUAGE) byLang.get(langKey).push(c);
  }
  const langs = [...byLang.keys()].sort(
    (a, b) => (byLang.get(b)[0]?.score || 0) - (byLang.get(a)[0]?.score || 0));

  for (const langKey of langs.slice(0, MAX_SOURCE_LANGUAGES)) {
    const list = byLang.get(langKey);
    const langName = config.nameForCode(langKey);
    for (const c of list) {
      if (tracks.length >= MAX_SOURCE_TRACKS) break;
      tracks.push({
        id: `ai-${cfg.providerId}-${cfg.targetCode}-${c.fileId}-${hash8}`,
        url: buildTrackUrl(base, cfg, type, id, videoHash, videoSize, c),
        lang: cfg.targetCode,
        label: variantLabel(c, langName, list.length > 1),
      });
    }
  }

  if (withAutoTrack) {
    tracks.unshift({
      id: `ai-${cfg.providerId}-${cfg.targetCode}-auto-${hash8}`,
      url: buildTrackUrl(base, cfg, type, id, videoHash, videoSize, null),
      lang: cfg.targetCode,
      label: 'AI translate (best match)',
    });
  }
  return tracks;
}

async function subtitlesHandler(req, res) {
  const { type, id } = req.params;
  res.setHeader('Cache-Control', 'no-store');

  if (type !== 'movie' && type !== 'series') return res.json({ subtitles: [] });

  let pathConfig = null;
  if (req.params.configPath) pathConfig = config.parseConfigSegment(req.params.configPath);
  const rawConfig = config.mergeConfig(pathConfig, req.query);
  const cfg = config.resolveConfig(rawConfig);

  const extra = req.params.extra ? parseExtra(req.params.extra) : {};
  const query = { ...extra, ...req.query };
  const videoHash = query.videoHash || '';
  const videoSize = query.videoSize || '';

  if (!videoHash) return res.json({ subtitles: [] });

  const base = baseUrl(req);
  const makeErrorTrack = (code, message) => res.json({
    subtitles: [{
      id: `ai-error-${code}`,
      url: `${base}/subtitle.vtt?error=${encodeURIComponent(code)}&lang=${encodeURIComponent(cfg.targetCode)}&msg=${encodeURIComponent(message)}`,
      lang: cfg.targetCode,
      label: '⚠ AI Subtitle Translator',
    }],
  });

  if (!cfg.osApiKey) {
    return makeErrorTrack('no-os-key',
      'AI Subtitle Translator: no OpenSubtitles.com API key is configured. Reinstall the addon and set one (free at opensubtitles.com/consumers).');
  }

  const os = getOSClient(cfg.osApiKey);
  const { imdbId, season, episode } = parseVideoId(id);
  try {
    const candidates = await os.searchBest({
      videoHash,
      videoSize,
      imdbId,
      type: type === 'movie' ? 'movie' : 'episode',
      season,
      episode,
      languages: cfg.sourceCode === 'auto' ? null : [cfg.sourceCode],
      limit: 15,
    });
    if (!candidates.length) {
      return makeErrorTrack('no-subs',
        `AI Subtitle Translator: no source subtitles found for this video (hash ${videoHash.slice(0, 8)}…).`);
    }
    const subtitles = buildVariantTracks(base, cfg, candidates, type, id, videoHash, videoSize);
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-if-error=86400');
    res.json({ subtitles });
  } catch (err) {
    console.error(`[subtitles] ${err.message}`);
    makeErrorTrack('search-failed', `AI Subtitle Translator: could not search OpenSubtitles (${err.message})`);
  }
}

app.get('/:configPath/subtitles/:type/:id/:extra.json', subtitlesHandler);
app.get('/:configPath/subtitles/:type/:id.json', subtitlesHandler);
app.get('/subtitles/:type/:id/:extra.json', subtitlesHandler);
app.get('/subtitles/:type/:id.json', subtitlesHandler);

// ---------------------------------------------------------------------------
// Translated WebVTT endpoint (the url embedded in each subtitle track).
// ---------------------------------------------------------------------------

app.get('/subtitle.vtt', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query;

  if (q.error) {
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    return res.send(subtitleFormat.errorVtt(q.msg || `Addon error: ${q.error}`));
  }

  try {
    if (!q.osKey) throw new Error('OpenSubtitles.com API key is not configured');
    const os = getOSClient(q.osKey);

    let candidate;
    if (!q.fileId || q.mode === 'auto') {
      // "Best match" variant: resolve the best source right now.
      const rawId = String(q.id || '');
      const sep = rawId.indexOf(':');
      const idType = sep >= 0 ? rawId.slice(0, sep) : '';
      const videoPart = sep >= 0 ? rawId.slice(sep + 1) : rawId;
      const { imdbId, season, episode } = parseVideoId(videoPart);
      const found = await os.searchBest({
        videoHash: q.hash,
        videoSize: q.size,
        imdbId,
        type: idType === 'movie' ? 'movie' : 'episode',
        season,
        episode,
        languages: q.source && q.source !== 'auto' ? [q.source] : null,
      });
      candidate = found[0];
      if (!candidate) throw new Error('No source subtitles found for this video');
    } else {
      candidate = { fileId: q.fileId, fileName: q.fileName };
    }

    const { content } = await os.fetchFile(candidate);
    const parsed = subtitleFormat.parseSubtitle(content);
    if (!parsed.cues.length) throw new Error('No subtitle cues could be parsed from the source file');

    const from = String(q.source || 'auto').toLowerCase();
    const to = String(q.lang || 'en').toLowerCase();
    const prompt = config.renderPrompt(q.prompt, { targetName: config.nameForCode(to), targetCode: to });

    let outCues = parsed.cues;
    if (from === 'auto' || from !== to) {
      outCues = await translate.translateCues(parsed.cues, {
        provider: String(q.provider || 'deepseek'),
        model: q.model || '',
        baseUrl: q.baseUrl || '',
        apiKey: q.apiKey || '',
        from,
        to,
        prompt,
      });
    }

    res.setHeader('Cache-Control', q.mode === 'auto' ? 'public, max-age=86400' : 'public, max-age=604800');
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.send(subtitleFormat.toVtt(outCues));
  } catch (err) {
    console.error(`[vtt] ${err.message}`);
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.send(subtitleFormat.errorVtt(`AI Subtitle Translator: ${err.message}`));
  }
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`AI Subtitle Translator addon running:`);
    console.log(`  Local URL:      http://127.0.0.1:${PORT}/manifest.json`);
    console.log(`  Config page:    http://127.0.0.1:${PORT}/configure`);
    console.log(`  Add this URL to Stremio (Addons -> Add addon): http://127.0.0.1:${PORT}/manifest.json`);
  });
}
