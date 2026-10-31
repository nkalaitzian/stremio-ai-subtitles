# AGENTS.md — Project instructions for AI assistants

> Read this file **first** when starting a new session on this repository. It contains the
> context needed to continue development without re-deriving anything: what the project is,
> how it works, why key decisions were made, and the current state.

## 1. What this project is

**Stremio "AI Subtitle Translator" addon.** A local web service (Node.js + Express) that acts as a
Stremio subtitle addon. It finds original subtitles for the video being played (via
OpenSubtitles.com), translates them with a user-chosen AI provider (OpenAI, DeepSeek, Grok,
Anthropic, Gemini, DeepL, LibreTranslate, Google Translate, or any custom OpenAI-compatible
endpoint), and serves the result as WebVTT.

The provider, API key, **target language**, and the **translation prompt** are chosen by the user
on **Stremio's addon configuration screen before install** (protocol-driven, no custom UI).

- **Location:** `D:\Development\stremio-ai-subtitles` (moved here from `C:\Users\nikos\.deepseek` — do not look for it there)
- **GitHub:** https://github.com/nkalaitzian/stremio-ai-subtitles (public, `main` branch, origin set)
- **gh CLI:** authenticated as `nkalaitzian`. **git identity:** Nikos Kalaitzian <nikoskalai@gmail.com>
- **Version:** 1.1.2 (manifest + package.json — keep in sync)
- **Stack:** Node.js ≥18 (tested on Node 26), Express 4, **zero other runtime deps** (uses global `fetch`, `crypto`, `fs`). CommonJS.
- **Environment:** Windows (PowerShell), user locale Europe/Athens (Greek default target language is intentional).

## 2. Commands

```powershell
cd D:\Development\stremio-ai-subtitles
npm install      # deps already installed
npm start        # run addon on http://127.0.0.1:7000
npm test         # 56/56 end-to-end checks with mocked upstreams (no real keys needed)
git pull/push    # commit/push as usual
```

Smoke test while running: `curl.exe -s http://127.0.0.1:7000/manifest.json`, `/configure`, `/health`.

**Windows/PowerShell quirks (known, not bugs):**
- `git push` prints progress to stderr → PowerShell reports `[exit code: 1]` even on success. Verify with `git ls-remote --heads origin` or `git status -sb`.
- `Invoke-WebRequest` may fail in NonInteractive mode; use `curl.exe` or `Invoke-RestMethod` instead.
- CRLF line endings are normalized via `.gitattributes` (LF in repo).

## 3. Architecture — file map

```
src/
  server.js          Express app + routes (the protocol surface). Read this to understand endpoints.
  config.js          Language list, provider registry, config schema, /configure HTML page,
                     config parsing (path-segment JSON / base64 / query params), prompt rendering.
  providers.js       AI adapters, one contract: translateChunk({providerId, lines, from, to, prompt,
                     model, baseUrl, apiKey}) -> Promise<string[]>. Kinds: openai-compatible,
                     anthropic, gemini, deepl, libretranslate, google.
  opensubtitles.js   OpenSubtitles.com v1 client: search by moviehash/moviebytesize + imdb_id
                     (numeric) or, for episodes, parent_imdb_id + season_number/episode_number.
                     Search uses only the Api-Key header; downloading requires a JWT obtained by
                     POST /login {username, password}. On-disk source cache (30-day TTL).
  subtitleFormat.js  SRT/WebVTT parsing -> cue objects; toVtt(); sanitize() strips tags/ASS overrides;
                     errorVtt() renders in-player error cues.
  translate.js       Chunked translation (≤40 lines or ≤6000 chars per chunk, concurrency 3),
                     two-level cache (memory Map + JSON files under .cache/tr), key =
                     sha1(provider|model|baseUrl|from|to|prompt|lines). Failed chunks keep original
                     text and append a ⚠ cue.
scripts/
  mock-servers.js    Mock OpenSubtitles (port 8311) + mock LLM (8312). OS mock serves 3 candidates:
                     en#42 (500 dls), en#44 (HI, 100 dls), fr#43 (300 dls); French file returns
                     different SRT content. LLM mock echoes N Greek lines matching input count.
  test.js            E2E suite: addon on 8320, .cache-test dir (wiped on every run). Sections:
                     manifest, /configure (JSON+HTML), configured manifest, variant track list,
                     OpenSubtitles request format + IMDb fallback, series episode lookup,
                     translated VTT from a chosen source, cache hits, auto-track behavior,
                     French re-translation, error tracks (missing/invalid API key, invalid login,
                     missing username/password), empty list, defaults, source-language filtering.
.env.example         PORT/HOST/OPENSUBTITLES_BASE/CACHE_DIR (no secrets — keys are per-install config).
```

## 4. Stremio protocol knowledge (hard-won — do not re-research)

### Endpoints the addon serves
- `GET /manifest.json` — manifest with `resources: ["subtitles"]`, `types: ["movie","series"]`,
  `idPrefixes: ["tt"]`, `catalogs: []`, `behaviorHints: {configurable: true, configurationRequired: true}`,
  and a `config` array (the config screen schema).
- `GET /:configPath/manifest.json` — same, but `configurationRequired`/`configurable` are dropped
  (mirrors the SDK: a configured addon is installable as-is).
- `GET /configure` — content negotiation: `Accept: text/html` → human page with a real `<textarea>`
  for the prompt; otherwise JSON `{ config: [...] }`. (Served both ways for old/new clients.)
- `GET [/ :configPath]/subtitles/:type/:id[/ :extra].json` — the subtitle list. `:extra` is a
  query-string in the path: `videoHash=...&videoSize=...&filename=...` (also accepted as real query
  params). Response: `{ "subtitles": [{ id, url, lang, label? }] }`. `url` **must serve WebVTT**
  (stremio-core only understands .vtt; SRT is converted on the fly).
- `GET /subtitle.vtt?...` — the translated VTT. All settings (provider/model/apiKey/osKey/prompt/
  langs) are embedded as query params because Stremio fetches the exact URL, without config.
- **CORS `Access-Control-Allow-Origin: *` on every route** (including /manifest.json) — mandatory.

### Configuration transport (the tricky part)
Stremio appends the user's choices to the addon URL as a **URL path segment**:
`encodeURIComponent(JSON.stringify(config))`, e.g.
`http://127.0.0.1:7000/%7B%22provider%22%3A...%7D/manifest.json`, and resource requests keep the
segment prefix. The addon parses the segment (JSON → base64-JSON → query-string fallbacks, in
`config.parseConfigSegment`). Express decodes the segment before the handler sees it.
References: stremio-addon-sdk `getRouter.js`/`landingTemplate.js`, stremio-core `http_transport.rs`
(replaces `/manifest.json` with `/{resource}/{type}/{id}/{extra}.json`).

### Critical pitfalls (fixed, keep them fixed)
1. **Local installs must use `http://`, never `https://`** — Stremio only allows plain HTTP for
   `127.0.0.1`, and it rewrites `stremio://` deep links to `https://` (stremio-core
   `addon_details.rs`). That's why `/configure` on localhost shows a **copy-URL button** instead of
   a `stremio://` install link (the rewrite breaks plain-HTTP servers).
2. Subtitle tracks support a **`label`** field (stremio-core `subtitles.rs`); the player renders it
   in the variants list (`stremio-web SubtitleVariant.tsx`). Labels starting with `http` are ignored
   by the client. This label is the foundation of the source-picking UX.
3. The player's subtitle menu has **two panes: languages → variants**. All tracks of one language
   appear as variants; there are no custom buttons — the only interaction is track selection
   (which fetches that track's VTT URL).
4. **OpenSubtitles search parameter names are exact and unforgiving**: `moviehash` +
   `moviebytesize` (NOT `video_hash`), and `imdb_id` / `parent_imdb_id` must be **integers**
   (strip the `tt` prefix). Unknown parameter names are ignored, so a wrong name silently produces
   zero results — not an error. Episodes need `type=episode` + `parent_imdb_id` (show) +
   `season_number` + `episode_number`; Stremio sends the video id as `tt1234567:season:episode`.

### Source-picker design (v1.1.0, the key UX)
The subtitle list returns one labeled track **per source subtitle** (≤2 per language, ≤6 languages,
≤8 tracks), all with `lang = target language`, plus an "AI translate (best match)" track first:
- Label format: `AI from {LangName}[ — {filename trimmed}][ (HI)][ (MT)]`.
- Per-source track URL embeds `fileId`/`fileName` — selection translates that exact file.
- "Best match" track URL has `mode=auto` and **no fileId** — the best source is resolved at fetch
  time (`searchBest` again). Auto VTTs get `max-age=86400`; fixed-source VTTs `max-age=604800`.
- If config `sourceLang` ≠ auto, only variants of that language are returned (no auto track).
- Translation is cache-keyed on **source content**, so different sources never share stale output.

### OpenSubtitles API facts
- Base `https://api.opensubtitles.com/api/v1` (overridable via `OPENSUBTITLES_BASE` for tests).
- **Authentication is two-part.** The `Api-Key` header identifies the app; a JWT identifies the
  user. Search works with the `Api-Key` alone. To **download**, you must first `POST /login` with
  `{username, password}` (+ `Api-Key`) to get a JWT, then send `Authorization: Bearer <token>`.
  The API key by itself **cannot** produce a token — an empty login body is a 401.
- Search: `GET /subtitles?moviehash=...&moviebytesize=...&languages=...&type=movie|episode`.
  - `moviehash` is the OpenSubtitles hash Stremio sends as the `videoHash` extra; `moviebytesize`
    is the `videoSize` extra.
  - `imdb_id` is an **integer** — strip the `tt` prefix (`tt0111161` → `111161`).
  - Series: Stremio sends `tt1234567:season:episode`; query with `type=episode` +
    `parent_imdb_id` (the show, numeric) + `season_number` + `episode_number`. Using `imdb_id`
    alone for an episode returns nothing.
  - There is no `video_hash` parameter: unknown names are ignored and yield zero results silently.
- Download: `POST /download {file_id}` → `{link, remaining,...}`; then GET the link. Error codes:
  **406 = "No session"** (missing/expired token → re-login and retry), **407 = daily quota
  exhausted** (surfaced as a friendly error cue). Do not swap these two.
- `searchBest` scoring: prefer non-hearing-impaired (+2), non-machine-translated (+1),
  + download_count/1000; dedupe by file_id; limit 15. Language code normalization maps
  `pb`→`pt-BR`, `zh-tw`→`zh-TW`, etc.
- If every search attempt fails (bad key, network, malformed request), `searchBest` throws the
  underlying error instead of returning `[]`, so the player sees "API key" / "login failed"
  rather than "no subtitles".

### Error handling philosophy
Never return HTTP 500 to the player for subtitle-list problems. Return a **track whose VTT is an
error cue** (`⚠ AI Subtitle Translator: …`), `Cache-Control: no-store`, so the user sees the reason
inside the player. Used for: missing OS key, no subs found, search/download failures, provider
errors.

## 5. Config schema (the config screen the user asked for)

Order matters (user-requested fields first): `provider` (select), `apiKey` (password),
`targetLang` (select, default `el – Greek`), `prompt` (text, default in `config.js`; the HTML page
renders it as a textarea), then `sourceLang` (select, default `auto`), `model`, `baseUrl`,
`osApiKey` (password, required), `osUsername` (text), `osPassword` (password). Select options are
plain strings `"code – Name"`; code parsed before ` – `. `{targetLang}` in the prompt is replaced
with `Name (code)`.

Provider registry (`config.PROVIDERS`): `openai` (gpt-4o-mini), `deepseek` (deepseek-chat,
**default provider**), `grok` (grok-3, api.x.ai), `openrouter`, `anthropic` (claude-sonnet-4-5),
`gemini` (gemini-2.5-flash), `deepl` (api-free.deepl.com), `libretranslate`, `google` (free
experimental), `custom` (any /chat/completions endpoint, e.g. Ollama/LM Studio — empty baseUrl
must be filled by the user). **To add a provider:** add an entry to `PROVIDERS` (with `kind`) and,
if it's a new kind, an adapter in `providers.js` + dispatch case.

LLM adapters ask for a **JSON array of strings** (parse with `parseArrayResponse`, which falls back
to line splitting + length matching). DeepL/LibreTranslate/Google use their native APIs
(DeepL maps `en→EN-US`, `pt→PT-BR`; LibreTranslate maps `zh-TW→zt` with `zh` retry).

## 6. Decisions, history & current state

- Initial commit `f3ced30` (15 files); `b79236a` fixed the https-vs-http local install bug
  (pages were generating `https://` URLs — now protocol-aware, localhost shows copy button);
  `5e1dae1` added the per-source variant picker (v1.1.0).
- v1.1.1 fixed the OpenSubtitles search contract (`moviehash`/`moviebytesize` instead of
  `video_hash`; numeric `imdb_id`; series via `parent_imdb_id` + season/episode) and made search
  failures report the real error. The old parameters silently returned zero results, which is why
  valid keys still produced "no source subtitles found".
- v1.1.2 fixed OpenSubtitles authentication: `/login` needs `{username, password}` (the API key
  alone can't produce a token), search no longer logs in (Api-Key only), download logs in and
  retries once on 406 "No session", and 407 is correctly treated as the download-quota limit.
  Added `osUsername` / `osPassword` config fields.
- All tests pass: **56/56** (`npm test`). Nothing is currently broken or in progress.
- `.cache/` and `.cache-test/` are gitignored; caches are safe to delete. The test suite wipes
  `.cache-test` on every run so cache-hit assertions are deterministic.
- README.md documents usage, deployment (HTTPS required for public hosting; Render/Railway/BeamUp),
  privacy (API keys ride in the addon URL — same as every configured Stremio addon), troubleshooting.
- License: MIT (Nikos Kalaitzian, 2026).

### Open ideas (not requested yet — offer, don't start)
- Serve existing subtitles in the **target** language from OpenSubtitles as their own tracks (and/or
  skip AI translation when a human subtitle already exists). Discussed with the user; design not
  agreed.
- Filename (`query=`) search fallback for local files without an IMDb id.
- GitHub Actions CI running `npm test`; Dockerfile; addon logo/background images; config-screen
  screenshot in README; per-provider formality options; caching translated VTTs keyed by video
  hash; support for the user supplying their own subtitle URL as source.

## 7. If you change behavior

1. Update/add checks in `scripts/test.js` (mock upstreams make this cheap) and run `npm test`.
2. Bump `version` in **both** `src/server.js` (manifest) and `package.json`.
3. Update README.md (user-facing) and this file (architecture/protocol facts).
4. Commit to `main` and push (`gh` is authenticated; repo exists — do not recreate it).

## 8. Useful upstream references

- Subtitle addon protocol: https://github.com/Stremio/stremio-addons/blob/master/docs/api/subtitles/README.md
- stremio-addon-sdk (config/router reference): https://cdn.jsdelivr.net/npm/stremio-addon-sdk@1.6.10/docs/README.md
- stremio-core sources: `src/types/resource/subtitles.rs` (label field), `src/types/constants.rs`
  (videoHash/videoSize/filename extras), `src/addon_transport/http_transport/http_transport.rs`
  (URL building), `src/types/addon/addon_details.rs` (stremio://→https:// rewrite)
- stremio-web player UI: `src/routes/Player/SubtitlesMenu/*` (languages+variants panes, label rendering)
- OpenSubtitles API: https://opensubtitles.stoplight.io/docs/opensubtitles-api
