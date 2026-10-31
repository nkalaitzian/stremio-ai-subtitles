'use strict';

// ---------------------------------------------------------------------------
// End-to-end test: boots the mock OpenSubtitles + mock LLM servers, then the
// addon, and exercises the full pipeline:
//   manifest -> configure -> subtitle list (configured path) -> translated VTT
//   plus cache-hit, error-track and HTML-configure checks.
// Run:  npm test
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');

const MOCK_OS_PORT = 8311;
const MOCK_LLM_PORT = 8312;
const ADDON_PORT = 8320;

const CACHE_DIR = path.join(__dirname, '..', '.cache-test');
fs.rmSync(CACHE_DIR, { recursive: true, force: true });

process.env.OPENSUBTITLES_BASE = `http://127.0.0.1:${MOCK_OS_PORT}`;
process.env.MOCK_OS_PORT = String(MOCK_OS_PORT);
process.env.CACHE_DIR = CACHE_DIR;

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
  check('manifest version is 1.1.1', manifest.json && manifest.json.version === '1.1.1');
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

  // ---- 4. Subtitle list with per-source variants --------------------------
  console.log('\n[4] subtitle list: labeled variants per source subtitle');
  const subsRes = await get(`${base}/${configPath}/subtitles/movie/tt0000001/videoHash=deadbeef&videoSize=1234.json`);
  check('returns subtitles array', subsRes.json && Array.isArray(subsRes.json.subtitles));
  const subs = subsRes.json && subsRes.json.subtitles ? subsRes.json.subtitles : [];
  check('one track per source + one auto track (4 total)', subs.length === 4, `got ${subs.length}`);
  check('all tracks carry the target language', subs.every((t) => t.lang === cfg.targetLang.split('–')[0].trim()));
  check('all tracks have a label', subs.every((t) => typeof t.label === 'string' && t.label.length > 0));

  const autoTrack = subs.find((t) => t.label === 'AI translate (best match)');
  check('auto track is first', subs[0] && subs[0] === autoTrack);
  check('auto track url uses mode=auto and no fixed file', autoTrack && autoTrack.url.includes('mode=auto') && !autoTrack.url.includes('fileId='));

  const labels = subs.map((t) => t.label).sort();
  check('English variants are labeled with source names',
    labels.includes('AI from English — sample') && labels.includes('AI from English — sample2 (HI)'));
  check('French variant is labeled', labels.includes('AI from French'));

  const frTrack = subs.find((t) => t.label === 'AI from French');
  const enTrack = subs.find((t) => t.label === 'AI from English — sample');
  check('source variants embed their file id and config',
    frTrack && frTrack.url.includes('fileId=43') && frTrack.url.includes('provider=custom') && frTrack.url.includes('model=mock-model'));
  check('list is cacheable', subsRes.headers.get('cache-control') && subsRes.headers.get('cache-control').includes('max-age'));

  // ---- 4b. OpenSubtitles request format + IMDb fallback --------------------
  console.log('\n[4b] OpenSubtitles search parameters');
  const osStats = await get(`http://127.0.0.1:${MOCK_OS_PORT}/stats`);
  check('search uses moviehash + moviebytesize',
    osStats.json.searches.some((p) => p.moviehash === 'deadbeef' && p.moviebytesize === '1234'));
  check('search uses a numeric imdb_id (no "tt" prefix)',
    osStats.json.searches.some((p) => p.imdb_id === '1'));
  check('no legacy video_hash parameter',
    !osStats.json.searches.some((p) => 'video_hash' in p));

  const fallbackRes = await get(`${base}/${configPath}/subtitles/movie/tt0000001/videoHash=feedface&videoSize=1234.json`);
  const fallbackSubs = fallbackRes.json && fallbackRes.json.subtitles ? fallbackRes.json.subtitles : [];
  check('unknown hash falls back to the IMDb id', fallbackSubs.length === 4, `got ${fallbackSubs.length}`);

  // ---- 4c. Series episodes use the show id + season/episode ----------------
  console.log('\n[4c] series episode lookup');
  const seriesRes = await get(`${base}/${configPath}/subtitles/series/tt0000002:3:4/videoHash=feedface&videoSize=1234.json`);
  const seriesSubs = seriesRes.json && seriesRes.json.subtitles ? seriesRes.json.subtitles : [];
  check('series episode returns variants', seriesSubs.length === 4, `got ${seriesSubs.length}`);
  const seriesStats = await get(`http://127.0.0.1:${MOCK_OS_PORT}/stats`);
  check('series search sends parent_imdb_id + season + episode',
    seriesStats.json.searches.some((p) =>
      p.parent_imdb_id === '2' && p.season_number === '3' && p.episode_number === '4'));
  const seriesAuto = seriesSubs.find((t) => t.label === 'AI translate (best match)');
  check('series auto track keeps the full episode id',
    !!seriesAuto && decodeURIComponent(seriesAuto.url).includes('id=series:tt0000002:3:4'));
  if (seriesAuto) {
    const seriesVtt = await get(seriesAuto.url);
    check('series auto track resolves and translates', seriesVtt.text.includes('Γεια σου κόσμε'));
  }

  // ---- 5. Translated VTT from an explicit source ---------------------------
  console.log('\n[5] translated VTT from a chosen source (English variant)');
  if (enTrack && enTrack.url) {
    const vtt = await get(enTrack.url);
    check('VTT responds 200', vtt.status === 200);
    check('VTT content type', vtt.headers.get('content-type').includes('text/vtt'));
    check('starts with WEBVTT', vtt.text.startsWith('WEBVTT'));
    check('timestamps converted to VTT format', vtt.text.includes('00:00:01.000 --> 00:00:03.000'));
    check('contains Greek translation', vtt.text.includes('Γεια σου κόσμε'));
    check('contains all three cues', vtt.text.includes('Τι κάνεις;') && vtt.text.includes('Τα λέμε σύντομα'));

    // ---- 6. Cache hits -----------------------------------------------------
    console.log('\n[6] translation cache');
    let before = await get(`http://127.0.0.1:${MOCK_LLM_PORT}/stats`);
    const vtt2 = await get(enTrack.url);
    let after = await get(`http://127.0.0.1:${MOCK_LLM_PORT}/stats`);
    check('second fetch still serves translated VTT', vtt2.status === 200 && vtt2.text.includes('Γεια σου κόσμε'));
    check('LLM not called again (cache hit)', after.json.translateCalls === before.json.translateCalls,
      `calls before=${before.json.translateCalls} after=${after.json.translateCalls}`);

    console.log('\n[6b] auto track resolves best source and reuses cache');
    const autoVtt = await get(autoTrack.url);
    const afterAuto = await get(`http://127.0.0.1:${MOCK_LLM_PORT}/stats`);
    check('auto track returns translated VTT', autoVtt.status === 200 && autoVtt.text.includes('Γεια σου κόσμε'));
    check('auto track reuses cached translation of the best source',
      afterAuto.json.translateCalls === after.json.translateCalls,
      `calls before=${after.json.translateCalls} after=${afterAuto.json.translateCalls}`);

    console.log('\n[6c] different source (French) translates fresh');
    const frVtt = await get(frTrack.url);
    const afterFr = await get(`http://127.0.0.1:${MOCK_LLM_PORT}/stats`);
    check('French source variant returns translated VTT', frVtt.status === 200 && frVtt.text.startsWith('WEBVTT'));
    check('French source triggers exactly one new LLM call',
      afterFr.json.translateCalls === afterAuto.json.translateCalls + 1,
      `calls before=${afterAuto.json.translateCalls} after=${afterFr.json.translateCalls}`);
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
  check('error track is labeled', errTrack && errTrack.label === '⚠ AI Subtitle Translator');
  if (errTrack) {
    const errVtt = await get(errTrack.url);
    check('error VTT explains the problem', errVtt.text.includes('OpenSubtitles'));
    check('error VTT is not cached', errVtt.headers.get('cache-control') === 'no-store');
  }

  // ---- 7b. Invalid OpenSubtitles key -> real error, not "no subs" ----------
  console.log('\n[7b] invalid OpenSubtitles key is reported honestly');
  const cfgBadKey = { ...cfg, osApiKey: 'bad-key' };
  const badKeyPath = encodeURIComponent(JSON.stringify(cfgBadKey));
  const badRes = await get(`${base}/${badKeyPath}/subtitles/movie/tt0000001/videoHash=deadbeef&videoSize=1234.json`);
  const badTrack = badRes.json && badRes.json.subtitles && badRes.json.subtitles[0];
  check('search error track returned', badTrack && badTrack.id === 'ai-error-search-failed',
    badTrack && badTrack.id);
  if (badTrack) {
    const badVtt = await get(badTrack.url);
    check('error explains the OpenSubtitles login failure', badVtt.text.includes('login failed'));
    check('error is not disguised as "no subtitles"', !badVtt.text.includes('no source subtitles'));
  }

  // ---- 8. Missing videoHash -> empty list ---------------------------------
  console.log('\n[8] empty list without videoHash');
  const noHash = await get(`${base}/subtitles/movie/tt0000001.json`);
  check('empty subtitles list', noHash.json && Array.isArray(noHash.json.subtitles) && noHash.json.subtitles.length === 0);

  // ---- 9. Unconfigured request still works with defaults -------------------
  console.log('\n[9] unconfigured request uses defaults');
  const plain = await get(`${base}/subtitles/movie/tt0000001/videoHash=deadbeef&videoSize=1234.json`);
  check('defaults produce an error track (no OS key)', plain.json && plain.json.subtitles && plain.json.subtitles[0].id.startsWith('ai-error-'));

  // ---- 10. Explicit source language config filters variants ----------------
  console.log('\n[10] explicit source language filters variants');
  const cfgFr = { ...cfg, sourceLang: 'fr – French' };
  const frPath = encodeURIComponent(JSON.stringify(cfgFr));
  const frRes = await get(`${base}/${frPath}/subtitles/movie/tt0000001/videoHash=deadbeef&videoSize=1234.json`);
  const frSubs = frRes.json && frRes.json.subtitles ? frRes.json.subtitles : [];
  check('only French variants and no auto track',
    frSubs.length === 1 && frSubs[0].label === 'AI from French' && !frSubs.some((t) => t.label === 'AI translate (best match)'),
    `labels: ${frSubs.map((t) => t.label).join(' | ')}`);

  stopServers();
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('Test run crashed:', err);
  stopServers();
  process.exit(1);
});
