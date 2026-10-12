import type { FastifyInstance } from 'fastify';
import { getAuthConfig } from './config.js';

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

// Cookie-authenticated requests must come from the web app. Requests with an
// Authorization header never read the cookie (see resolvePrincipal), so they
// are exempt. /api/mcp checks origins and Bearer tokens itself.
export function registerCsrfHook(
  fastify: FastifyInstance,
  { cookieName, allowedOrigins } = getAuthConfig(),
) {
  fastify.addHook('onRequest', async (req, reply) => {
    // the matched route pattern, since the router decodes the URL first and
    // /%61pi/... reaches the /api/... handlers
    const path = req.routeOptions.url ?? req.url.split('?')[0];

    if (
      !path.startsWith('/api/') ||
      path.startsWith('/api/mcp') ||
      req.headers.authorization !== undefined
    ) {
      return;
    }

    const hasCookie = !!req.cookies[cookieName];

    // also covers GETs with side effects, such as board.board joining a board
    if (hasCookie && req.headers['sec-fetch-site'] === 'cross-site') {
      return reply.code(403).send({ error: 'CROSS_SITE_REQUEST' });
    }

    if (safeMethods.has(req.method)) {
      return;
    }

    // /api/auth/* without a cookie too, which blocks login CSRF
    if (hasCookie || path.startsWith('/api/auth/')) {
      const origin = req.headers.origin;

      if (!origin || !allowedOrigins.has(origin)) {
        return reply.code(403).send({ error: 'ORIGIN_NOT_ALLOWED' });
      }
    }
  });
}
