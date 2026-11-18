import { createHash, timingSafeEqual } from 'node:crypto';

export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

export function requireThat(condition, code, message, status = 400) {
  if (!condition) throw new AppError(code, message, status);
}

export const isObject = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const digest = value =>
  `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;

export function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseJson(text, code = 'INVALID_JSON') {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new AppError(code, 'The request must contain valid JSON.');
  }
}

export async function readJson(request, limit = 16_384) {
  requireThat(request.headers['content-type']?.split(';')[0] === 'application/json',
    'CONTENT_TYPE', 'Use application/json for this request.', 415);
  const chunks = [];
  let size = 0;
  await new Promise((resolve, reject) => {
    request.on('data', chunk => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
      else reject(new AppError('BODY_TOO_LARGE', 'The request is too large.', 413));
    });
    request.on('end', resolve);
    request.on('error', reject);
    request.on('aborted', () =>
      reject(new AppError('CANCELLED', 'The request was cancelled.', 499)));
  });
  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

export function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

export function publicError(error) {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  console.error(JSON.stringify({ event: 'unexpected_error', name: error?.name ?? 'Error' }));
  return { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.', status: 500 };
}

export function httpHandler(handler) {
  return (request, response) => {
    Promise.resolve().then(() => handler(request, response)).catch(error => {
      const problem = publicError(error);
      if (!response.headersSent) sendJson(response, problem.status, { error: problem });
      else if (!response.writableEnded) response.end();
    });
  };
}

export function checkLocalRequest(request) {
  const port = request.socket.localPort;
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  requireThat(hosts.includes(request.headers.host), 'HOST_DENIED',
    'This preview accepts loopback requests only.', 403);
  const origin = request.headers.origin;
  if (origin) {
    requireThat(hosts.some(host => origin === `http://${host}`), 'ORIGIN_DENIED',
      'Requests from another origin are not allowed.', 403);
  }
}

export function requireBrowserOrigin(request) {
  requireThat(request.headers.origin === `http://${request.headers.host}`,
    'ORIGIN_REQUIRED', 'A same-origin browser request is required.', 403);
}

export async function listen(server, port = 0) {
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

export async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

export function requestSignal(response) {
  const controller = new AbortController();
  response.once('close', () => {
    if (!response.writableEnded) controller.abort();
  });
  return controller.signal;
}
