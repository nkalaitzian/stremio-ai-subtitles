'use strict';

// ---------------------------------------------------------------------------
// End-to-end test: boots the mock OpenSubtitles + mock LLM servers, then the
// addon, and exercises the full pipeline:
//   manifest -> configure -> subtitle list (configured path) -> translated VTT
//   plus cache-hit, error-track and HTML-configure checks.
// Run:  npm test
// ---------------------------------------------------------------------------

const path = require('path');

const MOCK_OS_PORT = 8311;
const MOCK_LLM_PORT = 8312;
const ADDON_PORT = 8320;

process.env.OPENSUBTITLES_BASE = `http://127.0.0.1:${MOCK_OS_PORT}`;
process.env.MOCK_OS_PORT = String(MOCK_OS_PORT);
process.env.CACHE_DIR = path.join(__dirname, '..', '.cache-test');

const { createOSMock, createLLMMock } = require('./mock-servers');

const addon = require('../src/server');

let osServer;
let llmServer;
let addonServer;
let failures = 0;
let checks = 0;

function check(name, condition, detail) {
  checks++;
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServers() {
  await new Promise((resolve) => { osServer = createOSMock().listen(MOCK_OS_PORT, resolve); });
  await new Promise((resolve) => { llmServer = createLLMMock().listen(MOCK_LLM_PORT, resolve); });
  await new Promise((resolve) => { addonServer = addon.listen(ADDON_PORT, resolve); });
  await sleep(200);
}

function stopServers() {
  try { osServer.close(); } catch (e) {}
  try { llmServer.close(); } catch (e) {}
  try { addonServer.close(); } catch (e) {}
}

async function get(url, headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: res.status, headers: res.headers, text, json };
}

async function main() {
  await startServers();
  console.log('AI Subtitle Translator — end-to-end tests\n');

  const base = `http://127.0.0.1:${ADDON_PORT}`;

  // ---- 1. Manifest -------------------------------------------------------
  console.log('[1] manifest.json');
  const manifest = await get(`${base}/manifest.json`);
  check('manifest is valid JSON', !!manifest.json);
  check('resources include subtitles', manifest.json && manifest.json.resources.includes('subtitles'));
  check('types include movie and series', manifest.json && manifest.json.types.includes('movie') && manifest.json.types.includes('series'));
  check('configurationRequired is true', manifest.json && manifest.json.behaviorHints.configurationRequired === true);
  check('config schema has provider/apiKey/targetLang/prompt/osApiKey',
    manifest.json && ['provider', 'apiKey', 'targetLang', 'prompt', 'osApiKey'].every((k) => manifest.json.config.some((c) => c.key === k)));
  check('CORS header present', manifest.headers.get('access-control-allow-origin') === '*');

  // ---- 2. /configure -----------------------------------------------------
  console.log('\n[2] /configure');
  const confJson = await get(`${base}/configure`, { Accept: 'application/json' });
  check('JSON config served', confJson.json && Array.isArray(confJson.json.config));
  const schema = confJson.json.config;
  const optValue = (key) => schema.find((c) => c.key === key);

  const cfg = {
    provider: optValue('provider').options.find((o) => o.startsWith('custom')),
    apiKey: 'test-llm-key',
    targetLang: optValue('targetLang').default,
    prompt: optValue('prompt').default,
    sourceLang: optValue('sourceLang').default,
    model: 'mock-model',
    baseUrl: `http://127.0.0.1:${MOCK_LLM_PORT}/v1`,
    osApiKey: 'mock-os-key',
  };
  check('config object built from schema defaults', cfg.provider && cfg.targetLang && cfg.prompt && cfg.sourceLang);

  const confHtml = await get(`${base}/configure`, { Accept: 'text/html' });
  check('HTML configure page has textarea for prompt', confHtml.text.includes('<textarea'));

  // ---- 3. Configured manifest --------------------------------------------
  console.log('\n[3] configured manifest.json');
  const configPath = encodeURIComponent(JSON.stringify(cfg));
  const confManifest = await get(`${base}/${configPath}/manifest.json`);
  check('configured manifest drops configurationRequired',
    confManifest.json && confManifest.json.behaviorHints.configurationRequired === false);

  // ---- 4. Subtitle list ---------------------------------------------------
  console.log('\n[4] subtitle list with configured values');
  const subsRes = await get(`${base}/${configPath}/subtitles/movie/tt0000001/videoHash=deadbeef&videoSize=1234.json`);
  check('returns subtitles array', subsRes.json && Array.isArray(subsRes.json.subtitles));
  const track = subsRes.json && subsRes.json.subtitles && subsRes.json.subtitles[0];
  check('track has id/url/lang', track && !!track.id && !!track.url && !!track.lang);
  check('track url points at subtitle.vtt', track && track.url.includes('/subtitle.vtt?'));
  check('track url embeds config (provider/model/baseUrl)', track && track.url.includes('provider=custom') && track.url.includes('model=mock-model'));
  check('list is cacheable', subsRes.headers.get('cache-control') && subsRes.headers.get('cache-control').includes('max-age'));

  // ---- 5. Translated VTT --------------------------------------------------
  console.log('\n[5] translated VTT');
  if (track && track.url) {
    const vtt = await get(track.url);
    check('VTT responds 200', vtt.status === 200);
    check('VTT content type', vtt.headers.get('content-type').includes('text/vtt'));
    check('starts with WEBVTT', vtt.text.startsWith('WEBVTT'));
    check('timestamps converted to VTT format', vtt.text.includes('00:00:01.000 --> 00:00:03.000'));
    check('contains Greek translation', vtt.text.includes('Γεια σου κόσμε'));
    check('contains all three cues', vtt.text.includes('Τι κάνεις;') && vtt.text.includes('Τα λέμε σύντομα'));

    // ---- 6. Cache hit -----------------------------------------------------
    console.log('\n[6] translation cache');
    const before = await get(`http://127.0.0.1:${MOCK_LLM_PORT}/stats`);
    const vtt2 = await get(track.url);
    const after = await get(`http://127.0.0.1:${MOCK_LLM_PORT}/stats`);
    check('second fetch still serves translated VTT', vtt2.status === 200 && vtt2.text.includes('Γεια σου κόσμε'));
    check('LLM not called again (cache hit)', after.json.translateCalls === before.json.translateCalls,
      `calls before=${before.json.translateCalls} after=${after.json.translateCalls}`);
  } else {
    check('translated VTT', false, 'no track to fetch');
  }

  // ---- 7. Missing OpenSubtitles key -> error track -------------------------
  console.log('\n[7] error track when OS key missing');
  const cfgNoKey = { ...cfg, osApiKey: '' };
  const noKeyPath = encodeURIComponent(JSON.stringify(cfgNoKey));
  const errRes = await get(`${base}/${noKeyPath}/subtitles/movie/tt0000001/videoHash=deadbeef&videoSize=1234.json`);
  const errTrack = errRes.json && errRes.json.subtitles && errRes.json.subtitles[0];
  check('error track returned', errTrack && errTrack.id.startsWith('ai-error-'));
  if (errTrack) {
    const errVtt = await get(errTrack.url);
    check('error VTT explains the problem', errVtt.text.includes('OpenSubtitles'));
    check('error VTT is not cached', errVtt.headers.get('cache-control') === 'no-store');
  }

  // ---- 8. Missing videoHash -> empty list ---------------------------------
  console.log('\n[8] empty list without videoHash');
  const noHash = await get(`${base}/subtitles/movie/tt0000001.json`);
  check('empty subtitles list', noHash.json && Array.isArray(noHash.json.subtitles) && noHash.json.subtitles.length === 0);

  // ---- 9. Unconfigured request still works with defaults -------------------
  console.log('\n[9] unconfigured request uses defaults');
  const plain = await get(`${base}/subtitles/movie/tt0000001/videoHash=deadbeef&videoSize=1234.json`);
  check('defaults produce an error track (no OS key)', plain.json && plain.json.subtitles && plain.json.subtitles[0].id.startsWith('ai-error-'));

  stopServers();
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('Test run crashed:', err);
  stopServers();
  process.exit(1);
});
