import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldToIo } from 'node:timers/promises';
import {
  AppError, checkLocalRequest, closeServer, httpHandler, listen, publicError,
  readJson, requireBrowserOrigin, requireThat, sendJson,
} from './shared.mjs';
import { createDemoIdentity, GATEWAY_AUDIENCE, personas, sessionCookie } from './identity.mjs';
import { loadRegistry, publicConnector } from './registry.mjs';
import { object, text, validate } from './schema.mjs';
import { createMcpServer } from './mcp.mjs';
import { createGateway, createGatewayClient } from './gateway.mjs';
import { createFinanceConnector, FINANCE_AUDIENCE } from '../connectors/finance.mjs';
import { createFinanceDemoPlanner } from '../connectors/finance-demo.mjs';
import { createAzurePlanner } from './model.mjs';
import { createChatRunner } from './chat.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const chatSchema = object({
  conversationId: { ...text(80), minLength: 1 },
  message: { ...text(2000), minLength: 1 },
});
const securityHeaders = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function fileAudit(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return record => {
    let size = 0;
    try {
      size = statSync(path).size;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    requireThat(size < 5_000_000, 'AUDIT_CAPACITY',
      'The local audit file is full. Archive it before continuing.', 503);
    appendFileSync(path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
  };
}

export async function createApplication({
  port = 0, registryDir = join(root, 'registry'), environment = {},
  audit = () => {}, planner: suppliedPlanner, connector: suppliedConnector,
  gatewayOptions = {}, turnTimeoutMs = 20_000,
} = {}) {
  requireThat(environment.NODE_ENV !== 'production' &&
    (!environment.AUTH_MODE || environment.AUTH_MODE === 'demo'),
  'DEMO_ONLY', 'Demo identity cannot run as production authentication. Entra integration is not implemented.');
  const registry = await loadRegistry(registryDir);
  const identity = createDemoIdentity({
    audiences: [GATEWAY_AUDIENCE, ...registry.connectors.map(connector => connector.auth.audience)],
  });
  const connector = suppliedConnector ?? await createFinanceConnector();
  const mode = environment.MODEL_PROVIDER ?? 'demo';
  requireThat(['demo', 'azure'].includes(mode), 'MODEL_CONFIG', 'MODEL_PROVIDER must be demo or azure.');
  const planner = suppliedPlanner ?? (mode === 'azure'
    ? createAzurePlanner({
      endpoint: environment.AZURE_OPENAI_ENDPOINT,
      deployment: environment.AZURE_OPENAI_DEPLOYMENT,
      apiKey: environment.AZURE_OPENAI_API_KEY,
    })
    : createFinanceDemoPlanner({ asOf: connector.asOf }));
  const servers = [];
  const conversations = new Map();
  const rateWindows = new Map();
  const activeTurns = new Set();

  function sweep() {
    for (const [id, conversation] of conversations) {
      if (!identity.isActive(conversation.owner)) conversations.delete(id);
    }
    for (const [id, window] of rateWindows) {
      if (window.started + 60_000 < Date.now()) rateWindows.delete(id);
    }
  }

  function ownConversation(id, session) {
    const conversation = conversations.get(id);
    requireThat(conversation?.owner === session.id, 'CONVERSATION_NOT_FOUND',
      'This conversation is not available in the current session.', 404);
    return conversation;
  }

  function summary(conversation) {
    return { id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt };
  }

  function clearSession(session) {
    for (const [id, conversation] of conversations) {
      if (conversation.owner === session.id) {
        conversation.controller?.abort();
        conversations.delete(id);
      }
    }
    rateWindows.delete(session.id);
    identity.revoke(session.id);
  }

  try {
    const mcpServer = createMcpServer({ connector, identity, audience: FINANCE_AUDIENCE });
    servers.push(mcpServer);
    const connectorOrigin = await listen(mcpServer);
    const gateway = createGateway({
      registry, identity, bindings: { finance: `${connectorOrigin}/mcp` }, audit, ...gatewayOptions,
    });
    servers.push(gateway.server);
    const gatewayOrigin = await listen(gateway.server);
    const gatewayClient = createGatewayClient({ origin: gatewayOrigin, identity, registry });
    const runChat = createChatRunner({ registry, identity, gateway: gatewayClient, planner });
    const publicFiles = new Map([
      ['/', ['index.html', 'text/html; charset=utf-8']],
      ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
      ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
      ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
    ]);
    const server = createServer(httpHandler(async (request, response) => {
      checkLocalRequest(request);
      for (const [key, value] of Object.entries(securityHeaders)) response.setHeader(key, value);
      const path = new URL(request.url, 'http://localhost').pathname;
      if (request.method === 'GET' && publicFiles.has(path)) {
        const [file, contentType] = publicFiles.get(path);
        const content = await readFile(join(root, 'public', file));
        response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
        return response.end(content);
      }
      if (request.method === 'GET' && path === '/health') {
        return sendJson(response, 200, { status: 'ok', mode: 'local-demo', provider: planner.id });
      }
      sweep();
      if (request.method === 'GET' && path === '/api/bootstrap') {
        let session = null;
        if (request.headers.cookie?.includes('one_door_session=')) {
          try {
            session = identity.sessionFromRequest(request);
          } catch (error) {
            if (!(error instanceof AppError) || error.status !== 401) throw error;
          }
        }
        return sendJson(response, 200, {
          mode: 'local-demo', provider: { id: planner.id, label: planner.label },
          asOf: connector.asOf, personas,
          session: session ? {
            principal: session.principal, csrf: session.csrf, expiresAt: session.expiresAt,
          } : null,
          connectors: session ? registry.visible(session.principal)
            .map(item => publicConnector(item, session.principal)) : [],
          bundleDigest: registry.digest,
        });
      }
      if (request.method === 'POST') requireBrowserOrigin(request);
      if (request.method === 'POST' && path === '/api/session') {
        const input = await readJson(request);
        validate(object({ personaId: text(80) }), input);
        let previous = null;
        try {
          previous = identity.sessionFromRequest(request);
        } catch (error) {
          if (!(error instanceof AppError) || error.status !== 401) throw error;
        }
        const session = identity.createSession(input.personaId);
        if (previous) clearSession(previous);
        audit({ event: 'demo_session_started', actorRef: identity.actorRef(session.principal) });
        return sendJson(response, 201, { ok: true }, { 'Set-Cookie': sessionCookie(session.id) });
      }
      const session = identity.sessionFromRequest(request);
      if (request.method === 'POST') identity.checkCsrf(request, session);
      if (request.method === 'POST' && path === '/api/logout') {
        clearSession(session);
        return sendJson(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie('') });
      }
      if (path === '/api/conversations' && request.method === 'GET') {
        return sendJson(response, 200, {
          conversations: [...conversations.values()].filter(item => item.owner === session.id)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(summary),
        });
      }
      if (path === '/api/conversations' && request.method === 'POST') {
        requireThat([...conversations.values()].filter(item => item.owner === session.id).length < 10,
          'CONVERSATION_LIMIT', 'This preview keeps up to 10 conversations. Sign out to start a fresh session.', 429);
        const conversation = {
          id: randomUUID(), owner: session.id, title: 'New conversation',
          updatedAt: new Date().toISOString(), messages: [], context: {}, busy: false,
        };
        conversations.set(conversation.id, conversation);
        return sendJson(response, 201, summary(conversation));
      }
      if (path.startsWith('/api/conversations/') && request.method === 'GET') {
        const conversation = ownConversation(path.slice('/api/conversations/'.length), session);
        return sendJson(response, 200, { ...summary(conversation), messages: conversation.messages, busy: conversation.busy });
      }
      requireThat(path === '/api/chat' && request.method === 'POST', 'NOT_FOUND', 'Unknown endpoint.', 404);
      const input = await readJson(request);
      validate(chatSchema, input);
      requireThat(input.message.trim().length > 0, 'INVALID_INPUT', 'Enter a message first.');
      const conversation = ownConversation(input.conversationId, session);
      requireThat(!conversation.busy, 'TURN_IN_PROGRESS', 'A reply is already in progress for this conversation.', 409);
      requireThat(conversation.messages.length < 40, 'CONTEXT_LIMIT', 'Start a new conversation to continue.', 429);
      const window = rateWindows.get(session.id) ?? { started: Date.now(), count: 0 };
      requireThat(window.count < 20, 'RATE_LIMIT', 'You reached this preview’s per-minute limit. Please wait before trying again.', 429);
      window.count++;
      rateWindows.set(session.id, window);
      conversation.busy = true;
      const controller = new AbortController();
      conversation.controller = controller;
      activeTurns.add(controller);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(turnTimeoutMs)]);
      response.once('close', () => {
        if (!response.writableEnded) controller.abort();
      });
      const started = performance.now();
      const traceId = randomUUID();
      const stages = [];
      const userMessage = { id: randomUUID(), role: 'user', text: input.message.trim() };
      conversation.messages.push(userMessage);
      if (conversation.messages.length === 1) conversation.title = userMessage.text.slice(0, 52);
      const assistant = {
        id: randomUUID(), role: 'assistant', text: '', results: [], suggestions: [],
        issues: [], stages, traceId, durationMs: 0,
      };
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      response.flushHeaders();
      const send = event => {
        if (!identity.isActive(session.id)) {
          controller.abort();
          return;
        }
        if (!response.destroyed && !response.writableEnded) {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      };
      const emit = event => {
        identity.getSession(session.id);
        if (event.type === 'stage') {
          const previous = stages.findIndex(stage => stage.id === event.id);
          if (previous >= 0) stages[previous] = event;
          else stages.push(event);
        }
        if (event.type === 'result') assistant.results.push(event.result);
        send(event);
      };
      const heartbeat = setInterval(() => {
        if (!response.destroyed) response.write(': heartbeat\n\n');
      }, 5000);
      heartbeat.unref();
      try {
        audit({ event: 'turn_started', actorRef: identity.actorRef(session.principal), traceId, bundleDigest: registry.digest });
        send({ type: 'start', userMessage, assistantId: assistant.id, traceId, conversation: summary(conversation) });
        const result = await runChat({
          message: userMessage.text, context: conversation.context, session, signal, emit,
        });
        identity.getSession(session.id);
        signal.throwIfAborted();
        conversation.context = result.context;
        Object.assign(assistant, {
          text: result.text, results: result.results, issues: result.issues, suggestions: result.suggestions,
        });
        const pieces = assistant.text.match(/[\s\S]{1,48}/g) ?? [];
        for (const delta of pieces) {
          if (signal.aborted) break;
          send({ type: 'text', delta });
          await yieldToIo();
        }
      } catch (error) {
        const problem = controller.signal.aborted
          ? { code: 'CANCELLED', message: 'Response stopped. No business records were changed.' }
          : signal.aborted
            ? { code: 'TURN_TIMEOUT', message: 'This request took too long. Please try a more specific lookup.' }
            : publicError(error);
        assistant.text = problem.message;
        assistant.issues.push({ code: problem.code, message: problem.message });
        assistant.suggestions = [];
        const running = stages.find(stage => stage.state === 'running');
        if (running) {
          running.state = 'error';
          running.detail = problem.message;
        }
        send({ type: 'error', error: problem });
      } finally {
        clearInterval(heartbeat);
        assistant.durationMs = Math.round(performance.now() - started);
        conversation.messages.push(assistant);
        conversation.updatedAt = new Date().toISOString();
        conversation.busy = false;
        delete conversation.controller;
        activeTurns.delete(controller);
        send({ type: 'done', message: assistant, conversation: summary(conversation) });
        response.end();
      }
    }));
    servers.push(server);
    const origin = await listen(server, port);
    return {
      origin, gatewayOrigin, connectorOrigin, identity, registry, gateway, gatewayClient, connector,
      async close() {
        activeTurns.forEach(controller => controller.abort());
        await Promise.all([...servers].reverse().map(closeServer));
      },
    };
  } catch (error) {
    await Promise.all(servers.map(closeServer));
    throw error;
  }
}
