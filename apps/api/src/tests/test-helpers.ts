import { TRPCError } from '@trpc/server';
import { randEmail, randFirstName, randUuid } from '@ngneat/falso';
import { appRouter } from '../app/routers/index.js';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { Server as WsServer } from 'socket.io';
import customParser from 'socket.io-msgpack-parser';
import { createCallerFactory } from '../app/trpc.js';
import type { AppContext } from '../app/app.context.js';
import { Server } from '../app/server.js';
import db from '../app/db/index.js';
import { io } from 'socket.io-client';
import { setServer } from '../app/global.js';
import { createWsAllowRequest } from '../app/network.js';
import type { Principal } from '../app/auth/principal.js';
import { registerPrincipalHook } from '../app/auth/principal.js';
import { registerCsrfHook } from '../app/auth/csrf.js';
import { authRoutes } from '../app/routers/auth-routes.js';
import { fileUpload } from '../app/file-upload.js';
import { db as drizzleDb } from '../app/db/init-db.js';
import { accounts } from '../app/schema.js';
import { eq } from 'drizzle-orm';

export async function errorCall(call: () => Promise<unknown>) {
  try {
    await call();
  } catch (err) {
    if (err instanceof TRPCError) {
      return err;
    }
  }

  return null;
}

export const usersTest = [...Array(100)].map(() => {
  return {
    id: randUuid(),
    name: randFirstName(),
    email: randEmail().toLowerCase(),
  };
});

export const guestsTest = [...Array(20)].map(() => {
  return {
    id: randUuid(),
    name: randFirstName(),
  };
});

export const getAuth = (userIndex: number): Principal & { email: string } => {
  return {
    sub: usersTest[userIndex].id,
    name: usersTest[userIndex].name,
    email: usersTest[userIndex].email,
    picture: null,
    isGuest: false,
    emailVerified: true,
    via: 'session',
    sessionId: null,
  };
};

export const getGuestAuth = (guestIndex: number): Principal => {
  return {
    sub: guestsTest[guestIndex].id,
    name: guestsTest[guestIndex].name,
    email: null,
    picture: null,
    isGuest: true,
    emailVerified: false,
    via: 'session',
    sessionId: null,
  };
};

// Test accounts have a verified email, so email invitations reach them.
export const createUser = async (userIndex: number) => {
  const auth = getAuth(userIndex);

  await db.user.createAccount({
    id: auth.sub,
    name: auth.name,
    email: auth.email,
    passwordHash: null,
  });

  await drizzleDb
    .update(accounts)
    .set({ emailVerifiedAt: new Date() })
    .where(eq(accounts.id, auth.sub));
};

export const createGuest = async (guestIndex: number) => {
  const auth = getGuestAuth(guestIndex);

  await db.user.createGuest({ id: auth.sub, name: auth.name });
};

export const createMultipleUsers = async (size = usersTest.length) => {
  for (let index = 0; index < size; index++) {
    await createUser(index);
  }
};

// Test double: callers only need `user`; req/app are not wired, the reply
// only takes cookies and every rate limit allows the call.
export const createTestContext = (user: Principal | null): AppContext =>
  ({
    user,
    res: {
      setCookie: () => undefined,
      clearCookie: () => undefined,
    },
    rateLimits: {
      mentionBoardUser: async () => ({ isAllowed: true, isExceeded: false }),
    },
  }) as unknown as AppContext;

export const getUserCaller = (userIndex: number) => {
  const createCaller = createCallerFactory(appRouter);

  return createCaller(createTestContext(getAuth(userIndex)));
};

export const getGuestCaller = (guestIndex: number) => {
  const createCaller = createCallerFactory(appRouter);

  return createCaller(createTestContext(getGuestAuth(guestIndex)));
};

// The REST side of production wiring, for `inject`: cookies, CSRF and
// principal hooks, the rate limiter, auth and file routes.
export const buildAuthTestApp = async () => {
  const app = Fastify();

  await app.register(fastifyCookie, { hook: 'onRequest' });
  registerCsrfHook(app);
  registerPrincipalHook(app);
  await app.register(import('@fastify/rate-limit'), {
    max: 1000,
    timeWindow: '1 minute',
  });
  await app.register(authRoutes);
  await app.register(fileUpload);
  await app.ready();

  return app;
};

export const initTestServer = async (port: number): Promise<Server> => {
  const fastify = Fastify({
    logger: true,
    routerOptions: {
      maxParamLength: 5000,
    },
  });

  await fastify.register(fastifyCookie, {
    hook: 'onRequest',
    parseOptions: {},
  });

  const io = new WsServer(fastify.server, {
    allowRequest: createWsAllowRequest(),
    parser: customParser,
  });

  fastify.decorate('io', io);

  const server = new Server(io);
  setServer(server);

  io.on('connection', (socket) => {
    void server
      .connection(
        socket,
        fastify.parseCookie(socket.request.headers.cookie ?? ''),
      )
      .catch((e) => {
        console.error(e);
        socket.disconnect(true);
      });
  });

  await fastify.listen({ port });

  console.log(`http://localhost:${port}`);

  return server;
};

interface WsOptions {
  cookie?: string;
  origin?: string;
}

const connectWs = (
  port: number,
  { cookie = 'tapiz_session=1', origin }: WsOptions,
) => {
  return io(`ws://localhost:${port}`, {
    transports: ['websocket'],
    parser: customParser,
    extraHeaders: {
      Cookie: cookie,
      ...(origin ? { Origin: origin } : {}),
    },
  });
};

export const initWs = (
  port: number,
  options: WsOptions = {},
): Promise<ReturnType<typeof io>> => {
  return new Promise((resolve) => {
    const ws = connectWs(port, options);

    ws.on('connect', () => {
      resolve(ws);
    });

    ws.on('connect_error', console.error);
  });
};

// Resolves with whether the handshake was accepted.
export const tryWs = (port: number, options: WsOptions = {}) => {
  return new Promise<boolean>((resolve) => {
    const ws = connectWs(port, options);

    ws.on('connect', () => {
      ws.close();
      resolve(true);
    });

    ws.on('connect_error', () => {
      ws.close();
      resolve(false);
    });
  });
};

export const deleteTestBoards = async () => {
  for (let i = 0; i < usersTest.length; i++) {
    for (const board of await db.board.getAdminBoardIds(getAuth(i).sub)) {
      await db.board.deleteBoard(board.id);
    }
  }
};
