# DraconDex-Plugin-Ollama

A chat plugin for [DraconDex](https://github.com/LDKTC/App-DraconDex) that talks
to a **local [Ollama](https://ollama.com) server**. It docks into the Module
Inspector slot as a session panel, so you can ask a local model about the module
you're looking at without leaving the builder — or launch it as its own window.

Sibling of [DraconDex-Plugin-Claude](https://github.com/LDKTC/DraconDex-Plugin-Claude)
and [DraconDex-Plugin-Codex](https://github.com/LDKTC/DraconDex-Plugin-Codex),
built on the same shape. Unlike those two it needs no account, no API key and no
network — everything runs on your machine.

> **Requires DraconDex 4.4.0+.** Earlier versions only accepted `https://`
> origins in `permissions.net` and will refuse this manifest outright with
> `invalid net origin`. See [Connecting](#connecting) for why.

## Install

1. `ollama serve` (it usually runs already after install), then pull a model:
   `ollama pull llama3.2`.
2. In DraconDex: **Settings → Plugin → Plugins**, paste
   `https://github.com/LDKTC/DraconDex-Plugin-Ollama`, confirm the preview.
   The preview will list the two loopback origins below — that is the network
   access it is asking for.
3. Open a module. A **🦙** button appears next to the Module Inspector toggle.
4. First run lands on **Settings**: press **Fetch models**, pick one, and start
   chatting.

## Connecting

Ollama listens on `http://localhost:11434` — plaintext, on loopback. DraconDex
normally only lets a plugin declare `https://` origins, because a plaintext
origin is a downgrade you can't see. Loopback is the one honest exception: the
bytes never leave the machine, so there is no transport to downgrade. DraconDex
4.4.0 allows `http://` there **when the origin names an explicit port**, so a
grant covers one named local service rather than everything bound to loopback.

This plugin declares exactly two:

```json
"net": ["http://localhost:11434", "http://127.0.0.1:11434"]
```

Requests to either go out through `pluginApi.net.*`, which runs them in the
**main process**. That matters for more than permissions: the main process
sends no `Origin` header, so Ollama's CORS check never engages and you do not
have to configure `OLLAMA_ORIGINS` at all.

**Pointing at anything else** — a different port, another machine, a reverse
proxy — is still possible, but those requests fall back to the plugin page's own
`fetch()` and the browser applies CORS. The page is loaded from a file, so the
origin it sends is the literal `null`, which Ollama's default allowlist does not
include. Start Ollama with `OLLAMA_ORIGINS` set to include `null` (or `*`) if
you want that. Settings says so in place when your server URL is one of these.

## What it can do

- **Streaming replies** from `/api/chat`, token by token.
- **Thinking models.** Set **Thinking** to `On` for `deepseek-r1`, `qwen3`,
  `gpt-oss` and friends; the reasoning arrives on its own channel and renders in
  a collapsible block above the answer. The named levels (`low`/`medium`/`high`)
  are understood by fewer models than plain `On`. A model with no thinking mode
  answers with an error rather than ignoring the setting, which is why the
  default is **Off**.
- **Model picker** backed by `/api/tags`, so the list is what you have actually
  pulled — not a list this plugin guessed. **Test** hits `/api/version` to tell
  "server is down" apart from "model isn't pulled".
- **Conversations** persisted per module. Opening the panel on a module returns
  to that module's conversation.
- **Generation settings** — max tokens (`num_predict`), temperature and context
  size (`num_ctx`). All blank by default, so Ollama and the model's own
  Modelfile keep their defaults unless you say otherwise.
- Token counts per reply, from `prompt_eval_count` / `eval_count`.

It does **not** pull models for you. `ollama pull` stays a thing you run
yourself — an install that can download several GB in the background because a
dropdown changed is not a good surprise.

## Where your data goes

Nowhere. The conversation goes to your Ollama server and back; there is no
account, no key and no third party. Prompts and replies are stored in this
plugin's own SQLite tables inside DraconDex (`plg_ollama_chat_session`,
`plg_ollama_chat_message`, `plg_ollama_chat_config`) — readable by this plugin
and nothing else, and deleted with it when you uninstall.

Being plain about the limits, the same way the app's own
[`docs/PLUGINS.md`](https://github.com/LDKTC/App-DraconDex/blob/main/docs/PLUGINS.md) is:
the rows are not encrypted, and a net grant lets this plugin reach the declared
origins and read what comes back. That's a real capability, which is why the
install preview shows it before you confirm.

## The manifest

```json
{
  "id": "ollama_chat",
  "entry": "index.html",
  "panels": [{ "id": "chat", "title": "Ollama", "icon": "🦙", "entry": "panel.html" }],
  "permissions": {
    "net": ["http://localhost:11434", "http://127.0.0.1:11434"],
    "context": ["module"]
  }
}
```

`permissions.context: ["module"]` is what lets the panel ask the host which
module is open. The host answers `null` if it wasn't granted, and the plugin
works either way.

## Structure

| File | Purpose |
| --- | --- |
| `dracondex-plugin.json` | Manifest: id, panel, net origins, table schema. |
| `index.html` / `app.js` | Standalone-window entry. Draws its own title bar — plugin windows are frameless. |
| `panel.html` / `panel.js` | Docked session-panel entry. No title bar (the host draws it); asks the host for module context. |
| `src/provider.js` | Ollama transport: `/api/chat` NDJSON streaming, `/api/tags`, `/api/version`, error decoding. |
| `src/store.js` | The three tables, via `window.pluginApi.table.*`. |
| `src/chat.js` | Session/transcript controller. No DOM. |
| `src/ui.js` | Rendering: chat, history, settings. |
| `style.css` | Both entries. Written for the 290px panel, relaxed for the window. |
| `scripts/validate-manifest.mjs` | Local manifest check. Not shipped — not in `files`. |
| `test/provider.test.mjs` | Drives `provider.js` against canned NDJSON. Not shipped. |

Only paths listed in `files` are ever downloaded, so the README, scripts, tests
and CI cost an installing user nothing.

### A constraint worth knowing before you edit this

**The panel is reloaded whenever the main window re-renders** — editing a tag is
enough — and an in-flight stream dies with it. That is why every piece of state
round-trips through the plugin's own tables, and why the user's message is
persisted *before* the request goes out. Don't move state into a module-level
variable and expect it to survive.

The panel button also only appears while a module is open, only one panel shows
at a time, and switching modules closes it.

## Developing

```sh
node scripts/validate-manifest.mjs     # the rules the app enforces on install
for f in app.js panel.js src/*.js; do node --check "$f"; done
node --test test/*.test.mjs
```

No dependencies and no build step — the app downloads these files as they are.
CI runs the same three commands.

Reinstalling after a change means **uninstall first** (the same `id` can't
install twice), and uninstalling **permanently deletes this plugin's tables** —
so don't develop against conversations you want to keep.

## License

MIT, see [LICENSE](LICENSE).
