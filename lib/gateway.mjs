import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  AppError, checkLocalRequest, digest, httpHandler, readJson,
  requireThat, requestSignal, sendJson,
} from './shared.mjs';
import { checkSchema, object, text, validate } from './schema.mjs';
import { boundedText, mcpRequest, MCP_VERSION } from './mcp.mjs';
import { GATEWAY_AUDIENCE } from './identity.mjs';

const identifier = { ...text(80), pattern: '^[a-zA-Z0-9_-]+$' };
const invocationSchema = object({
  connectorId: identifier, toolName: identifier,
  args: { type: 'object', additionalProperties: true },
  bundleDigest: text(80), callId: { ...text(80), minLength: 1 },
});
const catalogSchema = object({ connectorId: identifier, bundleDigest: text(80) });

export function createGateway({
  registry, identity, bindings, audit = () => {},
  timeoutMs = 4000, concurrency = 4, failureThreshold = 3, cooldownMs = 15_000,
}) {
  const states = new Map();
  const disabled = new Set();
  for (const connector of registry.connectors) {
    const endpoint = bindings[connector.endpoint.binding];
    requireThat(endpoint, 'MISSING_BINDING', `Missing endpoint binding: ${connector.endpoint.binding}.`);
    const url = new URL(endpoint);
    requireThat(url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
      url.port && url.pathname === '/mcp' && !url.username && !url.password && !url.search && !url.hash,
    'ENDPOINT_DENIED', 'The local MVP only permits explicitly bound loopback MCP endpoints.');
  }

  function connectorFor(id, session) {
    const connector = registry.get(id);
    requireThat(connector && !disabled.has(id), 'CONNECTOR_DISABLED',
      'This connector is unavailable or disabled.', 503);
    requireThat(connector.tools.some(tool => session.principal.scopes.includes(tool.scope)),
      'ACCESS_DENIED', 'This account does not have access to that business unit.', 403);
    return connector;
  }

  async function protectedCall(connector, callerSignal, work) {
    const state = states.get(connector.id) ?? { active: 0, failures: 0, openUntil: 0 };
    states.set(connector.id, state);
    requireThat(state.openUntil <= Date.now(), 'CIRCUIT_OPEN',
      `${connector.display.name} is temporarily unavailable. Please try again shortly.`, 503);
    requireThat(state.active < concurrency, 'CONNECTOR_BUSY',
      `${connector.display.name} is busy. Please try again.`, 429);
    state.active++;
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]);
    try {
      const result = await work(signal);
      state.failures = 0;
      return result;
    } catch (error) {
      if (callerSignal.aborted) throw new AppError('CANCELLED', 'The request was cancelled.', 499);
      const failure = signal.aborted
        ? new AppError('CONNECTOR_TIMEOUT', `${connector.display.name} did not respond in time. No changes were made.`, 504)
        : error instanceof AppError ? error
          : new AppError('CONNECTOR_UNAVAILABLE', `${connector.display.name} could not be reached. Please try again.`, 502);
      if (failure.status >= 500) {
        state.failures++;
        if (state.failures >= failureThreshold) state.openUntil = Date.now() + cooldownMs;
      }
      throw failure;
    } finally {
      state.active--;
    }
  }

  async function definitions(connector, session, signal) {
    const endpoint = bindings[connector.endpoint.binding];
    const token = identity.issueToken(session, connector.auth.audience);
    const rpc = (method, params) => mcpRequest({ endpoint, token, method, params, signal });
    const discovery = await rpc('server/discover');
    requireThat(discovery.supportedVersions?.includes(MCP_VERSION) && discovery.capabilities?.tools,
      'CONNECTOR_INCOMPATIBLE', 'This connector does not support the approved MCP profile.', 502);
    const definitions = [];
    const cursors = new Set();
    let cursor;
    do {
      requireThat(cursors.size < 5, 'CATALOG_TOO_LARGE', 'The connector catalog exceeded its page budget.', 502);
      const page = await rpc('tools/list', cursor ? { cursor } : {});
      requireThat(Array.isArray(page.tools) && page.tools.length <= 100 &&
        ['public', 'private'].includes(page.cacheScope) && Number.isFinite(page.ttlMs) && page.ttlMs >= 0,
      'INVALID_CATALOG', 'The connector returned an invalid tool catalog.', 502);
      definitions.push(...page.tools);
      requireThat(definitions.length <= 100, 'CATALOG_TOO_LARGE', 'The tool catalog is too large.', 502);
      cursor = page.nextCursor;
      if (cursor) {
        requireThat(typeof cursor === 'string' && cursor.length <= 2048 && !cursors.has(cursor),
          'INVALID_CATALOG', 'The connector repeated an invalid catalog page.', 502);
        cursors.add(cursor);
      }
    } while (cursor);
    const names = new Set();
    for (const tool of definitions) {
      requireThat(typeof tool?.name === 'string' && !names.has(tool.name),
        'INVALID_CATALOG', 'The connector returned duplicate or invalid tools.', 502);
      names.add(tool.name);
    }
    return connector.tools.filter(tool => session.principal.scopes.includes(tool.scope)).map(approved => {
      const definition = definitions.find(tool => tool.name === approved.name);
      requireThat(definition && digest(definition) === approved.pin, 'TOOL_DRIFT',
        'A connector tool changed after approval. It is blocked until its definition is reviewed.', 503);
      checkSchema(definition.inputSchema);
      checkSchema(definition.outputSchema);
      return definition;
    });
  }

  const server = createServer(httpHandler(async (request, response) => {
    checkLocalRequest(request);
    requireThat(request.method === 'POST' && ['/catalog', '/invoke'].includes(request.url),
      'NOT_FOUND', 'Unknown gateway endpoint.', 404);
    const session = identity.authenticate(request, GATEWAY_AUDIENCE);
    const input = await readJson(request);
    validate(request.url === '/invoke' ? invocationSchema : catalogSchema, input);
    const record = {
      actorRef: identity.actorRef(session.principal),
      connectorId: input.connectorId, toolName: input.toolName,
      callId: input.callId, bundleDigest: registry.digest,
    };
    try {
      requireThat(input.bundleDigest === registry.digest, 'SNAPSHOT_MISMATCH',
        'The connector catalog changed. Reload the conversation before trying again.', 409);
      const connector = connectorFor(input.connectorId, session);
      if (request.url === '/invoke') {
        const approved = connector.tools.find(tool => tool.name === input.toolName);
        requireThat(approved && approved.risk === 'read' &&
          session.principal.scopes.includes(approved.scope),
        'TOOL_DENIED', 'This tool is not approved for this account. Only read-only tools are available.', 403);
      }
      const started = performance.now();
      const result = await protectedCall(connector, requestSignal(response), async signal => {
        const tools = await definitions(connector, session, signal);
        if (request.url === '/catalog') return { tools };
        const tool = tools.find(item => item.name === input.toolName);
        requireThat(tool, 'TOOL_DENIED', 'This tool is not available to the account.', 403);
        validate(tool.inputSchema, input.args);
        connectorFor(input.connectorId, session);
        audit({ ...record, event: 'tool_authorized', decision: 'allow' });
        const result = await mcpRequest({
          endpoint: bindings[connector.endpoint.binding],
          token: identity.issueToken(session, connector.auth.audience),
          method: 'tools/call', params: { name: input.toolName, arguments: input.args }, signal,
        });
        if (result.isError) {
          const detail = result._meta?.['one-door/error'];
          const message = result.content?.find(item => item.type === 'text')?.text;
          throw new AppError(detail?.code ?? 'TOOL_ERROR',
            typeof message === 'string' ? message.slice(0, 600) : 'The tool could not complete the request.',
            Number.isInteger(detail?.status) && detail.status >= 400 && detail.status <= 599 ? detail.status : 502);
        }
        try {
          validate(tool.outputSchema, result.structuredContent, 'tool output');
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          throw new AppError('INVALID_TOOL_OUTPUT', 'The connector returned data that did not match its approved schema.', 502);
        }
        const source = {
          connectorId: connector.id, name: connector.display.name, toolName: tool.name,
          asOf: result.structuredContent.asOf, pin: digest(tool),
          bundleDigest: registry.digest, sample: true,
        };
        return { data: result.structuredContent, source, elapsedMs: Math.round(performance.now() - started) };
      });
      if (request.url === '/invoke') audit({ ...record, event: 'tool_completed', decision: 'allow' });
      sendJson(response, 200, result);
    } catch (error) {
      audit({ ...record, event: 'gateway_rejected', decision: 'deny', code: error.code ?? 'INTERNAL_ERROR' });
      throw error;
    }
  }));
  return { server, disabled, states };
}

export function createGatewayClient({ origin, identity, registry }) {
  async function post(path, session, body, signal) {
    let response;
    try {
      response = await fetch(`${origin}${path}`, {
        method: 'POST', redirect: 'error', signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${identity.issueToken(session, GATEWAY_AUDIENCE)}`,
        },
        body: JSON.stringify({ ...body, bundleDigest: registry.digest }),
      });
    } catch (error) {
      if (signal?.aborted) throw new AppError('CANCELLED', 'The request was cancelled.', 499);
      if (error instanceof AppError) throw error;
      throw new AppError('GATEWAY_UNAVAILABLE', 'The connector gateway could not be reached.', 502);
    }
    const data = JSON.parse(await boundedText(response));
    if (!response.ok) {
      throw new AppError(data.error?.code ?? 'GATEWAY_ERROR',
        data.error?.message ?? 'The gateway rejected this request.', response.status);
    }
    return data;
  }
  return {
    catalog: (session, connectorId, signal) => post('/catalog', session, { connectorId }, signal),
    invoke: (session, connectorId, toolName, args, signal) => post('/invoke', session, {
      connectorId, toolName, args, callId: randomUUID(),
    }, signal),
  };
}
