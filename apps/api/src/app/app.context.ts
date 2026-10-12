import { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import { FastifyInstance } from 'fastify';
import type { Principal } from './auth/principal.js';

// // prevent angular build errors
import '@fastify/rate-limit';
import '@fastify/cookie';

// `info` (TRPCRequestInfo) is only available inside tRPC requests; non-tRPC
// callers (file uploads, MCP) only have req/res.
type ContextRequestOptions = Pick<CreateFastifyContextOptions, 'req' | 'res'>;

// The principal is resolved once per HTTP request by the principal hook.
export async function createAppContext(
  app: FastifyInstance,
  rateLimits: Record<string, ReturnType<FastifyInstance['createRateLimit']>>,
  { req, res }: ContextRequestOptions,
) {
  const user: Principal | null = req.principal;

  return {
    req,
    res,
    app,
    rateLimits,
    user,
    correlationId: req.headers['correlation-id'] as string,
  };
}
export type AppContext = Awaited<ReturnType<typeof createAppContext>>;
