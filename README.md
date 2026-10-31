# AI Subtitle Translator — Stremio Addon

A Stremio addon that **translates subtitles to any language you pick**, using your choice of AI provider.
The provider, API key, target language and the translation prompt are all chosen on **Stremio's addon
configuration screen before the addon is installed**.

```
Stremio player ──▶ addon /subtitles/...json ──▶ OpenSubtitles (find source subs)
                        │                            │
                        │  returns tracks with       ▼
                        │  /subtitle.vtt?provider=.. AI provider translates
                        ▼                            (OpenAI / DeepSeek / Grok /
                     translated WebVTT ◀───────────  Anthropic / Gemini / DeepL ...)
```

## Features

- **Provider dropdown** — OpenAI, DeepSeek, Grok (xAI), OpenRouter, Anthropic Claude, Google Gemini,
  DeepL, LibreTranslate, Google Translate (free/experimental) and any **custom OpenAI-compatible**
  endpoint (Ollama, LM Studio, vLLM, ...).
- **API key field** for the chosen provider.
- **Target language dropdown** (40+ languages).
- **Prompt text area** — the translation prompt is fully editable and shown on the config screen.
- **Pick the source subtitle yourself** — every source subtitle found for the video shows up as a
  labeled track in the subtitle menu (e.g. *AI from English — Movie.2010.srt*, *AI from French*),
  so when one source is out of sync or badly transcribed you can translate a different one.
- Source subtitles come from **OpenSubtitles.com** (matched by video hash, so timing is exact).
- SRT → WebVTT conversion, chunked translation (context-friendly batches), **caching on disk and in
  memory** so re-watching an episode costs no extra API calls, retries with backoff on rate limits.
- Graceful in-player error messages when something is misconfigured.

## Requirements

- Node.js **18+** (tested with Node 26).
- A free **OpenSubtitles.com API key**
  ([opensubtitles.com/consumers](https://www.opensubtitles.com/en/consumers)) — one key covers both
  finding and downloading subtitles (no account username/password needed).
- An API key for the AI provider you pick (not needed for Google Translate, local Ollama/LM Studio,
  or a self-hosted LibreTranslate).

## Quick start

```bash
cd D:\Development\stremio-ai-subtitles   # wherever you keep the project
npm install
npm start
```

Then in Stremio:

1. Go to **Addons → Add addon** and paste `http://127.0.0.1:7000/manifest.json`
   (Stremio accepts plain HTTP only for `127.0.0.1`).
2. The **configuration screen** opens: pick the AI provider, paste its API key, choose the target
   language, adjust the prompt, and paste your OpenSubtitles API key.
3. Install, play any movie/episode and open the **subtitles menu** (speech-bubble icon in the player).
   Under your target language you'll see the addon's variants:
   - **AI translate (best match)** — automatically picks the best source subtitle,
   - **AI from English — filename**, **AI from French**, … — one variant per source subtitle found,
     labeled with the source file (`(HI)` = hearing impaired, `(MT)` = machine translated).
   Selecting a variant starts the translation of that source (first time only — afterwards it's
   cached). If a translation looks out of sync, pick a different source variant.

> Alternatively open `http://127.0.0.1:7000/configure` in a browser, fill the form there (the prompt
> field is a real text area) and click **Install in Stremio**.

## Configuration screen

| Field | Type | Description |
| --- | --- | --- |
| **AI provider** | dropdown | OpenAI, DeepSeek, Grok, OpenRouter, Anthropic, Gemini, DeepL, LibreTranslate, Google (free), Custom OpenAI-compatible |
| **Provider API key** | password | Key for the selected provider (leave empty for Google/local endpoints) |
| **Translate subtitles to** | dropdown | The target language (default: Greek) |
| **Translation prompt** | text area | Prompt sent to LLM providers; `{targetLang}` is replaced with the chosen language |
| **Source subtitle language** | dropdown | Which original subtitle to translate from (`auto` prefers English) |
| **Model name** | text | Overrides the provider's default model |
| **API base URL** | text | Overrides the provider's default endpoint (needed for custom/Ollama/LM Studio) |
| **OpenSubtitles.com API key** | password | Free key used to find & fetch the original subtitles |

Defaults per provider: OpenAI `gpt-4o-mini` · DeepSeek `deepseek-chat` · Grok `grok-3` ·
OpenRouter `openai/gpt-4o-mini` · Anthropic `claude-sonnet-4-5` · Gemini `gemini-2.5-flash` ·
DeepL free endpoint · LibreTranslate public instance · Google free endpoint.

You can **install the addon multiple times** (different languages or providers per install) — each
configured install is treated as its own addon.

## How the configuration reaches the addon

This follows the official Stremio addon protocol: the addon declares
`behaviorHints.configurationRequired: true` and a config schema (served on `/configure` and embedded
in `manifest.json`). Stremio renders the form, and the chosen values are appended to the addon URL as
an encoded JSON path segment — e.g. `http://127.0.0.1:7000/%7B%22provider%22%3A...%7D/manifest.json`.
The addon decodes that segment (JSON, base64-JSON or query params are all accepted) and embeds the
settings into every subtitle track URL it returns.

## Project layout

```
src/
  server.js         Express server: /manifest.json, /configure, /subtitles/*, /subtitle.vtt
  config.js         Languages, provider registry, config schema, configure HTML page
  providers.js      AI provider adapters (one translate() contract)
  opensubtitles.js  OpenSubtitles.com client (login, search by hash/IMDB, download, caching)
  subtitleFormat.js SRT/WebVTT parsing, sanitizing, VTT output
  translate.js      Chunked translation pipeline + memory/disk cache
scripts/
  test.js           End-to-end test (mock OpenSubtitles + mock LLM, no real keys needed)
```

Run the tests with `npm test` — it boots mock upstream services and checks the whole flow
(manifest → configure → subtitle list → translated VTT → cache hit → error tracks).

## Deploying publicly

Stremio requires **HTTPS** for any addon not on `127.0.0.1`. The app is stateless — there is no
database and no server-side account. Each user's settings (provider, keys, language, prompt) ride
in their **own** configured addon URL; the server only holds disposable caches in `.cache/`.

### Render (quickest — deploy straight from GitHub)

1. Push this repo to GitHub (it already lives at
   [github.com/nkalaitzian/stremio-ai-subtitles](https://github.com/nkalaitzian/stremio-ai-subtitles)).
2. In [Render](https://render.com): **New → Web Service**, connect the repo.
3. Set **Runtime: Node**, **Build Command: `npm install`**, **Start Command: `npm start`**.
   Render injects `PORT`; the server reads it. `HOST` already defaults to `0.0.0.0`.
4. Deploy, then open `https://<your-service>.onrender.com/configure`, fill in the form, and add the
   generated URL to Stremio. The bare manifest URL is
   `https://<your-service>.onrender.com/manifest.json`.

> Render's **free** tier spins the service down when idle; the first request afterwards can take
> 30–60 s and may time out in Stremio. For everyday use pick an always-on instance (or a VPS).

### VPS (always-on, full control)

```bash
git clone https://github.com/nkalaitzian/stremio-ai-subtitles
cd stremio-ai-subtitles
npm install
PORT=7000 HOST=0.0.0.0 node src/server.js   # run under systemd/pm2
```

Put Caddy in front for automatic HTTPS:

```caddyfile
addon.example.com {
    reverse_proxy 127.0.0.1:7000
}
```

Then install `https://addon.example.com/manifest.json`.

### BeamUp (Stremio's own addon PaaS)

BeamUp is the Stremio team's free addon host. Its old front-end domain (`beamup.dev`) is now parked,
but the service itself is still live: the deploy host is **`a.baby-beamup.club`** and the dashboard is
at [baby-beamup.club](https://baby-beamup.club). Add-ons are deployed over SSH with `beamup-cli`:

```bash
npm install -g beamup-cli
beamup config a.baby-beamup.club <your-github-username>   # SSH key must be on GitHub
cd stremio-ai-subtitles
beamup                                                    # asks for a project name, then deploys
# later updates:
git push beamup master
```

Your add-on will be at:

```
https://<hash>-<project-name>.baby-beamup.club/manifest.json
```

where `<hash>` is the first 12 hex chars of `sha256(githubUsername.toLowerCase() + "\n")`. For this
repository and GitHub user `nkalaitzian`, with the default project name `stremio-ai-subtitles`,
that is:

```
https://d0d76533837f-stremio-ai-subtitles.baby-beamup.club/manifest.json
```

BeamUp builds with the Herokuish Node buildpack (`package.json` → `npm install` → `npm start`), so
the add-on's `PORT` handling is what it needs. Caveats as of late 2026: BeamUp's buildpack pins Node
**22.11.0** (older than current security releases; newer major versions fail to resolve), and its
Dockerfile/Swarm path has open reliability issues. The Herokuish path used here is the supported one.

Railway and Fly.io work the same way — any host that runs `npm start` and gives you HTTPS. Fly.io
needs a Dockerfile; ask if you want one added to the repo.

### Public hosting notes

- **Never bake your own keys into a public instance.** Each visitor opens `/configure`, enters their
  own provider/OpenSubtitles keys, and installs their own URL. Nothing is shared or stored.
- Keep the `/configure` page public — it is the install page — but treat the generated addon URLs
  as secrets (they contain the user's keys).
- The addon URL must be reachable from the user's Stremio. A cold/offline server shows up as a
  failed or empty subtitle list.

## Privacy & security notes

- Like every configured Stremio addon, the values you enter (including API keys) are part of the
  addon URL that Stremio sends with its requests. Keep the addon **private** (don't share your
  addon URL) and don't host it for the public with your personal keys.
- Translation cache files live in `.cache/` and contain only subtitle text, not keys.
- Requests to AI providers go directly from **your server**; nothing is proxied through third parties.

## Troubleshooting

- **"Failed to get addon manifest from https://127.0.0.1..."** — the addon runs on plain HTTP, but
  Stremio was given an `https://` URL. Paste exactly `http://127.0.0.1:7000/manifest.json` (keep the
  `http://` prefix and the port) and make sure `npm start` is still running. Stremio only accepts
  plain HTTP for `127.0.0.1`; anything public must be HTTPS.
- **"No source subtitles found for this video"** — OpenSubtitles returned nothing for this file's
  video hash *and* its IMDb id (for episodes: the show id + season/episode). Try another
  release/stream, or set a specific source language.
- **"OpenSubtitles search failed … check your API key"** — the OpenSubtitles.com **API key** is
  wrong or has no access. A **wrong key** also shows as a search/download error, not "no subtitles".
- **Translation is out of sync or badly transcribed** — open the subtitle menu and pick a different
  source variant (*AI from …* tracks); each one is a different source subtitle file. If the config's
  **Source subtitle language** is set to a specific language, only variants of that language appear.
- **OpenSubtitles 407 / "daily download limit"** — the free account has a daily download quota;
  cached files are not re-downloaded, and re-watching something you translated before uses no quota.
- **Google Translate fails with 429** — the free endpoint is rate-limited; prefer a keyed provider.
- **Series** — Stremio sends the episode video id and hash, so per-episode subtitles are matched
  exactly like movies.
- **Empty track list** — the addon only answers requests that include a `videoHash` (torrent/local
  files provide it; some HTTP streams don't).
- Check the server console for per-request errors.

## License

MIT — use it, fork it, host it.

---

> 🤖 **For AI assistants:** start by reading [AGENTS.md](AGENTS.md) — it contains the full project
> context, architecture, protocol knowledge and current state needed to continue development.
