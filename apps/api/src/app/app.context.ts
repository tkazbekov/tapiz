import { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import { getUser } from './db/user-db.js';
import { lucia, validateSession } from './auth.js';
import { FastifyInstance } from 'fastify';
import { authenticateApiToken } from './authenticate-api-token.js';

// // prevent angular build errors
import '@fastify/rate-limit';
import '@fastify/cookie';

// `info` (TRPCRequestInfo) is only available inside tRPC requests; non-tRPC
// callers (file uploads, MCP) only have req/res.
type ContextRequestOptions = Pick<CreateFastifyContextOptions, 'req' | 'res'>;

export async function createAuthContext({ req, res }: ContextRequestOptions) {
  function toAuthUser(dbUser: Awaited<ReturnType<typeof getUser>>) {
    if (!dbUser) {
      return null;
    }

    return {
      sub: dbUser.id,
      name: dbUser.name,
      email: dbUser.email,
      picture: dbUser.picture,
    };
  }

  async function getUserFromSessionCookie() {
    const cookies = req.cookies;

    const sessionId = cookies[lucia.sessionCookieName];

    if (sessionId) {
      const { session, user } = await validateSession(sessionId);

      if (!user) {
        return null;
      }

      try {
        if (session && session.fresh) {
          const sessionCookie = lucia.createSessionCookie(session.id);

          res.setCookie(
            sessionCookie.name,
            sessionCookie.value,
            sessionCookie.attributes,
          );
        }

        if (!session) {
          const sessionCookie = lucia.createBlankSessionCookie();
          res.setCookie(
            sessionCookie.name,
            sessionCookie.value,
            sessionCookie.attributes,
          );
        }
      } catch (err) {
        console.error('Error setting session cookie', err);
        return null;
      }

      const dbUser = await getUser(user.id);

      return toAuthUser(dbUser);
    }

    return null;
  }

  async function getUserFromApiToken() {
    const dbUser = await authenticateApiToken(req.headers.authorization);

    return toAuthUser(dbUser);
  }

  const user =
    (await getUserFromSessionCookie()) ?? (await getUserFromApiToken());

  return {
    user,
    correlationId: req.headers['correlation-id'] as string,
  };
}

export async function createAppContext(
  app: FastifyInstance,
  rateLimits: Record<string, ReturnType<FastifyInstance['createRateLimit']>>,
  { req, res }: ContextRequestOptions,
) {
  const authContext = await createAuthContext({ req, res });

  return {
    req,
    res,
    app,
    rateLimits,
    ...authContext,
  };
}
export type AppContext = Awaited<ReturnType<typeof createAppContext>>;
