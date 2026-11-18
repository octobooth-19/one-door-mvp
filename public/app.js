const $ = id => document.getElementById(id);
const state = {
  bootstrap: null, activeId: null, conversations: [], busy: false,
  controller: null, generation: 0, trace: [], traceId: null,
};
const stageLabels = [
  ['route', 'Find the right service'],
  ['access', 'Check permissions'],
  ['source', 'Read the source'],
  ['answer', 'Bring it together'],
];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `icon ${className}`);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function notice(message) {
  const node = element('div', 'notice');
  node.append(element('span', '', message));
  const close = element('button');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss notice');
  close.append(icon('close'));
  close.addEventListener('click', () => node.remove());
  node.append(close);
  $('notices').append(node);
}

async function api(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(path, {
    method, signal, credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(state.bootstrap?.session ? { 'X-CSRF-Token': state.bootstrap.session.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error?.message ?? `Request failed (${response.status}).`);
  }
  return response;
}

function dateLabel(value, year = false) {
  const date = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC',
  }).format(date);
}

function showDialog(title, children) {
  $('dialog-title').textContent = title;
  $('dialog-body').replaceChildren(...children);
  if (!$('detail-dialog').open) $('detail-dialog').showModal();
}

function about() {
  const local = element('p', 'dialog-notice',
    'This is a working local reference MVP, not a production Azure deployment. Every identity and business record is synthetic.');
  const implemented = element('ul');
  [
    'One customer experience backed by a real loopback gateway and MCP connector.',
    'Three read-only Finance tools, account-scoped records, and hash-pinned tool definitions.',
    'Streamed progress, source details, bounded tool calls, and explicit errors.',
    'A registry-driven capability list. No package downloads or external assets.',
  ].forEach(text => implemented.append(element('li', '', text)));
  const model = element('p', '',
    state.bootstrap?.provider.id === 'azure'
      ? 'Azure OpenAI is configured for tool selection. Questions are sent to that deployment; answers are rendered from verified connector results. Azure model errors do not fall back to demo rules.'
      : 'The preview uses deterministic Finance rules, not an LLM. An optional Azure OpenAI REST adapter can select tools when explicitly configured. No model service is contacted in this mode.');
  const limitations = element('p', '',
    'Live Entra sign-in/OBO, production Azure infrastructure, real BU APIs, durable conversation storage, signed registry releases, and human support integration are not implemented. Local conversations expire with the session and are lost on server restart.');
  const boundaries = element('p', '',
    'Demo accounts are selectable without a password. This demonstrates downstream isolation, not real customer authentication. Do not expose this server publicly or enter sensitive data.');
  showDialog('A small start. Clear boundaries.', [
    local, element('h3', '', 'What works today'), implemented,
    element('h3', '', 'Model behavior'), model,
    element('h3', '', 'Not production-ready'), limitations, boundaries,
  ]);
}

function connectorDetails(connector) {
  const items = [
    element('p', '', connector.description),
    element('p', 'dialog-notice', `MCP ${connector.protocolVersion} / ${connector.tools.length} read-only tools / local sample connector`),
    element('h3', '', 'Approved capabilities'),
  ];
  const list = element('ul');
  connector.capabilities.forEach(capability => list.append(element('li', '', capability)));
  items.push(list, element('h3', '', 'Pinned tool definitions'));
  connector.tools.forEach(tool => {
    const entry = element('div', 'tool-detail');
    entry.append(element('strong', '', tool.name), element('code', '', tool.pin));
    items.push(entry);
  });
  items.push(element('h3', '', 'Registry snapshot'), element('code', '', state.bootstrap.bundleDigest),
    element('p', '', 'Pins detect definition drift. This local snapshot is hashed, not a production-signed release. A changed definition is blocked until explicitly reviewed and re-pinned.'));
  showDialog(`${connector.name}, connected.`, items);
}

function allConnectors() {
  const connectors = state.bootstrap?.connectors ?? [];
  if (connectors.length === 1) return connectorDetails(connectors[0]);
  const children = [element('p', '', connectors.length
    ? 'These capabilities are available to the current demo account.'
    : 'No services are enabled for this account. Choose Acme Industrial or Northstar Studio to explore Finance.')];
  connectors.forEach(connector => children.push(connectorButton(connector)));
  showDialog('Connected services', children);
}

function sourceDetails(source) {
  showDialog('A source you can inspect.', [
    element('p', 'dialog-notice', `${source.name} / synthetic snapshot / ${dateLabel(source.asOf, true)}`),
    element('h3', '', 'Read-only tool'), element('code', '', source.toolName),
    element('h3', '', 'Verified definition hash'), element('code', '', source.pin),
    element('h3', '', 'Registry snapshot'), element('code', '', source.bundleDigest),
    element('p', '', 'The gateway checked this tool against the approved definition before execution. The connector filtered records to the current demo account. This is not a live financial statement.'),
  ]);
}

function accountPicker() {
  const children = [
    element('p', 'dialog-notice', 'Choose a synthetic customer. This is demo identity, not Entra authentication. Switching accounts clears this session’s conversations.'),
  ];
  for (const persona of state.bootstrap?.personas ?? []) {
    const button = element('button', 'account-option');
    button.type = 'button';
    const copy = element('div');
    copy.append(element('strong', '', persona.organization),
      element('p', '', `${persona.name} / ${persona.scopes.length ? 'Finance enabled' : 'No Finance access'}`));
    button.append(element('span', 'avatar', persona.initials), copy, icon('arrow'));
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await api('/api/session', { method: 'POST', body: { personaId: persona.id } });
        $('detail-dialog').close();
        resetView();
        state.conversations = [];
        renderHistory();
        toggleNavigation(false);
        await bootstrap();
      } catch (error) {
        notice(error.message);
      } finally {
        button.disabled = false;
      }
    });
    children.push(button);
  }
  if (state.bootstrap?.session) {
    const logout = element('button', 'signout-button');
    logout.type = 'button';
    logout.append(icon('logout'), element('span', '', 'End this demo session'));
    logout.addEventListener('click', async () => {
      try {
        await api('/api/logout', { method: 'POST', body: {} });
        $('detail-dialog').close();
        resetView();
        state.conversations = [];
        renderHistory();
        toggleNavigation(false);
        await bootstrap();
      } catch (error) {
        notice(error.message);
      }
    });
    children.push(logout);
  }
  showDialog('A workspace of your own.', children);
}

function connectorButton(connector) {
  const button = element('button', 'connector-card');
  button.type = 'button';
  const top = element('div', 'connector-card-top');
  const status = element('span', 'service-state');
  status.append(element('span', 'tiny-dot'), element('span', '', 'Available'));
  top.append(icon('balance'), element('strong', '', connector.name), status);
  button.append(top, element('p', '', `${connector.tools.length} read-only tools / MCP`));
  button.addEventListener('click', () => connectorDetails(connector));
  return button;
}

function renderWorkspace() {
  const data = state.bootstrap;
  const principal = data.session?.principal;
  const connected = data.connectors;
  $('avatar').textContent = principal?.initials ?? 'OD';
  $('account-name').textContent = principal?.name ?? 'Explore the workspace';
  $('account-organization').textContent = principal?.organization ?? 'Choose a demo account';
  $('workspace-organization').textContent = principal?.organization ?? 'Your demo workspace';
  $('service-count').textContent = connected.length;
  $('nav-count').textContent = connected.length;
  $('provider-label').textContent = data.provider.label;
  $('composer-service').textContent = principal
    ? connected.length ? `${connected.map(item => item.name).join(', ')} available / Read-only` : 'No services enabled for this account'
    : 'Choose a demo account to begin';
  $('connector-list').replaceChildren(...(connected.length
    ? connected.map(connectorButton)
    : [element('p', 'subtle', principal ? 'No services are enabled for this account.' : 'Choose an account to see its services.')]));
  $('welcome-description').textContent = principal
    ? connected.length ? 'Check invoices, understand balances, and find payment details. Your account information, without switching tools.'
      : 'This demo account has no Finance access. Switch accounts to explore the available capabilities.'
    : 'The answers you need, from the teams you trust. Start with a demo account to see it in action.';
  const welcomeService = $('welcome-service').querySelector('span');
  welcomeService.textContent = connected.length
    ? `${connected.map(item => item.name).join(', ')} connected / ${dateLabel(data.asOf, true)} sample snapshot`
    : 'A read-only space to explore';
  $('prompt-grid').replaceChildren();
  for (const connector of connected) {
    for (const prompt of connector.prompts) {
      const button = element('button', 'prompt-card');
      button.type = 'button';
      const box = element('span', 'prompt-card-icon');
      box.append(icon(prompt.icon));
      button.append(box, element('strong', '', prompt.title), element('p', '', prompt.description), icon('arrow', 'prompt-arrow'));
      button.addEventListener('click', () => sendMessage(prompt.message));
      $('prompt-grid').append(button);
    }
  }
  $('start-demo').hidden = Boolean(principal);
  updateControls();
}

async function bootstrap() {
  state.bootstrap = await (await api('/api/bootstrap')).json();
  renderWorkspace();
  if (state.bootstrap.session) await refreshHistory();
  else {
    state.conversations = [];
    renderHistory();
  }
}

async function refreshHistory() {
  if (!state.bootstrap?.session) return;
  state.conversations = (await (await api('/api/conversations')).json()).conversations;
  renderHistory();
}

function renderHistory() {
  $('history').replaceChildren();
  if (!state.conversations.length) {
    $('history').append(element('p', 'history-empty', 'A fresh start. Your conversations will appear here.'));
    return;
  }
  for (const conversation of state.conversations) {
    const button = element('button', `history-button${conversation.id === state.activeId ? ' selected' : ''}`);
    button.type = 'button';
    button.disabled = state.busy;
    button.title = conversation.title;
    if (conversation.id === state.activeId) button.setAttribute('aria-current', 'true');
    button.append(icon('chat'), element('span', '', conversation.title));
    button.addEventListener('click', () => loadConversation(conversation.id));
    $('history').append(button);
  }
}

async function loadConversation(id) {
  try {
    const conversation = await (await api(`/api/conversations/${encodeURIComponent(id)}`)).json();
    resetView();
    state.activeId = id;
    $('welcome').hidden = conversation.messages.length > 0;
    for (const message of conversation.messages) appendMessage(message);
    const last = conversation.messages.findLast(message => message.role === 'assistant');
    state.trace = last?.stages ?? [];
    state.traceId = last?.traceId ?? null;
    renderTrace();
    renderHistory();
    toggleNavigation(false);
    scrollBottom();
    if (conversation.busy) notice('This conversation is still running in another view. Reopen it after the response finishes.');
  } catch (error) {
    notice(error.message);
  }
}

function resetView() {
  state.generation++;
  state.controller?.abort();
  state.controller = null;
  state.busy = false;
  state.activeId = null;
  state.trace = [];
  state.traceId = null;
  $('messages').replaceChildren();
  $('welcome').hidden = false;
  $('question').value = '';
  updateControls();
  renderTrace();
}

function newConversation() {
  if (state.busy) return;
  resetView();
  renderHistory();
  toggleNavigation(false);
  if (state.bootstrap?.session) $('question').focus();
  else accountPicker();
}

function updateControls() {
  const loggedIn = Boolean(state.bootstrap?.session);
  $('messages').setAttribute('aria-busy', String(state.busy));
  $('question').disabled = !loggedIn || state.busy;
  $('send-button').disabled = !loggedIn || state.busy || !$('question').value.trim();
  $('send-button').hidden = state.busy;
  $('stop-button').hidden = !state.busy;
  $('new-chat').disabled = state.busy;
  $('account-button').disabled = state.busy;
  $('character-count').textContent = `${$('question').value.length} / 2000`;
  document.querySelectorAll('.followup, .prompt-card, .history-button').forEach(button => {
    button.disabled = state.busy;
  });
}

function scrollBottom() {
  $('scroll-area').scrollTop = $('scroll-area').scrollHeight;
}

function resultCard(result) {
  const { data, source } = result;
  const card = element('section', 'answer-card');
  const header = element('div', 'answer-card-heading');
  const verified = element('span', 'verified-badge');
  verified.append(icon('shield'), element('span', '', 'Source checked'));
  header.append(element('h3', '', data.title), verified);
  card.append(header);
  if (data.metrics.length) {
    const metrics = element('div', 'metrics');
    data.metrics.forEach(metric => {
      const entry = element('div', `metric ${metric.tone}`);
      entry.append(element('strong', '', metric.value), element('span', '', metric.label));
      metrics.append(entry);
    });
    card.append(metrics);
  }
  if (data.columns.length) {
    const wrapper = element('div', 'result-table-wrap');
    const table = element('table', 'result-table');
    const caption = element('caption', 'sr-only', data.title);
    const head = element('thead');
    const labels = element('tr');
    data.columns.forEach(column => {
      const cell = element('th', '', column.label);
      cell.scope = 'col';
      labels.append(cell);
    });
    head.append(labels);
    const body = element('tbody');
    data.rows.forEach(row => {
      const line = element('tr');
      data.columns.forEach(column => {
        const cell = element('td');
        const value = row[column.key] ?? '';
        if (column.format === 'status') {
          const status = String(value).toLowerCase();
          cell.append(element('span', `status-badge ${['open', 'paid', 'overdue'].includes(status) ? status : ''}`, value));
        } else if (column.format === 'money' && typeof value === 'number') {
          cell.textContent = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
        } else if (column.format === 'date') {
          cell.textContent = dateLabel(String(value), true);
        } else {
          cell.textContent = value;
        }
        line.append(cell);
      });
      body.append(line);
    });
    if (!data.rows.length) {
      const row = element('tr');
      const cell = element('td', '', 'No matching invoices.');
      cell.colSpan = data.columns.length;
      row.append(cell);
      body.append(row);
    }
    table.append(caption, head, body);
    wrapper.append(table);
    card.append(wrapper);
  }
  if (data.details.length) {
    const list = element('dl', 'answer-details');
    data.details.forEach(detail => {
      const pair = element('div');
      pair.append(element('dt', '', detail.label), element('dd', '', detail.value));
      list.append(pair);
    });
    card.append(list);
  }
  const footer = element('div', 'source-bar');
  const button = element('button', 'source-button');
  button.type = 'button';
  button.append(icon('layers'), element('span', '', `${source.name} source`), icon('chevron'));
  button.addEventListener('click', () => sourceDetails(source));
  footer.append(button, element('span', '', `Sample snapshot / ${dateLabel(source.asOf, true)}`));
  card.append(footer);
  return card;
}

function fillAssistant(node, message, loading = false) {
  node.replaceChildren();
  const heading = element('div', 'assistant-heading');
  const avatar = element('span', 'assistant-avatar');
  avatar.append(icon('door'));
  heading.append(avatar, element('strong', '', 'OneDoor'), element('span', 'assistant-label', 'READ-ONLY ASSISTANT'));
  const body = element('div', 'assistant-body');
  if (message.issues?.length) {
    const issue = element('div', 'issue-tag');
    issue.append(icon('info'), element('span', '', message.issues[0].code === 'CANCELLED' ? 'Response stopped' : 'Something needs attention'));
    body.append(issue);
  }
  const text = element('p', 'assistant-text', message.text ?? '');
  text.hidden = !message.text;
  body.append(text);
  if (loading && !message.text && !message.results?.length) {
    const indicator = element('div', 'working-indicator');
    indicator.append(element('i'), element('i'), element('i'), element('span', '', 'Finding a clear answer'));
    body.append(indicator);
  }
  for (const result of message.results ?? []) body.append(resultCard(result));
  if (!loading && message.suggestions?.length) {
    const followups = element('div', 'followups');
    message.suggestions.forEach(suggestion => {
      const button = element('button', 'followup');
      button.type = 'button';
      button.append(element('span', '', suggestion), icon('arrow'));
      button.addEventListener('click', () => sendMessage(suggestion));
      followups.append(button);
    });
    body.append(followups);
  }
  if (!loading) {
    const footer = element('div', 'message-footer');
    const copy = element('button', 'copy-button');
    copy.type = 'button';
    copy.setAttribute('aria-label', 'Copy answer');
    copy.append(icon('copy'));
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(message.text ?? '');
        copy.setAttribute('aria-label', 'Answer copied');
        copy.replaceChildren(icon('check'));
      } catch {
        notice('Clipboard access is unavailable. You can select and copy the answer text.');
      }
    });
    footer.append(copy, element('span', '', message.results?.length ? 'Grounded in connector data' : 'No tool data used'));
    if (message.durationMs !== undefined) {
      footer.append(element('span', '', `${message.durationMs} ms`));
    }
    body.append(footer);
  }
  node.append(heading, body);
}

function appendMessage(message, loading = false) {
  const node = element('article', `message ${message.role === 'user' ? 'user-message' : 'assistant-message'}`);
  if (message.role === 'user') {
    node.setAttribute('aria-label', 'Your message');
    node.append(element('p', 'user-bubble', message.text));
  } else {
    node.setAttribute('aria-label', 'OneDoor answer');
    fillAssistant(node, message, loading);
  }
  $('messages').append(node);
  return node;
}

function traceList() {
  const list = element('ol', 'trace-steps');
  stageLabels.forEach(([id, label], index) => {
    const progress = state.trace.find(stage => stage.id === id);
    const item = element('li', `trace-step ${progress?.state ?? 'pending'}`);
    const marker = element('span', 'step-marker');
    if (progress?.state === 'complete') marker.append(icon('check'));
    else if (progress?.state === 'error') marker.append(icon('info'));
    else if (progress?.state !== 'running') marker.textContent = progress?.state === 'idle' ? '-' : index + 1;
    const copy = element('div', 'step-copy');
    copy.append(element('strong', '', label));
    if (progress) copy.append(element('p', '', progress.detail));
    item.append(marker, copy);
    list.append(item);
  });
  return list;
}

function renderTrace() {
  $('trace-steps').replaceChildren(...traceList().children);
  $('activity-state').textContent = state.busy ? 'Working' :
    state.trace.some(stage => stage.state === 'error') ? 'Attention' :
      state.trace.some(stage => stage.id === 'answer' && stage.state === 'complete') ? 'Complete' : 'Ready';
  $('trace-reference').hidden = !state.traceId;
  $('trace-reference').textContent = state.traceId ? `TRACE ${state.traceId}` : '';
}

function activityDetails() {
  const children = [
    element('p', '', 'These steps reflect the current or most recently opened answer. They are application events, not hidden model reasoning.'),
    traceList(),
  ];
  if (state.traceId) children.push(element('h3', '', 'Trace reference'), element('code', '', state.traceId));
  showDialog('Behind the answer', children);
}

async function sendMessage(message) {
  if (state.busy) return;
  if (!state.bootstrap?.session) return accountPicker();
  const value = message.trim();
  if (!value) return;
  if (value.length > 2000) return notice('Messages are limited to 2,000 characters.');
  const generation = state.generation;
  state.busy = true;
  state.trace = [];
  state.traceId = null;
  state.controller = new AbortController();
  $('question').value = '';
  updateControls();
  renderTrace();
  toggleNavigation(false);
  let node;
  const pending = { role: 'assistant', text: '', results: [], suggestions: [], issues: [], stages: [] };
  let completed = false;
  try {
    if (!state.activeId) {
      const created = await (await api('/api/conversations', { method: 'POST', body: {} })).json();
      state.activeId = created.id;
    }
    $('welcome').hidden = true;
    appendMessage({ role: 'user', text: value });
    node = appendMessage(pending, true);
    scrollBottom();
    const response = await api('/api/chat', {
      method: 'POST', body: { conversationId: state.activeId, message: value }, signal: state.controller.signal,
    });
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      throw new Error('The server did not return a chat event stream.');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value: bytes, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(bytes, { stream: true });
      if (buffer.length > 262_144) throw new Error('The streamed result exceeded the display limit.');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const payload = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!payload) continue;
        const event = JSON.parse(payload);
        if (generation !== state.generation) return;
        const follow = $('scroll-area').scrollHeight - $('scroll-area').scrollTop - $('scroll-area').clientHeight < 180;
        if (event.type === 'start') {
          state.traceId = event.traceId;
        } else if (event.type === 'stage') {
          const existing = state.trace.findIndex(stage => stage.id === event.id);
          if (existing >= 0) state.trace[existing] = event;
          else state.trace.push(event);
          renderTrace();
        } else if (event.type === 'result') {
          pending.results.push(event.result);
          fillAssistant(node, pending, true);
        } else if (event.type === 'text') {
          pending.text += event.delta;
          const text = node.querySelector('.assistant-text');
          text.hidden = false;
          text.textContent = pending.text;
          node.querySelector('.working-indicator')?.remove();
        } else if (event.type === 'error') {
          pending.text = event.error.message;
          pending.issues = [event.error];
          fillAssistant(node, pending, true);
        } else if (event.type === 'done') {
          completed = true;
          Object.assign(pending, event.message);
          state.trace = event.message.stages;
          fillAssistant(node, event.message);
        }
        if (follow) scrollBottom();
      }
      if (done) break;
    }
    if (!completed) throw new Error('The connection ended before the answer was complete. Please try again.');
  } catch (error) {
    if (generation !== state.generation) return;
    const cancelled = state.controller?.signal.aborted;
    pending.text = cancelled ? 'Response stopped. No business records were changed.' : error.message;
    pending.issues = [{ code: cancelled ? 'CANCELLED' : 'CONNECTION_ERROR', message: pending.text }];
    if (node) fillAssistant(node, pending);
    else notice(pending.text);
    const running = state.trace.find(stage => stage.state === 'running');
    if (running) {
      running.state = 'error';
      running.detail = pending.text;
    }
  } finally {
    if (generation === state.generation) {
      state.busy = false;
      state.controller = null;
      updateControls();
      renderTrace();
      try {
        await refreshHistory();
      } catch (error) {
        notice(`Could not refresh conversation history: ${error.message}`);
      }
      $('question').focus();
    }
  }
}

function toggleNavigation(open) {
  const expanded = Boolean(open) && matchMedia('(max-width: 700px)').matches;
  document.body.classList.toggle('nav-open', expanded);
  $('nav-overlay').hidden = !expanded;
  $('menu-button').setAttribute('aria-expanded', String(expanded));
  $('workspace').inert = expanded;
  if (expanded) $('new-chat').focus();
}

$('composer').addEventListener('submit', event => {
  event.preventDefault();
  sendMessage($('question').value);
});
$('question').addEventListener('input', updateControls);
$('question').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!$('send-button').disabled) $('composer').requestSubmit();
  }
});
$('stop-button').addEventListener('click', () => state.controller?.abort());
$('new-chat').addEventListener('click', newConversation);
$('chat-nav').addEventListener('click', () => {
  toggleNavigation(false);
  if (!state.busy) $('question').focus();
});
$('connectors-nav').addEventListener('click', allConnectors);
$('about-button').addEventListener('click', about);
$('boundaries-button').addEventListener('click', about);
$('activity-button').addEventListener('click', activityDetails);
$('account-button').addEventListener('click', accountPicker);
$('start-demo').addEventListener('click', accountPicker);
$('close-dialog').addEventListener('click', () => $('detail-dialog').close());
$('detail-dialog').addEventListener('click', event => {
  if (event.target === $('detail-dialog')) $('detail-dialog').close();
});
$('menu-button').addEventListener('click', () => toggleNavigation(!document.body.classList.contains('nav-open')));
$('nav-overlay').addEventListener('click', () => toggleNavigation(false));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') toggleNavigation(false);
  if (document.body.classList.contains('nav-open') && event.key === 'Tab') {
    const controls = [...$('sidebar').querySelectorAll('a, button:not(:disabled)')];
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  if (event.key.toLowerCase() === 'n' && !event.metaKey && !event.ctrlKey && !event.altKey &&
    !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !$('detail-dialog').open) {
    event.preventDefault();
    newConversation();
  }
});
matchMedia('(max-width: 700px)').addEventListener('change', () => toggleNavigation(false));
renderTrace();
try {
  await bootstrap();
} catch (error) {
  notice(`Could not load the workspace: ${error.message}`);
}
