import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  AppError, checkLocalRequest, httpHandler, isObject, parseJson,
  readJson, requireThat, sendJson,
} from './shared.mjs';
import { checkSchema, validate } from './schema.mjs';

export const MCP_VERSION = '2026-07-28';
const versionKey = 'io.modelcontextprotocol/protocolVersion';
const capabilitiesKey = 'io.modelcontextprotocol/clientCapabilities';
const serverInfoKey = 'io.modelcontextprotocol/serverInfo';

export function createMcpServer({ connector, identity, audience }) {
  connector.tools.forEach(tool => {
    checkSchema(tool.inputSchema);
    checkSchema(tool.outputSchema);
  });
  return createServer(httpHandler(async (request, response) => {
    checkLocalRequest(request);
    requireThat(request.method === 'POST' && request.url === '/mcp',
      'NOT_FOUND', 'Use POST /mcp for this connector.', 404);
    const session = identity.authenticate(request, audience);
    const message = await readJson(request);
    requireThat(message.jsonrpc === '2.0' &&
      (typeof message.id === 'string' || Number.isSafeInteger(message.id)) &&
      typeof message.method === 'string' && isObject(message.params),
    'INVALID_RPC', 'A JSON-RPC request with an ID and params is required.');
    const error = (code, text, data = undefined, status = 400) =>
      sendJson(response, status, { jsonrpc: '2.0', id: message.id, error: { code, message: text, data } });
    const meta = message.params._meta;
    if (!isObject(meta) || !isObject(meta[capabilitiesKey])) {
      return error(-32602, 'Protocol metadata and client capabilities are required.');
    }
    if (meta[versionKey] !== MCP_VERSION || request.headers['mcp-protocol-version'] !== MCP_VERSION) {
      return error(-32022, 'Unsupported protocol version.', {
        requested: meta[versionKey], supported: [MCP_VERSION],
      });
    }
    if (request.headers['mcp-method'] !== message.method ||
      (message.method === 'tools/call' && request.headers['mcp-name'] !== message.params.name)) {
      return error(-32020, 'MCP header and body values must match.');
    }
    const accepts = request.headers.accept ?? '';
    requireThat(accepts.includes('application/json') && accepts.includes('text/event-stream'),
      'NOT_ACCEPTABLE', 'The client must accept JSON and event streams.', 406);
    const info = {
      [serverInfoKey]: { name: connector.name, version: connector.version },
    };
    const complete = result => sendJson(response, 200, {
      jsonrpc: '2.0', id: message.id,
      result: { resultType: 'complete', _meta: info, ...result },
    });
    if (message.method === 'server/discover') {
      return complete({
        supportedVersions: [MCP_VERSION], capabilities: { tools: {} },
        ttlMs: 30_000, cacheScope: 'private',
      });
    }
    if (message.method === 'tools/list') {
      if (message.params.cursor) return error(-32602, 'This tool catalog has only one page.');
      return complete({
        tools: connector.canRead(session.principal)
          ? [...connector.tools].sort((a, b) => a.name.localeCompare(b.name)) : [],
        ttlMs: 30_000, cacheScope: 'private',
      });
    }
    if (message.method !== 'tools/call') return error(-32601, 'Method not supported.', undefined, 404);
    const tool = connector.tools.find(item => item.name === message.params.name);
    if (!tool) return error(-32602, 'Unknown tool.');
    try {
      validate(tool.inputSchema, message.params.arguments ?? {});
      const data = await connector.execute(tool.name, message.params.arguments ?? {}, session.principal);
      try {
        validate(tool.outputSchema, data, 'tool output');
      } catch (failure) {
        if (!(failure instanceof AppError)) throw failure;
        throw new AppError('INVALID_TOOL_OUTPUT',
          'The connector returned data outside its approved output schema.', 502);
      }
      return complete({
        content: [{ type: 'text', text: data.summary }],
        structuredContent: data, isError: false,
      });
    } catch (failure) {
      if (!(failure instanceof AppError)) throw failure;
      return complete({
        isError: true,
        content: [{ type: 'text', text: failure.message }],
        _meta: { ...info, 'one-door/error': { code: failure.code, status: failure.status } },
      });
    }
  }));
}

export async function boundedText(response, limit = 131_072) {
  const reader = response.body?.getReader();
  requireThat(reader, 'EMPTY_RESPONSE', 'The remote service returned an empty response.', 502);
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireThat(size <= limit, 'RESPONSE_TOO_LARGE', 'The remote result exceeded the size limit.', 502);
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel();
  }
}

export async function decodeRpc(response, id) {
  const text = await boundedText(response);
  const contentType = response.headers.get('content-type') ?? '';
  let message;
  if (contentType.includes('text/event-stream')) {
    const frames = text.replaceAll('\r\n', '\n').split('\n\n');
    for (const frame of frames) {
      const payload = frame.split('\n').filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n');
      if (!payload) continue;
      const item = parseJson(payload, 'INVALID_CONNECTOR_RESPONSE');
      if (item.id === id && (item.result || item.error)) message = item;
    }
  } else if (contentType.includes('application/json')) {
    message = parseJson(text, 'INVALID_CONNECTOR_RESPONSE');
  } else {
    throw new AppError('INVALID_CONNECTOR_RESPONSE', 'The connector returned an unsupported content type.', 502);
  }
  if (!response.ok) {
    const serviceError = message?.error;
    throw new AppError(
      typeof serviceError?.code === 'string' ? serviceError.code : 'CONNECTOR_UNAVAILABLE',
      response.status === 401 ? 'The connector rejected the delegated session.' :
        'The connector could not complete this request.',
      response.status === 401 || response.status === 403 ? response.status : 502,
    );
  }
  requireThat(message?.jsonrpc === '2.0' && message.id === id,
    'INVALID_CONNECTOR_RESPONSE', 'The connector response did not match this request.', 502);
  if (message.error) {
    throw new AppError('CONNECTOR_PROTOCOL_ERROR', 'The connector rejected the protocol request.', 502);
  }
  requireThat(message.result?.resultType === 'complete',
    'CONNECTOR_INTERACTION_UNSUPPORTED', 'This read-only MVP cannot complete the interaction requested by the connector.', 502);
  return message.result;
}

export async function mcpRequest({ endpoint, token, method, params = {}, signal, fetchImpl = fetch }) {
  const id = randomUUID();
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
    'MCP-Protocol-Version': MCP_VERSION,
    'Mcp-Method': method,
  };
  if (method === 'tools/call') headers['Mcp-Name'] = params.name;
  const response = await fetchImpl(endpoint, {
    method: 'POST', headers, redirect: 'error', signal,
    body: JSON.stringify({
      jsonrpc: '2.0', id, method,
      params: {
        ...params,
        _meta: {
          [versionKey]: MCP_VERSION,
          [capabilitiesKey]: {},
          'io.modelcontextprotocol/clientInfo': { name: 'OneDoor gateway', version: '0.1.0' },
        },
      },
    }),
  });
  return decodeRpc(response, id);
}
