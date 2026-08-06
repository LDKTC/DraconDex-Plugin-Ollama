'use strict';
// The connection layer: one local Ollama server, no credentials.
//
// This talks to Ollama's native HTTP API over raw fetch rather than through the
// official SDK, because a plugin page has no bundler and no node_modules —
// there is nowhere for a dependency to come from. Everything below follows the
// documented wire format for POST /api/chat, GET /api/tags and GET /api/version.
//
// Three things make this different from the Claude and Codex siblings:
//
//   1. There is no API key and no OAuth. "Connected" means a reachable server
//      and a model that has already been pulled — nothing to authenticate.
//   2. The stream is NDJSON, not SSE: one bare JSON object per line, no
//      `data:` prefix and no [DONE] sentinel. The last object carries the
//      token counts.
//   3. The endpoint is plaintext loopback. DraconDex only allows that for
//      `http://` on localhost/127.0.0.1 WITH an explicit port (see
//      normalizeNetOrigin in the app's src/db/plugin-manifest.js), which is
//      why this plugin needs DraconDex 4.4.0+.
//
// See README.md §Connecting for what happens when the user points this at an
// Ollama that is neither of the two declared origins.

// Must stay in sync with permissions.net in dracondex-plugin.json. The host
// refuses anything else, so knowing the list here lets the plugin fall back to
// its own fetch() deliberately instead of eating an opaque rejection from the
// main process.
const ALLOWED_ORIGINS = ['http://localhost:11434', 'http://127.0.0.1:11434'];

const BASE_DEFAULT = 'http://localhost:11434';

// Suggestions only — NOT a closed list. Which models exist is entirely a
// property of the user's machine (whatever they have `ollama pull`ed), so the
// setting is a free-text field with these as autocomplete and a "Fetch models"
// button that replaces them with what is actually installed.
const MODEL_SUGGESTIONS = [
  'llama3.2',
  'llama3.1',
  'qwen3',
  'gemma3',
  'mistral',
  'deepseek-r1',
  'gpt-oss',
];

// Ollama's `think` parameter. `true`/`false` is the portable form every
// thinking-capable model understands; the named levels are newer and currently
// only meaningful to some models (gpt-oss in particular). Default is 'off' so
// no first-run request can 400 against a model with no thinking mode.
const THINK_MODES = ['off', 'on', 'low', 'medium', 'high'];
const DEFAULT_THINK = 'off';

// ---------------------------------------------------------------------------
// Transport. The host's pluginApi.net.* runs the request in the main process,
// which is what makes a cross-origin response readable at all — and, for
// Ollama specifically, it strips the Origin header, so Ollama's CORS check
// never engages and the user needs no OLLAMA_ORIGINS setup.
//
// The page's own fetch() is the fallback, used in two situations: a host with
// no pluginApi.net (running this as a plain window on an older DraconDex), and
// a base URL outside the two declared origins. That path IS subject to CORS,
// and the page's origin is `null` because it was loaded from file:// — which
// Ollama's default allowlist does not include. Hence the notice in Settings.
// ---------------------------------------------------------------------------
const hostNet = () => (window.pluginApi || window.extApi || {}).net || null;
const hasHostNet = () => !!hostNet();

function originOf(url) {
  try { return new URL(String(url)).origin; } catch (_) { return null; }
}

function originAllowed(url) {
  const origin = originOf(url);
  return !!origin && ALLOWED_ORIGINS.includes(origin);
}

// The host can only be used for origins the manifest declared. Anywhere else
// falls back to the page rather than failing, so a custom port or a remote
// Ollama still works for a user willing to set OLLAMA_ORIGINS.
function netFor(url) {
  const net = hostNet();
  return net && originAllowed(url) ? net : null;
}

// True when a request to this URL will go out through the page and therefore
// be CORS-gated. Settings shows a notice when it is.
function usesPageFetch(url) {
  return !netFor(url);
}

async function httpFetch(url, init) {
  const net = netFor(url);
  if (net) return net.fetch(url, init);
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    return { ok: false, code: 'network', error: String(e?.message || e) };
  }
  return { ok: true, status: res.status, statusText: res.statusText, body: await res.text() };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
async function readSettings() {
  const [baseUrl, model, systemPrompt, think, temperature, numCtx, numPredict] = await Promise.all([
    Store.getConfig('base_url', ''),
    Store.getConfig('model', ''),
    Store.getConfig('system_prompt', ''),
    Store.getConfig('think', DEFAULT_THINK),
    Store.getConfig('temperature', ''),
    Store.getConfig('num_ctx', ''),
    Store.getConfig('num_predict', ''),
  ]);
  return {
    baseUrl: (baseUrl || '').trim().replace(/\/+$/, '') || BASE_DEFAULT,
    baseUrlOverridden: !!baseUrl,
    // No default model: which ones exist depends entirely on what the user has
    // pulled, so guessing one would just produce a confident 404 on first send.
    model: (model || '').trim(),
    systemPrompt: systemPrompt || '',
    think: THINK_MODES.includes(think) ? think : DEFAULT_THINK,
    // Left as strings in the table; '' means "don't send it at all" so Ollama
    // and the modelfile keep their own defaults.
    temperature: numOrNull(temperature),
    numCtx: numOrNull(numCtx),
    numPredict: numOrNull(numPredict),
  };
}

function numOrNull(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function connectionState(s) {
  if (!originOf(s.baseUrl)) return { ok: false, reason: 'bad_base_url' };
  if (!s.model) return { ok: false, reason: 'no_model' };
  return { ok: true };
}

function describeGate(reason) {
  if (reason === 'bad_base_url') return 'The server URL in Settings is not a valid URL.';
  if (reason === 'no_model') return 'No model chosen — open Settings, fetch the model list and pick one.';
  return 'Not connected.';
}

// ---------------------------------------------------------------------------
// POST /api/chat
// ---------------------------------------------------------------------------
function buildRequestBody(s, messages) {
  // Ollama has no separate "system" field on /api/chat — the system prompt is
  // just the first message in the list.
  const withSystem = s.systemPrompt
    ? [{ role: 'system', content: s.systemPrompt }, ...messages]
    : messages;

  const body = { model: s.model, messages: withSystem, stream: true };

  // Only sent when asked for: a model with no thinking mode answers 400 to a
  // `think` it does not understand, so an unconditional `think:false` would be
  // a needless failure on older servers.
  if (s.think !== 'off') body.think = s.think === 'on' ? true : s.think;

  const options = {};
  if (s.temperature != null) options.temperature = s.temperature;
  if (s.numCtx != null) options.num_ctx = s.numCtx;
  if (s.numPredict != null) options.num_predict = s.numPredict;
  if (Object.keys(options).length) body.options = options;

  return body;
}

// One decoded NDJSON object. Returns what the caller should do with it.
function applyStreamObject(obj, acc) {
  // Ollama can report a failure as a JSON line inside an otherwise-200 stream,
  // not only as an HTTP status.
  if (obj.error) {
    acc.error = typeof obj.error === 'string' ? obj.error : (obj.error?.message || 'stream error');
    return null;
  }
  if (obj.done) {
    readUsage(obj, acc);
    // done_reason 'length' means num_predict cut the reply off mid-sentence.
    if (obj.done_reason && obj.done_reason !== 'stop') acc.doneReason = obj.done_reason;
    return null;
  }
  const msg = obj.message;
  if (!msg) return null;
  const out = {};
  if (msg.content) out.text = msg.content;
  if (msg.thinking) out.thinking = msg.thinking;
  return (out.text != null || out.thinking != null) ? out : null;
}

function readUsage(obj, acc) {
  if (obj.prompt_eval_count != null) acc.inTokens = obj.prompt_eval_count;
  if (obj.eval_count != null) acc.outTokens = obj.eval_count;
}

// Feeds raw NDJSON bytes in and calls back with each decoded object. Chunks
// arrive on arbitrary boundaries, so a partial line is held over to the next
// chunk. `flush()` must be called once the stream ends: Ollama does terminate
// every line, but a final object arriving without its newline would otherwise
// be silently dropped along with the token counts it carries.
function makeNdjsonParser(onObject) {
  let buffer = '';
  const take = (line) => {
    const s = line.trim();
    if (!s) return;
    try { onObject(JSON.parse(s)); } catch (_) { /* a truncated or non-JSON line */ }
  };
  const feed = (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();          // last element is the incomplete tail
    for (const line of lines) take(line);
  };
  feed.flush = () => {
    const tail = buffer;
    buffer = '';
    take(tail);
  };
  return feed;
}

// Streams one assistant turn. `onDelta` is called with { text } / { thinking }
// as they arrive; resolves with the finished turn. Never throws for a server
// error — those come back on the result so the caller can persist them next to
// the message they belong to.
async function sendMessage({ settings, messages, onDelta, onAbortReady }) {
  const s = settings;
  const gate = connectionState(s);
  if (!gate.ok) return { ok: false, error: describeGate(gate.reason) };

  const url = `${s.baseUrl}/api/chat`;
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildRequestBody(s, messages)),
  };

  const acc = { doneReason: null, inTokens: null, outTokens: null, error: null };
  let text = '';
  let thinking = '';

  const feed = makeNdjsonParser((obj) => {
    const delta = applyStreamObject(obj, acc);
    if (!delta) return;
    if (delta.text != null) { text += delta.text; onDelta?.({ text: delta.text, full: text }); }
    if (delta.thinking != null) { thinking += delta.thinking; onDelta?.({ thinking: delta.thinking }); }
  });

  const net = netFor(url);
  const end = net
    ? await streamViaHost(net, url, init, feed, onAbortReady, s)
    : await streamViaFetch(url, init, feed, onAbortReady, s);

  if (!end.ok) return { ok: false, error: end.error, text, thinking };
  if (acc.error) return { ok: false, error: describeServerError(acc.error, s), text, thinking };
  if (acc.doneReason === 'length') {
    return { ok: false, error: 'Cut off — the reply hit the max tokens limit. Raise it in Settings.', text, thinking };
  }
  return { ok: true, text, thinking, inTokens: acc.inTokens, outTokens: acc.outTokens };
}

function streamViaHost(net, url, init, feed, onAbortReady, s) {
  return new Promise((resolve) => {
    net.stream(url, init, {
      onChunk: feed,
      onEnd: (res) => {
        feed.flush();
        resolve(res.ok ? { ok: true } : { ok: false, ...toEndError(res, s) });
      },
    })
      .then((abort) => onAbortReady?.(abort))
      .catch((e) => resolve({ ok: false, error: String(e?.message || e) }));
  });
}

function toEndError(res, s) {
  if (res.code === 'aborted') return { error: 'Stopped.' };
  if (res.code === 'http') return { error: describeHttp(res.status, res.error, s) };
  return { error: describeNetwork(res.error, s) };
}

// Fallback for a host without pluginApi.net, or a base URL the manifest does
// not declare — subject to CORS either way.
async function streamViaFetch(url, init, feed, onAbortReady, s) {
  const ctrl = new AbortController();
  onAbortReady?.(() => ctrl.abort());
  let res;
  try {
    res = await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (ctrl.signal.aborted) return { ok: false, error: 'Stopped.' };
    return { ok: false, error: describeNetwork(String(e?.message || e), s) };
  }
  if (!res.ok) return { ok: false, error: describeHttp(res.status, await res.text(), s) };
  const reader = res.body?.getReader();
  if (!reader) return { ok: false, error: 'No response body.' };
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      feed(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    if (ctrl.signal.aborted) return { ok: false, error: 'Stopped.' };
    return { ok: false, error: describeNetwork(String(e?.message || e), s) };
  } finally {
    feed.flush();
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Model list and reachability. Both exist because the two things that go wrong
// on a local setup — the server is not running, and the model was never pulled
// — are one button away from being diagnosed rather than a dead end.
// ---------------------------------------------------------------------------
async function fetchModels(s) {
  const url = `${s.baseUrl}/api/tags`;
  const res = await httpFetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(describeNetwork(res.error, s));
  if (res.status < 200 || res.status >= 300) throw new Error(describeHttp(res.status, res.body, s));
  let json;
  try { json = JSON.parse(res.body); } catch (_) { throw new Error('The model list was not JSON — is that URL really an Ollama server?'); }
  const names = (json?.models || []).map((m) => m?.name).filter((n) => typeof n === 'string');
  if (!names.length) throw new Error('This Ollama has no models yet — pull one first, e.g. `ollama pull llama3.2`.');
  return names.sort();
}

async function testConnection(s) {
  const url = `${s.baseUrl}/api/version`;
  const res = await httpFetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(describeNetwork(res.error, s));
  if (res.status < 200 || res.status >= 300) throw new Error(describeHttp(res.status, res.body, s));
  let json;
  try { json = JSON.parse(res.body); } catch (_) { throw new Error('That URL answered, but not like an Ollama server.'); }
  return String(json?.version || 'unknown');
}

// ---------------------------------------------------------------------------
// Error messages. A local server fails in a small number of very specific
// ways, and every one of them has a concrete fix — so say the fix.
// ---------------------------------------------------------------------------

// Ollama's error body is `{"error": "some sentence"}` — a plain string, unlike
// the nested `.error.message` the OpenAI and Anthropic siblings decode.
function errorTextOf(body) {
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.error === 'string') return parsed.error;
    if (typeof parsed?.error?.message === 'string') return parsed.error.message;
  } catch (_) { /* not JSON — fall through */ }
  return String(body || '').slice(0, 300);
}

function describeHttp(status, body, s) {
  return describeServerError(errorTextOf(body), s, status);
}

function describeServerError(detail, s, status) {
  const d = String(detail || '');
  // Asked a model to think when it has no thinking mode. The fix is a setting,
  // not a retry, so name it rather than surfacing a bare 400.
  if (/does not support thinking|thinking is not supported/i.test(d)) {
    return `${s?.model || 'This model'} has no thinking mode — set Thinking to Off in Settings.`;
  }
  // The single most common first-run failure: the model was never pulled.
  if (/not found, try pulling it/i.test(d) || (status === 404 && /model/i.test(d))) {
    return `${d} Run \`ollama pull ${s?.model || '<model>'}\` first, or pick another model in Settings.`;
  }
  if (status === 404) return `Not found (404). ${d || 'Check the server URL in Settings.'}`;
  if (status >= 500) return `Ollama server error (${status}). ${d || 'Check the terminal running `ollama serve`.'}`;
  if (status) return `HTTP ${status}. ${d}`;
  return d || 'The request failed.';
}

// A connection that never landed. On the page-fetch path this is also what CORS
// looks like from the inside — the browser reports an opaque network failure —
// so both possibilities get named.
function describeNetwork(detail, s) {
  const base = s?.baseUrl || BASE_DEFAULT;
  const where = `Cannot reach Ollama at ${base} — is \`ollama serve\` running?`;
  if (s && usesPageFetch(`${base}/`)) {
    return `${where} If it is, this request went out through the page because ${originOf(base) || base} is not one of the origins this plugin declared, so CORS may have blocked it — see the note in Settings.`;
  }
  return detail ? `${where} (${detail})` : where;
}

window.Provider = {
  MODEL_SUGGESTIONS, THINK_MODES, DEFAULT_THINK, BASE_DEFAULT, ALLOWED_ORIGINS,
  readSettings, connectionState, describeGate,
  sendMessage, fetchModels, testConnection,
  hasHostNet, usesPageFetch, originAllowed,
};
