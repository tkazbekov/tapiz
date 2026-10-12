import Fastify from 'fastify';
import { createAppContext } from './app.context.js';
import { AppRouter, appRouter } from './routers/index.js';
import fastifyCookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { Server as WsServer } from 'socket.io';
import customParser from 'socket.io-msgpack-parser';

import {
  fastifyTRPCPlugin,
  FastifyTRPCPluginOptions,
} from '@trpc/server/adapters/fastify';
import { Server } from './server.js';
import { setServer } from './global.js';
import { authRoutes } from './routers/auth-routes.js';
import { registerCsrfHook } from './auth/csrf.js';
import { registerPrincipalHook } from './auth/principal.js';
import { createSessionCookie, deleteExpiredSessions } from './auth/session.js';
import { fileUpload } from './file-upload.js';
import { registerTapizMcp } from './mcp.js';
import { registerAgentSessionRoute } from './agent-auth.js';
import { authenticateApiToken } from './authenticate-api-token.js';
import { mentionRateLimitKey } from './rate-limited.js';
import db from './db/index.js';
import {
  createWsAllowRequest,
  getFrontendOrigin,
  parseTrustProxy,
} from './network.js';

const trustProxy = parseTrustProxy(process.env['TRUST_PROXY']);

if (trustProxy !== false) {
  console.warn(
    `TRUST_PROXY=${process.env['TRUST_PROXY']}: client IPs come from X-Forwarded-For. ` +
      'Only enable it when the API port is reachable through the proxy alone.',
  );
}

const frontendOrigin = getFrontendOrigin();

if (!frontendOrigin) {
  console.warn('FRONTEND_URL is not set; cross-origin requests are rejected.');
}

const fastify = Fastify({
  logger: false,
  trustProxy,
  routerOptions: {
    maxParamLength: 5000,
  },
});

// No connectionStateRecovery: recovered sockets would skip re-validation;
// the web client re-joins its board on reconnect instead.
fastify.decorate(
  'io',
  new WsServer(fastify.server, {
    allowRequest: createWsAllowRequest(),
    cors: {
      credentials: true,
      origin: frontendOrigin ?? false,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    },
    parser: customParser,
  }),
);

fastify.addHook('preClose', (done) => {
  fastify.io.local.disconnectSockets(true);
  done();
});

fastify.addHook('onClose', (instance, done) => {
  void instance.io.close();
  done();
});

// Order matters: cookies are parsed first and CORS runs before the rate
// limiter so 429 responses still carry CORS headers.
await fastify.register(fastifyCookie, {
  hook: 'onRequest',
  parseOptions: {},
});

await fastify.register(cors, {
  credentials: true,
  origin: frontendOrigin ?? false,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
});

// Instance hooks: CSRF at onRequest, the principal at preParsing (after the
// routes' onRequest rate limit, before body parsing). Child plugins below
// inherit them.
registerCsrfHook(fastify);
registerPrincipalHook(fastify);

// The default key is the client IP (IPv6 grouped by /64), so a made-up cookie
// no longer gets a fresh bucket.
await fastify.register(import('@fastify/rate-limit'), {
  max: 150,
  timeWindow: '1 minute',
});

const rateLimits = {
  mentionBoardUser: fastify.createRateLimit({
    max: 50,
    timeWindow: '1 minute',
    keyGenerator: mentionRateLimitKey,
  }),
};

fastify.register(fileUpload);
fastify.register(authRoutes);

fastify.register(fastifyTRPCPlugin, {
  prefix: '/api/trpc',
  trpcOptions: {
    router: appRouter,
    createContext: ({ req, res }) => {
      return createAppContext(fastify, rateLimits, {
        req,
        res,
      });
    },
    onError({ path, error }) {
      console.error(`Error in tRPC handler on path '${path}':`, error);
    },
  } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
});

fastify.register(async function (fastify) {
  let server: Server | null = null;

  registerTapizMcp(fastify, () => {
    if (!server) {
      server = new Server(fastify.io);
      setServer(server);
    }

    return server;
  });

  fastify.ready((err) => {
    if (err) throw err;

    if (!server) {
      server = new Server(fastify.io);
      setServer(server);
    }

    const boardServer = server;

    fastify.io.on('connection', (socket) => {
      void boardServer
        .connection(
          socket,
          fastify.parseCookie(socket.request.headers.cookie ?? ''),
        )
        .catch((e) => {
          console.error(e);
          socket.disconnect(true);
        });
    });
  });

  // expired sessions lose their open sockets too
  const sessionGc = setInterval(() => {
    void deleteExpiredSessions()
      .then((ids) => server?.disconnectSessions(ids, 'session_expired'))
      .catch((e) => console.error(e));
  }, 3600e3);

  sessionGc.unref();

  fastify.addHook('onClose', (_instance, done) => {
    clearInterval(sessionGc);
    done();
  });

  registerAgentSessionRoute(fastify, {
    environment: process.env,
    authenticateApiToken,
    haveBoardAccess: db.board.haveAccess,
    // mints `via: 'session'` cookies, so the token holder passes
    // requireSessionAuth; development only
    createSessionCookie,
  });
});

const host = process.env['API_HOST'];

export function startApiServer() {
  fastify.listen(
    {
      port: Number(process.env['API_PORT']),
      host: host === 'localhost' ? '0.0.0.0' : host,
    },
    (err) => {
      if (err) throw err;

      console.log(`http://localhost:${process.env['API_PORT']}`);
    },
  );
}

// process.on('uncaughtException', (err) => {
//   console.error('❌ Uncaught Exception:', err);
// });

// process.on('unhandledRejection', (reason, promise) => {
//   console.error('⚠️ Unhandled Rejection:', reason);
// });
