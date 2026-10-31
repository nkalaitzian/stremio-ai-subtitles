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
    version: '1.0.0',
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
    // Mirrors the SDK: once configured the addon is installable as-is.
    manifest.behaviorHints.configurable = false;
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

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] === 'https' || req.secure ? 'https' : 'http';
  return `${proto}://${req.get('host')}`;
}

function extractImdbId(id) {
  const m = /(tt\d{5,})/.exec(String(id || ''));
  return m ? m[1] : null;
}

function vttUrl(base, cfg, candidate, type, id, videoHash) {
  const qs = new URLSearchParams({
    fileId: String(candidate.fileId),
    fileName: candidate.fileName || '',
    id: `${type}:${id}`,
    hash: String(videoHash),
    lang: cfg.targetCode,
    source: cfg.sourceCode,
    provider: cfg.providerId,
    model: cfg.model || '',
    baseUrl: cfg.baseUrl || '',
    apiKey: cfg.apiKey || '',
    osKey: cfg.osApiKey || '',
    prompt: cfg.prompt,
  });
  return `${base}/subtitle.vtt?${qs.toString()}`;
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
  const videoHash = query.videoHash || query.video_size || '';

  if (!videoHash) return res.json({ subtitles: [] });

  const base = baseUrl(req);
  const makeErrorTrack = (code, message) => res.json({
    subtitles: [{
      id: `ai-error-${code}`,
      url: `${base}/subtitle.vtt?error=${encodeURIComponent(code)}&lang=${encodeURIComponent(cfg.targetCode)}&msg=${encodeURIComponent(message)}`,
      lang: cfg.targetCode,
    }],
  });

  if (!cfg.osApiKey) {
    return makeErrorTrack('no-os-key',
      'AI Subtitle Translator: no OpenSubtitles.com API key is configured. Reinstall the addon and set one (free at opensubtitles.com/consumers).');
  }

  const os = getOSClient(cfg.osApiKey);
  try {
    const candidates = await os.searchBest({
      videoHash,
      imdbId: extractImdbId(id),
      type: type === 'movie' ? 'movie' : 'episode',
      languages: cfg.sourceCode === 'auto' ? null : [cfg.sourceCode],
    });
    if (!candidates.length) {
      return makeErrorTrack('no-subs',
        `AI Subtitle Translator: no source subtitles found for this video (hash ${videoHash.slice(0, 8)}…).`);
    }
    const subtitles = candidates.slice(0, 3).map((c) => ({
      id: `ai-${cfg.providerId}-${cfg.targetCode}-${c.fileId}-${String(videoHash).slice(0, 8)}`,
      url: vttUrl(base, cfg, c, type, id, videoHash),
      lang: cfg.targetCode,
    }));
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
    if (!q.fileId) throw new Error('Subtitle track is missing its file id');

    const os = getOSClient(q.osKey);
    const { content } = await os.fetchFile({ fileId: q.fileId, fileName: q.fileName });
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

    res.setHeader('Cache-Control', 'public, max-age=604800');
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
