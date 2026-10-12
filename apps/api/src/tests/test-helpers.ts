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
    email: randEmail(),
    googleId: randUuid(),
  };
});

export const getAuth = (userIndex: number) => {
  return {
    sub: usersTest[userIndex].id,
    name: usersTest[userIndex].name,
    email: usersTest[userIndex].email,
    googleId: usersTest[userIndex].googleId,
  };
};

export const createUser = async (userIndex: number) => {
  const auth = getAuth(userIndex);

  await db.user.createUser(auth.sub, auth.name, auth.email, '', auth.googleId);
};

export const createMultipleUsers = async (size = usersTest.length) => {
  for (let index = 0; index < size; index++) {
    await createUser(index);
  }
};

// Test double: callers only need `user`; req/res/app are not wired and every
// rate limit allows the call.
export const createTestContext = (
  user: ReturnType<typeof getAuth> | null,
): AppContext =>
  ({
    user,
    rateLimits: {
      mentionBoardUser: async () => ({ isAllowed: true, isExceeded: false }),
    },
  }) as unknown as AppContext;

export const getUserCaller = (userIndex: number) => {
  const createCaller = createCallerFactory(appRouter);

  return createCaller(createTestContext(getAuth(userIndex)));
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
    server.connection(
      socket,
      fastify.parseCookie(socket.request.headers.cookie ?? ''),
    );
  });

  await fastify.listen({ port });

  console.log(`http://localhost:${port}`);

  return server;
};

interface WsOptions {
  cookie?: string;
  origin?: string;
}

const connectWs = (port: number, { cookie = 'auth=1', origin }: WsOptions) => {
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
