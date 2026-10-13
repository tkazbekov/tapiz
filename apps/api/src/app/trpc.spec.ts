import { TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { DrizzleQueryError } from 'drizzle-orm';
import type { AppContext } from './app.context.js';
import { publicProcedure, router } from './trpc.js';

describe('trpc error responses', () => {
  const testRouter = router({
    queryError: publicProcedure.query(() => {
      throw new DrizzleQueryError(
        'select * from "accounts" where "id" = $1',
        ['SECRET_PARAM'],
        new Error('SECRET_DRIVER_MESSAGE'),
      );
    }),
    crash: publicProcedure.query(() => {
      throw new Error('SECRET_INTERNAL_DETAIL');
    }),
    notFound: publicProcedure.query(() => {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'board not found' });
    }),
  });

  const call = async (path: string) => {
    const response = await fetchRequestHandler({
      endpoint: '/trpc',
      req: new Request(`http://tapiz.test/trpc/${path}`),
      router: testRouter,
      createContext: () => ({}) as AppContext,
      onError: () => undefined,
    });

    return { status: response.status, body: await response.text() };
  };

  // vitest runs with NODE_ENV=test, where tRPC would add stacks by default
  it('never sends stacks, SQL, params or internal messages', async () => {
    for (const path of ['queryError', 'crash']) {
      const { status, body } = await call(path);

      expect(status).toEqual(500);
      expect(body).not.toContain('SECRET');
      expect(body).not.toContain('stack');
      expect(body).not.toContain('select');
      expect(JSON.parse(body).error.message).toEqual('Internal server error');
    }
  });

  it('keeps the message of expected errors', async () => {
    const { status, body } = await call('notFound');

    expect(status).toEqual(404);
    expect(JSON.parse(body).error.message).toEqual('board not found');
    expect(body).not.toContain('stack');
  });
});
