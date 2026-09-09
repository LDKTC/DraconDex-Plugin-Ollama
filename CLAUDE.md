# DraconDex-PGI-Ollama

A chat plugin for [DraconDex](https://github.com/ZYDRAXYL/DraconDex-APP) that
talks to a **local Ollama server**, docked in place of the Module Inspector or
run as a standalone window. Sibling of
[DraconDex-PGI-Claude](https://github.com/ZYDRAXYL/DraconDex-PGI-Claude) and
[DraconDex-PGI-Codex](https://github.com/ZYDRAXYL/DraconDex-PGI-Codex), same
shape — but needs no account, no API key, and no internet access.

Full background (the loopback `http://` origin exception, thinking-model
support, data-handling, the manifest) is in [README.md](README.md) — read
that first for anything not covered below.

## Architecture

Two HTML entries share the same five `src/` modules and differ only in
chrome:

| File | Purpose |
| --- | --- |
| `dracondex-plugin.json` | Manifest: id `ollama_chat`, panel, net origins, table schema. |
| `index.html` + `app.js` | Standalone-window entry (draws its own frameless title bar). |
| `panel.html` + `panel.js` | Docked-panel entry; asks the host for module context. |
| `src/provider.js` | Ollama transport: `/api/chat` NDJSON streaming, `/api/tags`, `/api/version`, error decoding. |
| `src/catalog.js` | Fetches/caches AI Native's `catalog.json`; composes the app-context preamble onto the system prompt. Independent of `provider.js` — different origin, own `pluginApi.net` call. |
| `src/store.js` | The three tables, via `window.pluginApi.table.*`. |
| `src/chat.js` | Session/transcript controller — no DOM. |
| `src/ui.js` | Rendering: chat, history, settings. |
| `test/provider.test.mjs` | Drives `provider.js` against canned NDJSON. |
| `test/catalog.test.mjs` | Drives `catalog.js` against a fake `pluginApi.net`/`Store`/page `fetch`. |

Only paths listed in the manifest's `files` are downloaded on install —
README, scripts, and tests cost an installing user nothing.

## Hard constraints — read before editing panel/state code

- **A docked panel is reloaded whenever DraconDex re-renders its pane** —
  editing a tag on the module is enough to trigger it, and an in-flight
  stream dies with it. Nothing may live only in a JS variable: the user's
  message is persisted *before* the request goes out, every reply is written
  as soon as the stream ends, and the panel rebuilds itself from the tables
  on every load.
- **The manifest `id` (`ollama_chat`) is load-bearing** — it's baked into the
  real SQLite table names (`plg_ollama_chat_session` etc.). Don't change it.
- **Requests to the two declared origins
  (`http://localhost:11434`, `http://127.0.0.1:11434`) go through
  `pluginApi.net.*`**, which runs in the main process and sends no `Origin`
  header — Ollama's CORS check never engages there, no `OLLAMA_ORIGINS`
  needed. Any *other* Ollama URL (different port, remote host) falls back to
  the plugin page's own `fetch()`, which sends the literal `null` origin and
  requires the user to set `OLLAMA_ORIGINS` on their server. Don't conflate
  these two paths when touching `provider.js`.
- **This plugin never pulls models.** `ollama pull` stays something the user
  runs themselves — don't add code that triggers a download.
- **`src/catalog.js` is independent of `src/provider.js`** — its failure must
  never break chat: if the AI Native fetch fails or is unavailable, chat
  still works, just without the app-context preamble.
- A model with no thinking mode should error rather than silently ignore the
  Thinking setting — that's why the plugin's default is `Off`.
- Treat all rendered content as data: build DOM nodes / use `textContent` in
  `src/ui.js`, never `innerHTML`.

## Commands

```sh
node scripts/validate-manifest.mjs     # same rules the app enforces on install
for f in app.js panel.js src/*.js; do node --check "$f"; done
node --test test/*.test.mjs
```

CI (`.github/workflows/validate.yml`) runs the same commands on every
push/PR. No dependencies to install, no build step — the app downloads these
files as-is.

## Developing / testing locally

`ollama serve` (usually already running) + `ollama pull <model>` first. Then
in DraconDex: **Settings → Plugin → Plugins**, paste this repo's link, confirm
the preview. Reinstalling after a change means uninstalling first (the same
`id` can't install twice) — and **uninstalling permanently deletes this
plugin's conversations**, so don't develop against a vault you care about.
