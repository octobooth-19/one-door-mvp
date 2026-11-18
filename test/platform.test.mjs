import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get as httpGet } from 'node:http';
import { createApplication } from '../lib/app.mjs';
import { createGateway } from '../lib/gateway.mjs';
import { GATEWAY_AUDIENCE, personas } from '../lib/identity.mjs';
import { createFinanceConnector, financeTools, FINANCE_AUDIENCE } from '../connectors/finance.mjs';
import { mcpRequest, decodeRpc } from '../lib/mcp.mjs';
import { loadRegistry } from '../lib/registry.mjs';

let app;
const audit = [];
before(async () => {
  app = await createApplication({ audit: record => audit.push(record) });
});
after(async () => app?.close());

async function login(personaId = 'avery-acme', instance = app) {
  const response = await fetch(`${instance.origin}/api/session`, {
    method: 'POST',
    headers: { Origin: instance.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ personaId }),
  });
  assert.equal(response.status, 201);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const bootstrap = await (await fetch(`${instance.origin}/api/bootstrap`, { headers: { Cookie: cookie } })).json();
  return {
    cookie, csrf: bootstrap.session.csrf, bootstrap,
    session: instance.identity.sessionFromRequest({ headers: { cookie } }),
  };
}

async function browserPost(path, body, user, instance = app) {
  return fetch(`${instance.origin}${path}`, {
    method: 'POST',
    headers: {
      Origin: instance.origin, 'Content-Type': 'application/json',
      Cookie: user.cookie, 'X-CSRF-Token': user.csrf,
    },
    body: JSON.stringify(body),
  });
}

async function conversation(user, instance = app) {
  const response = await browserPost('/api/conversations', {}, user, instance);
  assert.equal(response.status, 201);
  return (await response.json()).id;
}

async function chat(message, user, conversationId, instance = app) {
  const response = await browserPost('/api/chat', { message, conversationId }, user, instance);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = (await response.text()).split('\n\n').filter(frame => frame.startsWith('data:'))
    .map(frame => JSON.parse(frame.slice(5)));
  const done = events.findLast(event => event.type === 'done');
  assert.ok(done, 'SSE stream ends in an explicit done event');
  return { events, message: done.message };
}

const signal = () => AbortSignal.timeout(5000);

test('rejects production identity configuration rather than deploying demo auth', async () => {
  await assert.rejects(createApplication({ environment: { NODE_ENV: 'production' } }),
    { code: 'DEMO_ONLY' });
});

test('requires sessions, same-origin login, and CSRF for mutations', async () => {
  assert.equal((await fetch(`${app.origin}/api/conversations`)).status, 401);
  assert.equal((await fetch(`${app.origin}/api/session`, {
    method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ personaId: 'avery-acme' }),
  })).status, 403);
  const user = await login();
  const response = await fetch(`${app.origin}/api/conversations`, {
    method: 'POST', headers: { Cookie: user.cookie, Origin: app.origin },
  });
  assert.equal(response.status, 403);
  const status = await new Promise((resolve, reject) => {
    httpGet(`${app.origin}/health`, { headers: { Host: 'untrusted.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 403);
});

test('streams an account-specific, sourced balance with actual gateway stages', async () => {
  const user = await login();
  const id = await conversation(user);
  const reply = await chat('What is my outstanding balance?', user, id);
  assert.match(reply.message.text, /\$18,880\.00/);
  assert.match(reply.message.text, /\$6,400\.00 is overdue/);
  assert.equal(reply.message.results[0].source.toolName, 'finance_account_summary');
  assert.equal(reply.message.results[0].source.bundleDigest, app.registry.digest);
  assert.ok(reply.events.some(event => event.type === 'stage' && event.id === 'access' && event.state === 'complete'));
  assert.ok(reply.events.some(event => event.type === 'text'));
  assert.equal(reply.message.issues.length, 0);
  assert.equal(reply.message.results[0].data.rows.length, 2);
});

test('invoice reads and conversation history cannot cross customer sessions', async () => {
  const acme = await login();
  const northstar = await login('jordan-northstar');
  const id = await conversation(acme);
  const invoice = await chat('Was INV-1042 paid?', acme, id);
  assert.match(invoice.message.text, /INV-1042 is open/);
  const denied = await chat('Show INV-2088', acme, id);
  assert.equal(denied.message.issues[0].code, 'NOT_FOUND');
  assert.doesNotMatch(JSON.stringify(denied), /2800|Northstar Studio|November production/);
  const history = await fetch(`${app.origin}/api/conversations/${id}`, {
    headers: { Cookie: northstar.cookie },
  });
  assert.equal(history.status, 404);
  const own = await chat('What is my outstanding balance?', northstar, await conversation(northstar));
  assert.match(own.message.text, /\$2,800\.00/);
  assert.doesNotMatch(own.message.text, /18,880|Acme/);
});

test('follow-ups reuse only a successful lookup and last-month filters use the sample date', async () => {
  const user = await login();
  const id = await conversation(user);
  await chat('Show INV-1042', user, id);
  const followUp = await chat('When is it due?', user, id);
  assert.match(followUp.message.text, /2026-12-01/);
  const lastMonth = await chat('Show invoices from last month', user, id);
  assert.deepEqual(lastMonth.message.results[0].data.rows.map(row => row.invoice), ['INV-1038', 'INV-1031']);
});

test('unsupported domains and write requests do not call tools', async () => {
  const user = await login();
  const id = await conversation(user);
  const before = audit.filter(record => record.event === 'tool_authorized').length;
  const shipping = await chat('Where is my shipment?', user, id);
  const write = await chat('Refund invoice INV-1042', user, id);
  assert.equal(shipping.message.results.length, 0);
  assert.match(shipping.message.text, /not the other service/);
  assert.equal(write.message.results.length, 0);
  assert.match(write.message.text, /read-only/);
  assert.equal(audit.filter(record => record.event === 'tool_authorized').length, before);
});

test('an ineligible account sees no tool catalog and cannot call the gateway', async () => {
  const user = await login('sam-cobalt');
  assert.deepEqual(user.bootstrap.connectors, []);
  await assert.rejects(app.gatewayClient.catalog(user.session, 'finance', signal()), { code: 'ACCESS_DENIED' });
  const response = await chat('Show invoices', user, await conversation(user));
  assert.equal(response.message.results.length, 0);
  assert.match(response.message.text, /not enabled/);
});

test('gateway rejects writes, identity arguments, stale snapshots, and disabled connectors', async () => {
  const user = await login();
  await assert.rejects(app.gatewayClient.invoke(user.session, 'finance', 'finance_issue_refund', {}, signal()),
    { code: 'TOOL_DENIED' });
  await assert.rejects(app.gatewayClient.invoke(user.session, 'finance', 'finance_invoice_search',
    { customerId: 'northstar' }, signal()), { code: 'INVALID_INPUT' });
  const response = await fetch(`${app.gatewayOrigin}/invoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${app.identity.issueToken(user.session, GATEWAY_AUDIENCE)}`,
    },
    body: JSON.stringify({
      connectorId: 'finance', toolName: 'finance_account_summary', args: {},
      bundleDigest: 'old-snapshot', callId: 'test-stale',
    }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'SNAPSHOT_MISMATCH');
  app.gateway.disabled.add('finance');
  try {
    await assert.rejects(app.gatewayClient.catalog(user.session, 'finance', signal()), { code: 'CONNECTOR_DISABLED' });
  } finally {
    app.gateway.disabled.delete('finance');
  }
});

test('service tokens are audience-bound and logout revokes already issued tokens', async () => {
  const user = await login();
  const token = app.identity.issueToken(user.session, GATEWAY_AUDIENCE);
  await assert.rejects(mcpRequest({
    endpoint: `${app.connectorOrigin}/mcp`, token, method: 'tools/list', signal: signal(),
  }), { code: 'TOKEN_INVALID' });
  const connectorToken = app.identity.issueToken(user.session, FINANCE_AUDIENCE);
  const id = await conversation(user);
  assert.equal((await browserPost('/api/logout', {}, user)).status, 200);
  assert.throws(() => app.identity.verifyToken(connectorToken, FINANCE_AUDIENCE), { code: 'SIGN_IN_REQUIRED' });
  assert.equal((await fetch(`${app.origin}/api/conversations/${id}`, { headers: { Cookie: user.cookie } })).status, 401);
});

test('invoice cursors are bound to identity, filters, and expiration', async () => {
  let clock = 1000;
  const connector = await createFinanceConnector({ now: () => clock });
  const first = await connector.execute('finance_invoice_search', { limit: 1 }, personas[0]);
  assert.ok(first.nextCursor);
  const second = await connector.execute('finance_invoice_search',
    { limit: 1, cursor: first.nextCursor }, personas[0]);
  assert.equal(second.rows[0].invoice, 'INV-1038');
  await assert.rejects(connector.execute('finance_invoice_search',
    { limit: 1, cursor: first.nextCursor }, personas[1]), { code: 'INVALID_CURSOR' });
  await assert.rejects(connector.execute('finance_invoice_search',
    { limit: 1, status: 'paid', cursor: first.nextCursor }, personas[0]), { code: 'INVALID_CURSOR' });
  clock += 300_001;
  await assert.rejects(connector.execute('finance_invoice_search',
    { limit: 1, cursor: first.nextCursor }, personas[0]), { code: 'INVALID_CURSOR' });
});

test('changed tool descriptions are quarantined before model exposure', async () => {
  const original = await createFinanceConnector();
  const tools = structuredClone(financeTools);
  tools[0].description += ' An unreviewed change.';
  const instance = await createApplication({ connector: { ...original, tools } });
  try {
    const user = await login('avery-acme', instance);
    await assert.rejects(instance.gatewayClient.catalog(user.session, 'finance', signal()), { code: 'TOOL_DRIFT' });
  } finally {
    await instance.close();
  }
});

test('connector timeouts remain explicit and open a bounded circuit breaker', async () => {
  const original = await createFinanceConnector();
  const instance = await createApplication({
    connector: {
      ...original,
      async execute(...args) {
        await new Promise(resolve => setTimeout(resolve, 80));
        return original.execute(...args);
      },
    },
    gatewayOptions: { timeoutMs: 25, failureThreshold: 2, cooldownMs: 1000 },
  });

  try {
    const user = await login('avery-acme', instance);
    for (let index = 0; index < 2; index++) {
      await assert.rejects(instance.gatewayClient.invoke(user.session, 'finance',
        'finance_account_summary', {}, signal()), { code: 'CONNECTOR_TIMEOUT' });
    }
    await assert.rejects(instance.gatewayClient.invoke(user.session, 'finance',
      'finance_account_summary', {}, signal()), { code: 'CIRCUIT_OPEN' });
  } finally {
    await instance.close();
  }
});

test('invalid connector output produces a visible error instead of an empty success', async () => {
  const original = await createFinanceConnector();
  const instance = await createApplication({
    connector: { ...original, execute: async () => ({ summary: 'Incomplete record' }) },
  });
  try {
    const user = await login('avery-acme', instance);
    const result = await chat('Show invoices', user, await conversation(user, instance), instance);
    assert.equal(result.message.results.length, 0);
    assert.equal(result.message.issues[0].code, 'INVALID_TOOL_OUTPUT');
    assert.match(result.message.text, /outside its approved output schema/);
  } finally {
    await instance.close();
  }
});

test('registry changes update capabilities without core code edits; policy cannot be self-granted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'one-door-registry-'));
  const registryDir = join(directory, 'registry');
  try {
    await cp(fileURLToPath(new URL('../registry', import.meta.url)), registryDir, { recursive: true });
    const path = join(registryDir, 'connectors', 'finance.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.display.capabilities = ['Reviewed account insights'];
    await writeFile(path, JSON.stringify(manifest));
    const registry = await loadRegistry(registryDir);
    assert.deepEqual(registry.visible(personas[0])[0].display.capabilities, ['Reviewed account insights']);
    assert.notEqual(registry.digest, app.registry.digest);
    manifest.tools[0].scope = 'finance:admin';
    await writeFile(path, JSON.stringify(manifest));
    await assert.rejects(loadRegistry(registryDir), { code: 'POLICY_DENIED' });
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('connector endpoint bindings cannot be changed to an unapproved host', () => {
  assert.throws(() => createGateway({
    registry: app.registry, identity: app.identity, bindings: { finance: 'http://169.254.169.254/mcp' },
  }), { code: 'ENDPOINT_DENIED' });
});

test('MCP client accepts a request-scoped SSE response and rejects mismatched IDs', async () => {
  const response = new Response(
    'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n' +
    'data: {"jsonrpc":"2.0","id":"call-1","result":{"resultType":"complete","tools":[]}}\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
  assert.deepEqual((await decodeRpc(response, 'call-1')).tools, []);
  await assert.rejects(decodeRpc(new Response(JSON.stringify({
    jsonrpc: '2.0', id: 'another-call', result: { resultType: 'complete' },
  }), { headers: { 'Content-Type': 'application/json' } }), 'call-1'),
  { code: 'INVALID_CONNECTOR_RESPONSE' });
});

test('audit events contain decisions and opaque actors, not prompts or business records', () => {
  assert.ok(audit.some(record => record.event === 'tool_completed'));
  const serialized = JSON.stringify(audit);
  assert.doesNotMatch(serialized, /INV-1042|Northstar|Acme|18880|outstanding balance|Bearer /);
  assert.ok(audit.filter(record => record.actorRef).every(record => /^[a-f0-9]{16}$/.test(record.actorRef)));
});
