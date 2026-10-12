import { middleware } from './trpc.js';
import { AppContext } from './app.context.js';
import { TRPCError } from '@trpc/server';
import type { FastifyRequest } from 'fastify';

// Accounts per account; guests per IP, since a new guest is one request away.
export const mentionRateLimitKey = (req: FastifyRequest) =>
  req.principal && !req.principal.isGuest
    ? `p:${req.principal.sub}`
    : `ip:${req.ip}`;

export const rateLimitedMiddleware = (
  rateLimitName: keyof AppContext['rateLimits'],
) =>
  middleware(async ({ ctx, next }) => {
    const checkRateLimit = ctx.rateLimits[rateLimitName];

    if (!checkRateLimit) {
      throw new Error(`Rate limit "${rateLimitName}" not found`);
    }

    const limit = await checkRateLimit(ctx.req);

    if (!limit.isAllowed && limit.isExceeded) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Rate limit exceeded',
      });
    }

    return next();
  });
