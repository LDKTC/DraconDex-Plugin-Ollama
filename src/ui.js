'use strict';
// Rendering. The whole page is one of three views (chat / sessions / settings)
// drawn into #root, plus renderStream() which patches only the streaming
// bubble — redrawing everything on every token would reset the scroll position
// and lose the composer's focus.
//
// Nothing stored is ever interpolated into an HTML string. Message bodies come
// from the model and from the user, so they are built with textContent and the
// tiny inline-markdown pass below works on DOM nodes, not markup.

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const root = () => document.getElementById('root');

// Replaced by the "Fetch models" button with what this server has actually
// pulled. Lives here rather than in Chat because it is a transient UI aid, not
// something worth a row in the config table.
let modelOptions = null;

// --- message body ----------------------------------------------------------
// A deliberately small subset: fenced code blocks and `inline code`. Both are
// created as elements with textContent, so a reply containing markup renders
// as the characters the model actually wrote.
function renderBody(container, text) {
  const parts = String(text).split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // Odd chunks are inside a fence. Drop an opening language tag line.
      const body = part.replace(/^[a-zA-Z0-9_+-]*\n/, '');
      const pre = el('pre', 'code-block');
      pre.appendChild(el('code', null, body));
      container.appendChild(pre);
      return;
    }
    for (const line of part.split('\n')) {
      const p = el('p', 'md-line');
      renderInline(p, line);
      container.appendChild(p);
    }
  });
}

function renderInline(parent, line) {
  const segments = String(line).split(/(`[^`]+`)/);
  for (const seg of segments) {
    if (seg.startsWith('`') && seg.endsWith('`') && seg.length > 2) {
      parent.appendChild(el('code', 'inline-code', seg.slice(1, -1)));
    } else if (seg) {
      parent.appendChild(document.createTextNode(seg));
    }
  }
}

// --- chat view -------------------------------------------------------------
function buildChat() {
  const wrap = el('div', 'chat');
  const stream = el('div', 'stream');
  stream.id = 'stream';

  if (!Chat.messages.length && !Chat.sending) {
    const empty = el('div', 'empty');
    empty.appendChild(el('h3', null, 'Ollama'));
    const ctx = Chat.moduleContext?.moduleName;
    empty.appendChild(el('p', null, ctx ? `Ask about ${ctx}, or anything else.` : 'Ask anything.'));
    stream.appendChild(empty);
  }

  for (const m of Chat.messages) stream.appendChild(buildBubble(m));

  if (Chat.sending) {
    const live = buildBubble({ role: 'assistant', content: Chat.streamText }, true);
    live.id = 'live-bubble';
    stream.appendChild(live);
  }
  wrap.appendChild(stream);

  if (Chat.error) {
    const bar = el('div', 'errbar');
    bar.appendChild(el('span', null, Chat.error));
    const retry = el('button', 'btn btn-s', 'Retry');
    retry.onclick = () => ChatActions.retryLast();
    bar.appendChild(retry);
    wrap.appendChild(bar);
  }

  wrap.appendChild(buildComposer());
  return wrap;
}

function buildBubble(m, live = false) {
  const row = el('div', `row ${m.role === 'assistant' ? 'assistant' : 'user'}`);
  const bubble = el('div', 'bubble');

  if (live && Chat.streamThinking) {
    const think = el('details', 'thinking');
    think.appendChild(el('summary', null, 'Thinking…'));
    think.appendChild(el('div', 'thinking-body', Chat.streamThinking));
    bubble.appendChild(think);
  }

  const body = el('div', 'body');
  if (m.content) renderBody(body, m.content);
  else if (live) body.appendChild(el('p', 'md-line dim', '…'));
  bubble.appendChild(body);

  if (m.error) bubble.appendChild(el('div', 'bubble-err', m.error));
  if (m.out_tokens != null) bubble.appendChild(el('div', 'meta', `${m.in_tokens ?? '?'} in · ${m.out_tokens} out`));

  row.appendChild(bubble);
  return row;
}

function buildComposer() {
  const form = el('form', 'composer');
  const input = el('textarea', 'input');
  input.id = 'composer-input';
  input.rows = 1;
  input.placeholder = Chat.sending ? 'Waiting for Ollama…' : 'Message Ollama…';
  input.disabled = Chat.sending;
  // Enter sends, Shift+Enter is a newline — the convention every chat UI uses,
  // and the reason this is a textarea rather than an input.
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  };
  input.oninput = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  };
  form.appendChild(input);

  const send = el('button', 'btn btn-p', Chat.sending ? 'Stop' : 'Send');
  send.type = Chat.sending ? 'button' : 'submit';
  if (Chat.sending) send.onclick = () => ChatActions.stop();
  form.appendChild(send);

  form.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value;
    input.value = '';
    input.style.height = 'auto';
    ChatActions.send(text);
  };
  return form;
}

// --- sessions view ---------------------------------------------------------
function buildSessions() {
  const wrap = el('div', 'pane');
  wrap.appendChild(el('div', 'pane-label', 'Conversations'));
  if (!Chat.sessions.length) wrap.appendChild(el('p', 'dim', 'No conversations yet.'));

  for (const s of Chat.sessions) {
    const row = el('div', `li ${s.id === Chat.sessionId ? 'sel' : ''}`);
    const name = el('span', 'li-name', s.title || 'Untitled');
    name.onclick = () => ChatActions.selectSession(s.id);
    row.appendChild(name);
    if (s.module_key) row.appendChild(el('span', 'tag', 'module'));
    const del = el('button', 'btn btn-g btn-i', '×');
    del.title = 'Delete';
    del.onclick = () => ChatActions.removeSession(s.id);
    row.appendChild(del);
    wrap.appendChild(row);
  }
  return wrap;
}

// --- settings view ---------------------------------------------------------
function field(label, node, hint) {
  const fg = el('div', 'fg');
  fg.appendChild(el('label', null, label));
  fg.appendChild(node);
  if (hint) fg.appendChild(el('div', 'hint', hint));
  return fg;
}

function input(id, value, { type = 'text', placeholder = '' } = {}) {
  const node = el('input');
  node.id = id;
  node.type = type;
  node.value = value ?? '';
  node.placeholder = placeholder;
  return node;
}

// Reports the outcome of a settings action in the notice slot without a full
// re-boot — used by the buttons that talk to the network.
async function withNotice(fn) {
  try {
    await fn();
  } catch (e) {
    Chat.notice = String(e?.message || e);
  }
  Chat.settings = await Provider.readSettings();
  render();
}

function buildEndpointSection(s) {
  const wrap = el('div');
  wrap.appendChild(el('div', 'pane-label', 'Server'));

  const base = input('cfg-base-url', s.baseUrlOverridden ? s.baseUrl : '', { placeholder: Provider.BASE_DEFAULT });
  const row = el('div', 'row-actions');
  row.appendChild(base);
  const save = el('button', 'btn btn-s', 'Save');
  save.onclick = () => ChatActions.saveSettings({ base_url: base.value.trim() });
  row.appendChild(save);
  const test = el('button', 'btn btn-s', 'Test');
  test.title = 'Ask the server for its version';
  test.onclick = () => withNotice(async () => {
    const version = await Provider.testConnection(Chat.settings);
    Chat.notice = `Connected — Ollama ${version}.`;
  });
  row.appendChild(test);

  wrap.appendChild(field('Server URL', row,
    `Leave blank for ${Provider.BASE_DEFAULT}. Requests go to <server>/api/chat.`));

  // The two declared origins are the ones the host will fetch on the plugin's
  // behalf; anything else falls back to this page's own fetch and hits CORS.
  // Say so here rather than letting it surface as an unexplained failure.
  if (Provider.hasHostNet() && !Provider.originAllowed(`${s.baseUrl}/`)) {
    wrap.appendChild(el('div', 'notice',
      `This plugin only declared ${Provider.ALLOWED_ORIGINS.join(' and ')}, so requests to `
      + `${s.baseUrl} go out from this page instead and the browser applies CORS. `
      + 'To use it, start Ollama with OLLAMA_ORIGINS set to include `null` (this page was '
      + 'loaded from a file, so that is the origin it sends).'));
  }
  return wrap;
}

function buildModelSection(s) {
  const wrap = el('div');
  wrap.appendChild(el('div', 'pane-label', 'Model'));

  const model = input('cfg-model', s.model, { placeholder: 'llama3.2' });
  model.setAttribute('list', 'model-options');
  const list = el('datalist');
  list.id = 'model-options';
  for (const id of modelOptions || Provider.MODEL_SUGGESTIONS) {
    const opt = el('option');
    opt.value = id;
    list.appendChild(opt);
  }
  const modelRow = el('div', 'row-actions');
  modelRow.append(model, list);
  const fetchBtn = el('button', 'btn btn-s', 'Fetch models');
  fetchBtn.title = 'Replace the suggestions with the models this server has pulled';
  fetchBtn.onclick = () => withNotice(async () => {
    modelOptions = await Provider.fetchModels(Chat.settings);
    Chat.notice = `${modelOptions.length} models installed.`;
  });
  modelRow.appendChild(fetchBtn);
  // Free text, not a dropdown: the real list is whatever this machine has
  // pulled, so the built-in suggestions are a starting point, never a limit.
  wrap.appendChild(field('Model', modelRow,
    'Any model this server has pulled. Fetch models reads the real list; the suggestions are only a hint.'));
  model.onchange = () => ChatActions.saveSettings({ model: model.value.trim() });

  const think = el('select');
  think.id = 'cfg-think';
  for (const value of Provider.THINK_MODES) {
    const opt = el('option', null, value === 'off' ? 'Off' : value === 'on' ? 'On' : value);
    opt.value = value;
    if (value === s.think) opt.selected = true;
    think.appendChild(opt);
  }
  think.onchange = () => ChatActions.saveSettings({ think: think.value });
  // Off by default and left off unless asked: a model with no thinking mode
  // answers 400 rather than ignoring the parameter.
  wrap.appendChild(field('Thinking', think,
    'Only thinking models (deepseek-r1, qwen3, gpt-oss …) accept this. On works everywhere they do; '
    + 'the named levels are understood by fewer models. Anything else answers with an error.'));

  const system = el('textarea');
  system.id = 'cfg-system';
  system.rows = 3;
  system.value = s.systemPrompt;
  system.placeholder = 'Optional instructions';
  system.onchange = () => ChatActions.saveSettings({ system_prompt: system.value });
  wrap.appendChild(field('System prompt', system, 'Sent as the first message of every request.'));
  return wrap;
}

function buildTuningSection(s) {
  const wrap = el('div');
  wrap.appendChild(el('div', 'pane-label', 'Generation'));
  // All three are blank by default so Ollama and the model's own Modelfile
  // keep their defaults — sending a guess here would silently override them.
  const numPredict = input('cfg-num-predict', s.numPredict ?? '', { type: 'number', placeholder: 'model default' });
  numPredict.onchange = () => ChatActions.saveSettings({ num_predict: numPredict.value.trim() });
  wrap.appendChild(field('Max tokens', numPredict, 'num_predict. Blank leaves it to the model.'));

  const temperature = input('cfg-temperature', s.temperature ?? '', { type: 'number', placeholder: 'model default' });
  temperature.step = '0.1';
  temperature.onchange = () => ChatActions.saveSettings({ temperature: temperature.value.trim() });
  wrap.appendChild(field('Temperature', temperature, 'Blank leaves it to the model.'));

  const numCtx = input('cfg-num-ctx', s.numCtx ?? '', { type: 'number', placeholder: 'model default' });
  numCtx.onchange = () => ChatActions.saveSettings({ num_ctx: numCtx.value.trim() });
  wrap.appendChild(field('Context size', numCtx,
    'num_ctx. Larger uses more memory; too large for your RAM and the model will not load.'));
  return wrap;
}

function buildSettings() {
  const s = Chat.settings;
  const wrap = el('div', 'pane');

  if (Chat.notice) wrap.appendChild(el('div', 'notice', Chat.notice));

  wrap.appendChild(el('div', 'pane-label', 'Connection'));
  wrap.appendChild(el('div', 'notice',
    'Ollama has no cloud API and no account — this plugin always talks to the Ollama CLI\'s own local '
    + 'server (`ollama serve`) on this machine. Unlike the Claude and Codex siblings, there is no separate '
    + 'mode to pick: the Ollama CLI is the only way this plugin ever connects.'));

  // No credentials section: Ollama runs on this machine and authenticates
  // nothing, so "connected" is only ever a reachable server plus a pulled model.
  wrap.appendChild(buildEndpointSection(s));
  wrap.appendChild(buildModelSection(s));
  wrap.appendChild(buildTuningSection(s));

  if (!Provider.hasHostNet()) {
    wrap.appendChild(el('div', 'notice',
      'This DraconDex version has no plugin network API, so requests go straight from this page '
      + 'and are subject to the browser\'s cross-origin rules. Update the app, or start Ollama with '
      + 'OLLAMA_ORIGINS set to include `null`.'));
  }
  return wrap;
}

// --- shell -----------------------------------------------------------------
function buildTabs() {
  const bar = el('div', 'tabs');
  for (const [view, label] of [['chat', 'Chat'], ['sessions', 'History'], ['settings', 'Settings']]) {
    const b = el('button', `tab ${Chat.view === view ? 'active' : ''}`, label);
    b.onclick = () => { Chat.view = view; render(); };
    bar.appendChild(b);
  }
  const add = el('button', 'btn btn-g btn-i', '+');
  add.title = 'New conversation';
  add.onclick = () => ChatActions.newSession();
  bar.appendChild(add);
  return bar;
}

function render() {
  const host = root();
  if (!host) return;
  host.replaceChildren();
  host.appendChild(buildTabs());
  if (Chat.view === 'settings') host.appendChild(buildSettings());
  else if (Chat.view === 'sessions') host.appendChild(buildSessions());
  else host.appendChild(buildChat());
  scrollToEnd();
  if (Chat.view === 'chat' && !Chat.sending) document.getElementById('composer-input')?.focus();
}

// Token-by-token patch of just the live bubble. A full render() here would
// reset the scroll position and blur the composer on every delta.
function renderStream() {
  const bubble = document.getElementById('live-bubble');
  if (!bubble) return;
  const body = bubble.querySelector('.body');
  if (body) { body.replaceChildren(); renderBody(body, Chat.streamText || '…'); }
  if (Chat.streamThinking) {
    let think = bubble.querySelector('.thinking-body');
    if (!think) {
      const details = el('details', 'thinking');
      details.appendChild(el('summary', null, 'Thinking…'));
      think = el('div', 'thinking-body');
      details.appendChild(think);
      bubble.prepend(details);
    }
    think.textContent = Chat.streamThinking;
  }
  scrollToEnd();
}

// Only auto-scroll when the user is already at the bottom — yanking the view
// down while they are reading back through the transcript is worse than
// letting new content arrive off-screen.
function scrollToEnd() {
  const stream = document.getElementById('stream');
  if (!stream) return;
  const atBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120;
  if (atBottom) stream.scrollTop = stream.scrollHeight;
}

window.UI = { render, renderStream };
