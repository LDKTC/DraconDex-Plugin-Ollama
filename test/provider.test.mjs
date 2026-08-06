// Drives src/provider.js in Node against canned NDJSON, exercising the line
// parser, the /api/chat object mapping and the result shape. Stubs only what a
// plugin page would really have: window, Store, and pluginApi.net.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const ROOT = new URL('..', import.meta.url).pathname;

// --- fake host -------------------------------------------------------------
const config = new Map();
let lastRequest = null;
let pageRequest = null;          // set when the page's own fetch() was used
let scriptedChunks = [];
let scriptedEnd = { ok: true };
let scriptedNetFetch = { ok: true, status: 200, body: '{}' };
let scriptedPageFetch = null;

function makeWindow() {
  const win = {};
  win.window = win;
  win.Store = {
    getConfig: async (k, fallback = null) => (config.has(k) ? config.get(k) : fallback),
    setConfig: async (k, v) => { config.set(k, v == null ? null : String(v)); },
  };
  win.pluginApi = {
    net: {
      fetch: async (url, init) => { lastRequest = { url, init }; return scriptedNetFetch; },
      stream: async (url, init, { onChunk, onEnd }) => {
        lastRequest = { url, init };
        // Deliver asynchronously, like the real IPC path does.
        setImmediate(() => {
          for (const c of scriptedChunks) onChunk(c);
          onEnd(scriptedEnd);
        });
        return () => {};
      },
    },
  };
  return win;
}

// A minimal Response, enough for httpFetch and streamViaFetch.
function fakeResponse(body, { ok = true, status = 200 } = {}) {
  const bytes = new TextEncoder().encode(body);
  let sent = false;
  return {
    ok, status, statusText: '',
    text: async () => body,
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true } : (sent = true, { done: false, value: bytes })),
      }),
    },
  };
}

// provider.js is a classic browser script: it reads bare `window` / `Store` and
// assigns window.Provider. Running it with those as function parameters is the
// whole shim — no bundler, no module wrapper, same file the app downloads.
function loadProvider(customise) {
  const win = makeWindow();
  customise?.(win);
  const src = readFileSync(`${ROOT}src/provider.js`, 'utf8');
  new Function('window', 'Store', 'fetch', src)(win, win.Store, async (url, init) => {
    pageRequest = { url, init };
    if (scriptedPageFetch) return scriptedPageFetch;
    throw new Error('the host net path should have been used');
  });
  return win.Provider;
}

// Ollama streams one bare JSON object per line. Split on awkward boundaries so
// the parser's partial-line buffer is actually exercised.
function ndjson(objects, { trailingNewline = true } = {}) {
  let text = objects.map((o) => JSON.stringify(o)).join('\n');
  if (trailingNewline) text += '\n';
  const cut = Math.floor(text.length / 3);
  return [text.slice(0, cut), text.slice(cut, cut * 2), text.slice(cut * 2)];
}

const delta = (content) => ({ model: 'llama3.2', message: { role: 'assistant', content }, done: false });
const thought = (thinking) => ({ model: 'llama3.2', message: { role: 'assistant', thinking }, done: false });
const finish = (extra = {}) => ({
  model: 'llama3.2', message: { role: 'assistant', content: '' }, done: true,
  done_reason: 'stop', prompt_eval_count: 11, eval_count: 4, ...extra,
});

function reset() {
  config.clear();
  lastRequest = null;
  pageRequest = null;
  scriptedChunks = [];
  scriptedEnd = { ok: true };
  scriptedNetFetch = { ok: true, status: 200, body: '{}' };
  scriptedPageFetch = null;
}

async function run(P, s, onDelta) {
  return P.sendMessage({ settings: s, messages: [{ role: 'user', content: 'hi' }], onDelta });
}

// --- settings and gating ---------------------------------------------------
test('defaults: loopback base url, no model means not connected', async () => {
  reset();
  const P = loadProvider();
  const s = await P.readSettings();
  assert.equal(s.baseUrl, 'http://localhost:11434');
  assert.equal(s.model, '');
  assert.equal(s.think, 'off');
  assert.deepEqual(P.connectionState(s), { ok: false, reason: 'no_model' });
  assert.match(P.describeGate('no_model'), /Settings/);
});

test('a pulled model is the only thing needed to be connected', async () => {
  reset();
  const P = loadProvider();
  config.set('model', 'llama3.2');
  const s = await P.readSettings();
  assert.deepEqual(P.connectionState(s), { ok: true });
});

test('a malformed base url is reported as such, not as a network failure', async () => {
  reset();
  const P = loadProvider();
  config.set('base_url', 'not a url');
  config.set('model', 'llama3.2');
  const s = await P.readSettings();
  assert.deepEqual(P.connectionState(s), { ok: false, reason: 'bad_base_url' });
});

// --- streaming -------------------------------------------------------------
test('streams text, thinking and token counts out of an NDJSON stream', async () => {
  reset();
  const P = loadProvider();
  config.set('model', 'deepseek-r1');
  config.set('think', 'on');
  const s = await P.readSettings();

  scriptedChunks = ndjson([
    thought('weigh'), thought(' options'),
    delta('Hello'), delta(', world'),
    finish(),
  ]);

  const seen = { text: '', thinking: '' };
  const res = await run(P, s, ({ text, thinking }) => {
    if (text) seen.text += text;
    if (thinking) seen.thinking += thinking;
  });

  assert.equal(res.ok, true);
  assert.equal(res.text, 'Hello, world');
  assert.equal(res.thinking, 'weigh options');
  assert.equal(res.inTokens, 11);
  assert.equal(res.outTokens, 4);
  assert.equal(seen.text, 'Hello, world');
  assert.equal(seen.thinking, 'weigh options');
});

test('a final object with no trailing newline is still flushed', async () => {
  reset();
  const P = loadProvider();
  config.set('model', 'llama3.2');
  const s = await P.readSettings();
  // The token counts live on the very last object — dropping it because the
  // server did not terminate the line would lose them silently.
  scriptedChunks = ndjson([delta('hi'), finish()], { trailingNewline: false });

  const res = await run(P, s);
  assert.equal(res.ok, true);
  assert.equal(res.text, 'hi');
  assert.equal(res.outTokens, 4);
});

test('request shape: stream, system message, think and options', async () => {
  reset();
  const P = loadProvider();
  config.set('model', 'gpt-oss');
  config.set('system_prompt', 'be brief');
  config.set('think', 'high');
  config.set('temperature', '0.2');
  config.set('num_ctx', '8192');
  config.set('num_predict', '512');
  const s = await P.readSettings();
  scriptedChunks = ndjson([delta('ok'), finish()]);

  await run(P, s);
  assert.equal(lastRequest.url, 'http://localhost:11434/api/chat');
  const body = JSON.parse(lastRequest.init.body);
  assert.equal(body.model, 'gpt-oss');
  assert.equal(body.stream, true);
  assert.equal(body.think, 'high');
  assert.deepEqual(body.options, { temperature: 0.2, num_ctx: 8192, num_predict: 512 });
  // The system prompt is a message, not a field — /api/chat has no `system`.
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
  ]);
});

test('think:on sends the portable boolean, think:off sends nothing at all', async () => {
  reset();
  const P = loadProvider();
  config.set('model', 'qwen3');
  config.set('think', 'on');
  scriptedChunks = ndjson([delta('ok'), finish()]);
  await run(P, await P.readSettings());
  assert.equal(JSON.parse(lastRequest.init.body).think, true);

  config.set('think', 'off');
  scriptedChunks = ndjson([delta('ok'), finish()]);
  await run(P, await P.readSettings());
  const body = JSON.parse(lastRequest.init.body);
  assert.equal('think' in body, false);
  // Unset tuning fields must not appear either, or they would override the
  // model's own defaults with this plugin's guesses.
  assert.equal('options' in body, false);
});

// --- failures --------------------------------------------------------------
test('asking a non-thinking model to think names the setting to change', async () => {
  reset();
  const P = loadProvider();
  config.set('model', 'llama3.2');
  config.set('think', 'on');
  scriptedEnd = { ok: false, code: 'http', status: 400, error: '{"error":"llama3.2 does not support thinking"}' };

  const res = await run(P, await P.readSettings());
  assert.equal(res.ok, false);
  assert.match(res.error, /llama3\.2 has no thinking mode/);
  assert.match(res.error, /Thinking to Off/);
});

test('a model that was never pulled gets the pull command', async () => {
  reset();
  const P = loadProvider();
  config.set('model', 'mistral');
  scriptedEnd = {
    ok: false, code: 'http', status: 404,
    error: '{"error":"model \'mistral\' not found, try pulling it first"}',
  };

  const res = await run(P, await P.readSettings());
  assert.equal(res.ok, false);
  assert.match(res.error, /ollama pull mistral/);
});

test('an error object inside a 200 stream is decoded, keeping partial text', async () => {
  reset();
  const P = loadProvider();
  config.set('model', 'llama3.2');
  scriptedChunks = ndjson([delta('half an ans'), { error: 'context canceled' }]);

  const res = await run(P, await P.readSettings());
  assert.equal(res.ok, false);
  assert.equal(res.text, 'half an ans');
  assert.match(res.error, /context canceled/);
});

test('an unreachable server says how to start it', async () => {
  reset();
  const P = loadProvider();
  config.set('model', 'llama3.2');
  scriptedEnd = { ok: false, code: 'network', error: 'ECONNREFUSED' };

  const res = await run(P, await P.readSettings());
  assert.equal(res.ok, false);
  assert.match(res.error, /ollama serve/);
});

test('abort reports as stopped, not as an error', async () => {
  reset();
  const P = loadProvider();
  config.set('model', 'llama3.2');
  scriptedChunks = ndjson([delta('partial')]);
  scriptedEnd = { ok: false, code: 'aborted' };

  const res = await run(P, await P.readSettings());
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Stopped.');
  assert.equal(res.text, 'partial');
});

test('hitting the token limit keeps the text and says which setting caused it', async () => {
  reset();
  const P = loadProvider();
  config.set('model', 'llama3.2');
  scriptedChunks = ndjson([delta('cut off here'), finish({ done_reason: 'length' })]);

  const res = await run(P, await P.readSettings());
  assert.equal(res.ok, false);
  assert.equal(res.text, 'cut off here');
  assert.match(res.error, /max tokens/i);
});

// --- model list and reachability -------------------------------------------
test('fetchModels reads /api/tags and sorts the names', async () => {
  reset();
  const P = loadProvider();
  scriptedNetFetch = {
    ok: true, status: 200,
    body: JSON.stringify({ models: [{ name: 'qwen3:latest' }, { name: 'llama3.2:1b' }] }),
  };
  const models = await P.fetchModels(await P.readSettings());
  assert.equal(lastRequest.url, 'http://localhost:11434/api/tags');
  assert.deepEqual(models, ['llama3.2:1b', 'qwen3:latest']);
});

test('an Ollama with nothing pulled says to pull something', async () => {
  reset();
  const P = loadProvider();
  scriptedNetFetch = { ok: true, status: 200, body: JSON.stringify({ models: [] }) };
  const s = await P.readSettings();
  await assert.rejects(() => P.fetchModels(s), /ollama pull/);
});

test('fetchModels surfaces an HTTP failure', async () => {
  reset();
  const P = loadProvider();
  scriptedNetFetch = { ok: true, status: 500, body: '{"error":"internal"}' };
  const s = await P.readSettings();
  await assert.rejects(() => P.fetchModels(s), /Ollama server error \(500\)/);
});

test('testConnection returns the server version', async () => {
  reset();
  const P = loadProvider();
  scriptedNetFetch = { ok: true, status: 200, body: JSON.stringify({ version: '0.12.3' }) };
  const version = await P.testConnection(await P.readSettings());
  assert.equal(lastRequest.url, 'http://localhost:11434/api/version');
  assert.equal(version, '0.12.3');
});

// --- transport selection ---------------------------------------------------
test('a declared origin goes through the host, an undeclared one through the page', async () => {
  reset();
  const P = loadProvider();
  assert.equal(P.usesPageFetch('http://localhost:11434/api/chat'), false);
  assert.equal(P.usesPageFetch('http://127.0.0.1:11434/api/chat'), false);
  // A custom port is a different origin, so the manifest does not cover it.
  assert.equal(P.usesPageFetch('http://localhost:9999/api/chat'), true);
  assert.equal(P.usesPageFetch('http://ollama.example.com/api/chat'), true);
});

test('an undeclared origin falls back to the page instead of refusing', async () => {
  reset();
  const P = loadProvider();
  config.set('base_url', 'http://localhost:9999');
  config.set('model', 'llama3.2');
  const s = await P.readSettings();
  scriptedPageFetch = fakeResponse(
    `${JSON.stringify(delta('via page'))}\n${JSON.stringify(finish())}\n`,
  );

  const res = await run(P, s);
  // The host was never asked — the request went out from the page.
  assert.equal(lastRequest, null);
  assert.equal(pageRequest.url, 'http://localhost:9999/api/chat');
  assert.equal(res.ok, true);
  assert.equal(res.text, 'via page');
});

test('a page-fetch failure explains that CORS may be the real cause', async () => {
  reset();
  const P = loadProvider();
  config.set('base_url', 'http://localhost:9999');
  config.set('model', 'llama3.2');
  const s = await P.readSettings();
  scriptedPageFetch = null;      // the injected fetch throws

  const res = await run(P, s);
  assert.equal(res.ok, false);
  assert.match(res.error, /CORS/);
  assert.match(res.error, /ollama serve/);
});
