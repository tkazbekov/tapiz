import { inspect } from 'node:util';
import { vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { DrizzleQueryError } from 'drizzle-orm';
import Fastify from 'fastify';
import { describeError, internalErrorHandler, logError } from './log-error.js';

describe('logError', () => {
  const secretHash = 'scrypt$15$8$3$SECRETSALT$SECRETKEY';
  const secretEmail = 'secret@example.com';

  // shaped like postgres.js' PostgresError
  const driverError = () =>
    Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint_name: 'accounts_email_unique',
      detail: `Key (email)=(${secretEmail}) already exists.`,
      parameters: [secretEmail, secretHash],
    });

  const queryError = () =>
    new DrizzleQueryError(
      'insert into "accounts" ("email", "password_hash") values ($1, $2)',
      [secretEmail, secretHash],
      driverError(),
    );

  const logged = (e: unknown) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      logError(e, 'context');

      return spy.mock.calls
        .flat()
        .map((arg) => inspect(arg, { depth: 10, showHidden: true }))
        .join('\n');
    } finally {
      spy.mockRestore();
    }
  };

  it('never logs the params of a query error', () => {
    const output = logged(queryError());

    expect(output).not.toContain('SECRET');
    expect(output).not.toContain(secretEmail);
    expect(output).toContain('accounts_email_unique');
    expect(output).toContain('23505');
    expect(output).toContain('insert into "accounts"');
  });

  it('unwraps errors that carry a query error as their cause', () => {
    const wrapped = new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      cause: queryError(),
    });

    // tRPC copies the message (and so the params) into the wrapper
    expect(wrapped.message).toContain('SECRET');

    const output = logged(wrapped);

    expect(output).not.toContain('SECRET');
    expect(output).not.toContain(secretEmail);
    expect(describeError(wrapped)).toMatchObject({ error: 'TRPCError' });
  });

  it('logs other errors unchanged', () => {
    const error = new Error('plain failure');

    expect(describeError(error)).toBe(error);
    expect(logged(error)).toContain('plain failure');
  });

  it('answers unexpected errors generically and keeps client errors', async () => {
    const app = Fastify();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    app.setErrorHandler(internalErrorHandler);
    app.get('/crash', async () => {
      throw new Error("Cannot read properties of undefined (reading 'select')");
    });
    app.get('/query', async () => {
      throw queryError();
    });
    app.post(
      '/validated',
      { schema: { body: { type: 'object', required: ['name'] } } },
      async () => ({ ok: true }),
    );

    try {
      for (const url of ['/crash', '/query']) {
        const response = await app.inject({ method: 'GET', url });

        expect(response.statusCode).toEqual(500);
        expect(response.json()).toEqual({
          statusCode: 500,
          error: 'Internal Server Error',
          message: 'Internal Server Error',
        });
      }

      const invalid = await app.inject({
        method: 'POST',
        url: '/validated',
        payload: {},
      });

      expect(invalid.statusCode).toEqual(400);
      expect(invalid.json().message).toContain('name');
      expect(consoleError).toHaveBeenCalledTimes(2);
    } finally {
      consoleError.mockRestore();
      await app.close();
    }
  });
});
