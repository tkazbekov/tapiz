import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { accounts } from '../schema.js';
import { authenticateApiToken } from '../authenticate-api-token.js';
import { getAuthConfig } from './config.js';
import { setSessionCookie, validateSessionToken } from './session.js';

export interface Principal {
  sub: string;
  name: string;
  email: string | null;
  picture: string | null;
  isGuest: boolean;
  emailVerified: boolean;
  via: 'session' | 'api_token';
  // null for API tokens
  sessionId: string | null;
}

type Account = typeof accounts.$inferSelect;

export function toPrincipal(
  account: Account,
  via: Principal['via'],
  sessionId: string | null,
): Principal {
  return {
    sub: account.id,
    name: account.name,
    email: account.email,
    picture: account.picture,
    isGuest: account.isGuest,
    emailVerified: !!account.emailVerifiedAt,
    via,
    sessionId,
  };
}

// With an Authorization header only the Bearer token counts and the cookie is
// never read, which is what lets the CSRF hook exempt such requests.
// An invalid cookie is not cleared here: a late response for a rotated
// session would delete the new cookie.
export async function resolvePrincipal(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<Principal | null> {
  if (req.headers.authorization !== undefined) {
    const account = await authenticateApiToken(req.headers.authorization);

    return account ? toPrincipal(account, 'api_token', null) : null;
  }

  const token = req.cookies[getAuthConfig().cookieName];
  const session = await validateSessionToken(token);

  if (!session || !token) {
    return null;
  }

  if (session.refreshed) {
    setSessionCookie(reply, token, session.expiresAt);
  }

  return toPrincipal(session.account, 'session', session.sessionId);
}

// preParsing runs after the route's onRequest rate limit, so a flood is
// throttled before any session lookup, and before bodies are parsed.
export function registerPrincipalHook(fastify: FastifyInstance) {
  fastify.decorateRequest('principal', null);

  fastify.addHook('preParsing', async (req, reply) => {
    // MCP authenticates its own Bearer tokens
    if ((req.routeOptions.url ?? req.url).startsWith('/api/mcp')) {
      return;
    }

    req.principal = await resolvePrincipal(req, reply);
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}
