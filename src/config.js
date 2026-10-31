'use strict';

// Single source of truth for the addon/manifest version.
const { version: VERSION } = require('../package.json');

// ---------------------------------------------------------------------------
// Languages available for translation
// ---------------------------------------------------------------------------

const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'el', name: 'Greek' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)' },
  { code: 'ru', name: 'Russian' },
  { code: 'zh', name: 'Chinese (Simplified)' },
  { code: 'zh-TW', name: 'Chinese (Traditional)' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'ar', name: 'Arabic' },
  { code: 'hi', name: 'Hindi' },
  { code: 'tr', name: 'Turkish' },
  { code: 'nl', name: 'Dutch' },
  { code: 'pl', name: 'Polish' },
  { code: 'sv', name: 'Swedish' },
  { code: 'da', name: 'Danish' },
  { code: 'no', name: 'Norwegian' },
  { code: 'fi', name: 'Finnish' },
  { code: 'cs', name: 'Czech' },
  { code: 'he', name: 'Hebrew' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'th', name: 'Thai' },
  { code: 'id', name: 'Indonesian' },
  { code: 'ro', name: 'Romanian' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'bg', name: 'Bulgarian' },
  { code: 'hr', name: 'Croatian' },
  { code: 'sr', name: 'Serbian' },
  { code: 'sk', name: 'Slovak' },
  { code: 'sl', name: 'Slovenian' },
  { code: 'lt', name: 'Lithuanian' },
  { code: 'lv', name: 'Latvian' },
  { code: 'et', name: 'Estonian' },
  { code: 'fa', name: 'Persian' },
  { code: 'ca', name: 'Catalan' },
  { code: 'ms', name: 'Malay' },
  { code: 'fil', name: 'Filipino' },
  { code: 'sw', name: 'Swahili' },
];

const AUTO_OPTION = 'auto – Any available (prefer English)';

const GITHUB_URL = 'https://github.com/nkalaitzian/stremio-ai-subtitles';
const KOFI_URL = 'https://ko-fi.com/pastouris';

const langOption = (l) => `${l.code} – ${l.name}`;

function codeFromOption(option) {
  if (!option || typeof option !== 'string') return null;
  const code = option.split('–')[0].trim();
  return code || null;
}

function nameForCode(code) {
  const l = LANGUAGES.find((l) => l.code === code);
  return l ? l.name : code;
}

// ---------------------------------------------------------------------------
// AI providers
// ---------------------------------------------------------------------------
// "openai-compatible" kind covers OpenAI, DeepSeek, Grok (xAI), OpenRouter,
// Ollama, LM Studio, vLLM and any other /chat/completions endpoint.
// ---------------------------------------------------------------------------

const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    kind: 'openai-compatible',
    defaultModel: 'gpt-4o-mini',
    defaultBaseUrl: 'https://api.openai.com/v1',
    needsKey: true,
  },
  deepseek: {
    label: 'DeepSeek',
    kind: 'openai-compatible',
    defaultModel: 'deepseek-chat',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    needsKey: true,
  },
  grok: {
    label: 'Grok (xAI)',
    kind: 'openai-compatible',
    defaultModel: 'grok-3',
    defaultBaseUrl: 'https://api.x.ai/v1',
    needsKey: true,
  },
  openrouter: {
    label: 'OpenRouter',
    kind: 'openai-compatible',
    defaultModel: 'openai/gpt-4o-mini',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
  },
  anthropic: {
    label: 'Anthropic Claude',
    kind: 'anthropic',
    defaultModel: 'claude-sonnet-4-5',
    defaultBaseUrl: 'https://api.anthropic.com',
    needsKey: true,
  },
  gemini: {
    label: 'Google Gemini',
    kind: 'gemini',
    defaultModel: 'gemini-2.5-flash',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    needsKey: true,
  },
  deepl: {
    label: 'DeepL',
    kind: 'deepl',
    defaultModel: '',
    defaultBaseUrl: 'https://api-free.deepl.com',
    needsKey: true,
  },
  libretranslate: {
    label: 'LibreTranslate (self-hosted or public)',
    kind: 'libretranslate',
    defaultModel: '',
    defaultBaseUrl: 'https://libretranslate.com',
    needsKey: false,
  },
  google: {
    label: 'Google Translate (free, experimental)',
    kind: 'google',
    defaultModel: '',
    defaultBaseUrl: 'https://translate.googleapis.com',
    needsKey: false,
  },
  custom: {
    label: 'Custom OpenAI-compatible (Ollama, LM Studio, vLLM, ...)',
    kind: 'openai-compatible',
    defaultModel: '',
    defaultBaseUrl: '',
    needsKey: false,
  },
};

const providerOption = ([id, p]) => `${id} – ${p.label}`;
const PROVIDER_OPTIONS = Object.entries(PROVIDERS).map(providerOption);

const DEFAULT_PROMPT =
  'You are a professional subtitle translator. Translate each subtitle line into {targetLang}. ' +
  'Keep names, numbers and tone unchanged. Output ONLY a JSON array of strings: exactly one ' +
  'translation per input line, in the same order, with no numbering and no extra commentary.';

// ---------------------------------------------------------------------------
// The config schema shown on Stremio's addon configuration screen.
// (Also served by GET /configure and mirrored in manifest.json)
// ---------------------------------------------------------------------------

function configSchema() {
  return [
    {
      key: 'provider',
      type: 'select',
      title: 'AI provider',
      options: PROVIDER_OPTIONS,
      default: 'deepseek – DeepSeek',
      required: true,
    },
    {
      key: 'apiKey',
      type: 'password',
      title: 'Provider API key (leave empty for local / Google Translate)',
      default: '',
    },
    {
      key: 'targetLang',
      type: 'select',
      title: 'Translate subtitles to',
      options: LANGUAGES.map(langOption),
      default: 'el – Greek',
      required: true,
    },
    {
      key: 'prompt',
      type: 'text',
      title: 'Translation prompt (LLM providers only; {targetLang} is replaced)',
      default: DEFAULT_PROMPT,
    },
    {
      key: 'sourceLang',
      type: 'select',
      title: 'Source subtitle language',
      options: [AUTO_OPTION, ...LANGUAGES.map(langOption)],
      default: AUTO_OPTION,
    },
    {
      key: 'model',
      type: 'text',
      title: 'Model name (leave empty to use the provider default)',
      default: '',
    },
    {
      key: 'baseUrl',
      type: 'text',
      title: 'API base URL (leave empty to use the default endpoint)',
      default: '',
    },
    {
      key: 'osApiKey',
      type: 'password',
      title: 'OpenSubtitles.com API key (free, get one at opensubtitles.com/consumers)',
      default: '',
      required: true,
    },
  ];
}

const CONFIG_KEYS = ['provider', 'apiKey', 'targetLang', 'prompt', 'sourceLang', 'model', 'baseUrl', 'osApiKey'];

// ---------------------------------------------------------------------------
// Parse the configured values. Stremio ships the chosen config to the addon as
// a URL path segment: encodeURIComponent(JSON.stringify(config)).
// We also accept base64-encoded JSON and plain query params as fallbacks.
// ---------------------------------------------------------------------------

function parseConfigSegment(segment) {
  if (!segment) return null;
  try {
    const obj = JSON.parse(segment);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch (e) { /* fall through */ }
  try {
    const obj = JSON.parse(Buffer.from(segment, 'base64').toString('utf8'));
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch (e) { /* fall through */ }
  try {
    const params = new URLSearchParams(segment);
    const obj = {};
    for (const [k, v] of params) obj[k] = v;
    if (Object.keys(obj).length) return obj;
  } catch (e) { /* fall through */ }
  return null;
}

function mergeConfig(pathConfig, query) {
  const merged = { ...(pathConfig || {}) };
  for (const key of CONFIG_KEYS) {
    if (query[key] !== undefined) merged[key] = query[key];
  }
  return merged;
}

function resolveConfig(raw) {
  raw = raw || {};
  const providerOpt = typeof raw.provider === 'string' && raw.provider ? raw.provider : 'deepseek – DeepSeek';
  let providerId = codeFromOption(providerOpt);
  if (!providerId || !PROVIDERS[providerId]) providerId = 'deepseek';
  const provider = PROVIDERS[providerId];

  const targetOpt = typeof raw.targetLang === 'string' && raw.targetLang ? raw.targetLang : 'el – Greek';
  const targetCode = codeFromOption(targetOpt) || 'el';

  const sourceOpt = typeof raw.sourceLang === 'string' && raw.sourceLang ? raw.sourceLang : AUTO_OPTION;
  const sourceCode = sourceOpt.toLowerCase().startsWith('auto') ? 'auto' : codeFromOption(sourceOpt) || 'auto';

  return {
    providerId,
    provider,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
    osApiKey: typeof raw.osApiKey === 'string' ? raw.osApiKey.trim() : '',
    model: typeof raw.model === 'string' ? raw.model.trim() : '',
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl.trim().replace(/\/+$/, '') : '',
    targetCode,
    targetName: nameForCode(targetCode),
    sourceCode,
    prompt: typeof raw.prompt === 'string' && raw.prompt.trim() ? raw.prompt.trim() : DEFAULT_PROMPT,
  };
}

function renderPrompt(prompt, cfg) {
  const label = cfg.targetName && cfg.targetName !== cfg.targetCode
    ? `${cfg.targetName} (${cfg.targetCode})`
    : cfg.targetCode;
  return String(prompt || DEFAULT_PROMPT).replace(/\{targetLang\}/g, label).replace(/\{language\}/g, label);
}

// ---------------------------------------------------------------------------
// Human friendly /configure HTML page (with a real textarea for the prompt).
// Served when the request Accepts text/html; otherwise /configure returns JSON.
// ---------------------------------------------------------------------------

function configureHtml(initialConfig) {
  const schema = configSchema();
  const initial = initialConfig && typeof initialConfig === 'object' ? initialConfig : null;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const fields = schema.map((entry) => {
    // Linkify any "opensubtitles.com/consumers" reference in the field labels.
    const labelText = esc(entry.title).replace(
      /opensubtitles\.com\/consumers/g,
      '<a href="https://www.opensubtitles.com/en/consumers" target="_blank" rel="noopener">opensubtitles.com/consumers</a>'
    );
    const title = `<label for="${entry.key}">${labelText}</label>`;
    const value = initial && typeof initial[entry.key] === 'string' ? initial[entry.key] : (entry.default || '');
    if (entry.type === 'select') {
      const opts = entry.options.map((o) => {
        const selected = o === value ? ' selected' : '';
        return `<option value="${esc(o)}"${selected}>${esc(o)}</option>`;
      }).join('');
      return `<div class="field">${title}<select id="${entry.key}">${opts}</select></div>`;
    }
    if (entry.key === 'prompt') {
      return `<div class="field">${title}<textarea id="${entry.key}" rows="6">${esc(value)}</textarea></div>`;
    }
    const type = entry.type === 'password' ? 'password' : 'text';
    return `<div class="field">${title}<input type="${type}" id="${entry.key}" value="${esc(value)}"></div>`;
  }).join('');

  const subText = initial
    ? 'Editing an installed add-on. Copy the updated URL, then remove the old install in Stremio and paste it again.'
    : 'Pick the AI provider, API key, target language and translation prompt, then install the addon into Stremio.';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Subtitle Translator – Configuration</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; background: #1b1b23; color: #eee; margin: 0; padding: 24px; }
  .box { max-width: 640px; margin: 0 auto; background: #26262f; border-radius: 12px; padding: 24px 28px; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  p.sub { color: #9a9ab0; margin: 0 0 20px; font-size: .9rem; }
  .version { color: #9a9ab0; font-size: .82rem; margin: 0 0 12px; letter-spacing: .02em; }
  .field { margin-bottom: 16px; }
  label { display: block; font-size: .85rem; color: #c9c9dd; margin-bottom: 6px; }
  label a { color: #a98bd6; }
  input, select, textarea { width: 100%; box-sizing: border-box; background: #1b1b23; color: #eee; border: 1px solid #3d3d4d; border-radius: 8px; padding: 10px; font-size: .95rem; font-family: inherit; }
  textarea { resize: vertical; }
  button { background: #8a5aab; color: #fff; border: 0; border-radius: 8px; padding: 12px 22px; font-size: 1rem; font-weight: 600; cursor: pointer; }
  button:hover { background: #9b68bd; }
  .url { margin-top: 18px; font-size: .8rem; color: #9a9ab0; word-break: break-all; }
  .hint { font-size: .78rem; color: #7f7f95; margin-top: 6px; }
  .links { margin-top: 20px; padding-top: 14px; border-top: 1px solid #3d3d4d; font-size: .82rem; color: #7f7f95; }
  .links a { color: #a98bd6; text-decoration: none; }
  .links a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="box">
  <h1>AI Subtitle Translator</h1>
  <p class="version">v${VERSION}</p>
  <p class="sub">${subText}</p>
  <form id="form" onsubmit="return false;">
    ${fields}
    <button id="install">Install in Stremio</button>
  </form>
  <div class="url" id="url"></div>
  <p class="hint">Paste the URL above into Stremio → Addons → "Add addon". Stremio accepts plain http:// only for 127.0.0.1 addresses — make sure the addon server is running.</p>
  <p class="hint">Reconfiguring? Stremio requires you to <b>remove the old install first</b>, then paste the new URL. Your non-secret settings are remembered here, so you only re-enter the API keys.</p>
  <p class="links">
    <a href="${GITHUB_URL}" target="_blank" rel="noopener">GitHub project</a>
    <span>·</span>
    <a href="${KOFI_URL}" target="_blank" rel="noopener">☕ Support on Ko-fi</a>
  </p>
</div>
<script>
  const keys = ${JSON.stringify(schema.map((e) => e.key))};
  const secretKeys = ${JSON.stringify(schema.filter((e) => e.type === 'password').map((e) => e.key))};
  const INITIAL = ${JSON.stringify(initial)};
  const STORAGE_KEY = 'aisubtitles.config.v1';
  function buildPath() {
    const config = {};
    for (const k of keys) {
      const el = document.getElementById(k);
      config[k] = el ? el.value : '';
    }
    return encodeURIComponent(JSON.stringify(config));
  }
  function refresh() {
    const path = buildPath();
    const plainUrl = location.protocol + '//' + location.host + '/' + path + '/manifest.json';
    const isLocal = ['127.0.0.1', 'localhost', '::1'].includes(location.hostname);
    const btn = document.getElementById('install');
    document.getElementById('url').textContent = 'Addon URL: ' + plainUrl;
    if (INITIAL) {
      // Opened from the gear on an installed add-on: nothing can update the
      // installed transport URL in place, so hand over the new URL to re-add.
      btn.textContent = 'Copy updated addon URL';
      btn.onclick = () => {
        navigator.clipboard.writeText(plainUrl)
          .then(() => { btn.textContent = 'Copied — remove the old install, then paste this URL'; })
          .catch(() => { window.prompt('Copy this URL and paste it into Stremio:', plainUrl); });
      };
    } else if (isLocal) {
      // stremio:// deep links are rewritten to https:// by the app, which fails
      // on a plain-HTTP local server — so copy the http:// URL instead.
      btn.textContent = 'Copy addon URL';
      btn.onclick = () => {
        navigator.clipboard.writeText(plainUrl)
          .then(() => { btn.textContent = 'Copied — paste it into Stremio'; })
          .catch(() => { window.prompt('Copy this URL and paste it into Stremio:', plainUrl); });
      };
    } else {
      btn.textContent = 'Install in Stremio';
      btn.onclick = () => { location.href = 'stremio://' + location.host + '/' + path + '/manifest.json'; };
    }
  }
  // Remember the non-secret fields between visits so reconfiguring doesn't mean
  // retyping everything. API keys are never persisted.
  function loadSaved() {
    if (INITIAL) return; // the installed config is authoritative
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && typeof saved === 'object') {
        for (const k of keys) {
          if (secretKeys.includes(k)) continue;
          const el = document.getElementById(k);
          if (el && typeof saved[k] === 'string') el.value = saved[k];
        }
      }
    } catch (e) {}
  }
  function save() {
    try {
      const cfg = {};
      for (const k of keys) {
        if (secretKeys.includes(k)) continue;
        const el = document.getElementById(k);
        cfg[k] = el ? el.value : '';
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    } catch (e) {}
  }
  loadSaved();
  document.getElementById('form').addEventListener('input', () => { save(); refresh(); });
  refresh();
</script>
</body>
</html>`;
}

function landingHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Subtitle Translator – Stremio Addon</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; background: #1b1b23; color: #eee; display: flex; min-height: 100vh; margin: 0; align-items: center; justify-content: center; }
  .box { text-align: center; max-width: 520px; padding: 24px; }
  h1 { margin: 0 0 8px; }
  p { color: #9a9ab0; line-height: 1.5; }
  a.btn { display: inline-block; background: #8a5aab; color: #fff; text-decoration: none; border-radius: 8px; padding: 12px 26px; font-weight: 600; margin-top: 12px; }
  code { background: #26262f; padding: 2px 6px; border-radius: 4px; }
  .links { margin-top: 22px; font-size: .85rem; color: #7f7f95; }
  .links a { color: #a98bd6; text-decoration: none; }
  .links a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="box">
  <h1>AI Subtitle Translator</h1>
  <p>Stremio addon that translates subtitles into a language you pick, using AI providers such as OpenAI, Anthropic, DeepSeek, Grok, Gemini and DeepL.</p>
  <a class="btn" href="/configure">Configure &amp; Install</a>
  <p style="margin-top:20px;font-size:.85rem">Or paste this URL into Stremio's "Add addon" box:<br><code id="u"></code></p>
  <p class="links">
    <a href="${GITHUB_URL}" target="_blank" rel="noopener">GitHub project</a>
    <span>·</span>
    <a href="${KOFI_URL}" target="_blank" rel="noopener">☕ Support on Ko-fi</a>
  </p>
</div>
<script>document.getElementById('u').textContent = location.protocol + '//' + location.host + '/manifest.json';</script>
</body>
</html>`;
}

module.exports = {
  VERSION,
  LANGUAGES,
  PROVIDERS,
  PROVIDER_OPTIONS,
  AUTO_OPTION,
  DEFAULT_PROMPT,
  configSchema,
  CONFIG_KEYS,
  codeFromOption,
  nameForCode,
  parseConfigSegment,
  mergeConfig,
  resolveConfig,
  renderPrompt,
  configureHtml,
  landingHtml,
};
