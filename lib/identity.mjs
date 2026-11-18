import { createHmac, randomBytes } from 'node:crypto';
import { AppError, freeze, parseJson, requireThat, safeEqual } from './shared.mjs';

export const GATEWAY_AUDIENCE = 'urn:one-door:gateway';
export const personas = freeze([
  {
    id: 'avery-acme', name: 'Avery Morgan', initials: 'AM',
    organizationId: 'acme', organization: 'Acme Industrial',
    scopes: ['finance:read'],
  },
  {
    id: 'jordan-northstar', name: 'Jordan Lee', initials: 'JL',
    organizationId: 'northstar', organization: 'Northstar Studio',
    scopes: ['finance:read'],
  },
  {
    id: 'sam-cobalt', name: 'Sam Rivera', initials: 'SR',
    organizationId: 'cobalt', organization: 'Cobalt Labs',
    scopes: [],
  },
]);

export function createDemoIdentity({ audiences, now = Date.now, sessionTtlMs = 3_600_000 } = {}) {
  const sessions = new Map();
  const keys = new Map(audiences.map(audience => [audience, randomBytes(32)]));
  const auditKey = randomBytes(32);

  function expireSessions() {
    for (const [id, session] of sessions) {
      if (session.expiresAt <= now()) sessions.delete(id);
    }
  }

  function getSession(id) {
    const session = sessions.get(id);
    if (session && session.expiresAt > now()) return session;
    if (session) sessions.delete(id);
    throw new AppError('SIGN_IN_REQUIRED', 'Choose a demo account to continue.', 401);
  }

  function createSession(personaId) {
    const principal = personas.find(persona => persona.id === personaId);
    requireThat(principal, 'UNKNOWN_ACCOUNT', 'Choose one of the listed demo accounts.');
    expireSessions();
    requireThat(sessions.size < 100, 'SESSION_LIMIT', 'The local session limit has been reached.', 429);
    const session = {
      id: randomBytes(32).toString('base64url'),
      csrf: randomBytes(24).toString('base64url'),
      expiresAt: now() + sessionTtlMs,
      principal,
    };
    sessions.set(session.id, session);
    return session;
  }

  function sessionFromRequest(request) {
    const id = request.headers.cookie?.split(';').map(part => part.trim())
      .find(part => part.startsWith('one_door_session='))?.slice('one_door_session='.length);
    return getSession(id);
  }

  function checkCsrf(request, session) {
    requireThat(safeEqual(request.headers['x-csrf-token'], session.csrf),
      'CSRF_DENIED', 'The session token changed. Reload the page and try again.', 403);
  }

  function issueToken(session, audience) {
    getSession(session.id);
    const key = keys.get(audience);
    requireThat(key, 'AUDIENCE_DENIED', 'This service is not registered.', 403);
    const payload = Buffer.from(JSON.stringify({
      iss: 'urn:one-door:local-demo',
      aud: audience, sid: session.id, sub: session.principal.id,
      organizationId: session.principal.organizationId,
      scopes: session.principal.scopes,
      exp: Math.min(session.expiresAt, now() + 60_000),
    })).toString('base64url');
    return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
  }

  function verifyToken(token, audience) {
    requireThat(typeof token === 'string' && token.length < 4096,
      'TOKEN_INVALID', 'A valid service token is required.', 401);
    const parts = token.split('.');
    const key = keys.get(audience);
    requireThat(key && parts.length === 2, 'TOKEN_INVALID', 'Invalid service token.', 401);
    const [payload, signature] = parts;
    requireThat(safeEqual(signature, createHmac('sha256', key).update(payload).digest('base64url')),
      'TOKEN_INVALID', 'Invalid service token.', 401);
    const claims = parseJson(Buffer.from(payload, 'base64url').toString('utf8'), 'TOKEN_INVALID');
    requireThat(claims.iss === 'urn:one-door:local-demo' && claims.aud === audience &&
      Number.isFinite(claims.exp) && claims.exp > now(),
    'TOKEN_INVALID', 'The service token is expired or has the wrong audience.', 401);
    const session = getSession(claims.sid);
    requireThat(claims.sub === session.principal.id &&
      claims.organizationId === session.principal.organizationId,
    'TOKEN_INVALID', 'The service identity does not match the session.', 401);
    return session;
  }

  function authenticate(request, audience) {
    const authorization = request.headers.authorization;
    requireThat(authorization?.startsWith('Bearer '), 'TOKEN_REQUIRED',
      'This endpoint requires a service token.', 401);
    return verifyToken(authorization.slice(7), audience);
  }

  return {
    createSession, getSession, sessionFromRequest, checkCsrf, issueToken, verifyToken, authenticate,
    revoke: id => sessions.delete(id),
    actorRef: principal => createHmac('sha256', auditKey).update(principal.id).digest('hex').slice(0, 16),
    isActive: id => sessions.has(id) && sessions.get(id).expiresAt > now(),
  };
}

export const sessionCookie = id =>
  `one_door_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${id ? 3600 : 0}`;
