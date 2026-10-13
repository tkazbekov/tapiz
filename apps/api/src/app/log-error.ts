import type { FastifyReply, FastifyRequest } from 'fastify';
import { DrizzleQueryError } from 'drizzle-orm';

function findQueryError(e: unknown) {
  // tRPC and our own wrappers keep the original error as `cause`
  for (let depth = 0; e instanceof Error && depth < 5; depth++) {
    if (e instanceof DrizzleQueryError) {
      return e;
    }

    e = e.cause;
  }

  return null;
}

function field(value: unknown, key: string) {
  return typeof value === 'object' && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

// drizzle puts the query params (password hashes, board state) in the
// message and stack of its errors, and wrappers such as TRPCError copy both.
// The driver error has them too (`parameters`, and `detail` repeats the
// conflicting value), so only picked fields are kept.
export function describeError(e: unknown): unknown {
  const queryError = findQueryError(e);

  if (!queryError) {
    return e;
  }

  const cause = queryError.cause;

  return {
    error: e instanceof Error ? e.name : typeof e,
    query: queryError.query,
    message: cause instanceof Error ? cause.message : undefined,
    code: field(cause, 'code'),
    constraint: field(cause, 'constraint_name'),
  };
}

export function logError(e: unknown, context?: string) {
  if (context) {
    console.error(context, describeError(e));
  } else {
    console.error(describeError(e));
  }
}

// Fastify error handler. Client errors (validation, rate limits, body size)
// keep their own reply. Anything else is logged here and answered
// generically: its message may be internal (drizzle's has the SQL and params).
export function internalErrorHandler(
  error: unknown,
  _request: FastifyRequest,
  reply: FastifyReply,
) {
  const statusCode = Number(field(error, 'statusCode') ?? 500);

  if (statusCode >= 400 && statusCode < 500) {
    throw error;
  }

  logError(error);

  return reply.code(500).send({
    statusCode: 500,
    error: 'Internal Server Error',
    message: 'Internal Server Error',
  });
}
