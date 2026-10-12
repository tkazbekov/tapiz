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

// Test double: callers only need `user`; req/res/app/rateLimits are not wired.
export const createTestContext = (
  user: ReturnType<typeof getAuth> | null,
): AppContext => ({ user }) as unknown as AppContext;

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
    parser: customParser,
  });

  fastify.decorate('io', io);

  const server = new Server(io);

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

export const initWs = (port: number): Promise<ReturnType<typeof io>> => {
  return new Promise((resolve) => {
    const ws = io(`ws://localhost:${port}`, {
      transports: ['websocket'],
      parser: customParser,
      extraHeaders: {
        Cookie: 'auth=1',
      },
    });

    ws.on('connect', () => {
      resolve(ws);
    });

    ws.on('connect_error', console.error);
  });
};
