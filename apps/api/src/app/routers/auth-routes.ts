import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  displayNameSchema,
  emailSchema,
  passwordSchema,
} from '@tapiz/board-commons/validators/auth.validator.js';
import {
  type AuthUserModel,
  withDefaultUserSettings,
} from '@tapiz/board-commons';
import db from '../db/index.js';
import { EmailTakenError, normalizeEmail } from '../db/user-db.js';
import { getServer } from '../global.js';
import { getAuthConfig } from '../auth/config.js';
import { generateToken, hashToken, isWellFormedToken } from '../auth/tokens.js';
import {
  PasswordHasherBusyError,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../auth/password.js';
import {
  clearSessionCookie,
  createSession,
  deleteAccountSessions,
  deleteSession,
  setSessionCookie,
} from '../auth/session.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../mailer.js';
import { logError } from '../log-error.js';

type Account = NonNullable<Awaited<ReturnType<typeof db.user.getUser>>>;

const RESET_TTL_MS = 60 * 60 * 1000;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

const registerBody = z.object({
  name: displayNameSchema,
  email: emailSchema,
  password: passwordSchema,
});

// no length rules on login: they would only tell which passwords can't exist
const loginBody = z.object({
  email: emailSchema,
  password: z.string().min(1).max(1024),
});

const passwordChangeBody = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: passwordSchema,
});

const resetRequestBody = z.object({ email: emailSchema });

const resetConfirmBody = z.object({
  token: z.string(),
  password: passwordSchema,
});

const verifyEmailBody = z.object({ token: z.string() });

const guestBody = z.object({
  name: displayNameSchema,
  boardId: z.uuid(),
});

// Only boards shared by link; private and missing boards look the same.
async function getLinkBoard(boardId: unknown) {
  const id = z.uuid().safeParse(boardId);

  if (!id.success) {
    return undefined;
  }

  const board = await db.board.getBoardBasic(id.data);

  return board?.public ? board : undefined;
}

export function toAuthUser(account: Account): AuthUserModel {
  return {
    id: account.id,
    name: account.name,
    picture: account.picture ?? '',
    email: account.email,
    isGuest: account.isGuest,
    emailVerified: !!account.emailVerifiedAt,
    settings: withDefaultUserSettings(account.settings),
  };
}

function emailKey(req: FastifyRequest) {
  const email = (req.body as { email?: unknown } | undefined)?.email;

  return hashToken(normalizeEmail(String(email ?? '')));
}

function isExceeded(
  limit: Awaited<ReturnType<ReturnType<FastifyInstance['createRateLimit']>>>,
) {
  return !limit.isAllowed && limit.isExceeded;
}

function sendError(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ error });
}

function sendKnownError(reply: FastifyReply, e: unknown) {
  if (e instanceof PasswordHasherBusyError) {
    return sendError(reply, 503, 'SERVER_BUSY');
  }

  if (e instanceof EmailTakenError) {
    return sendError(reply, 409, 'EMAIL_TAKEN');
  }

  throw e;
}

// Without SMTP the link is logged in development (or when explicitly asked),
// never in production logs by default.
async function deliverLink(
  kind: 'password reset' | 'email verification',
  to: string,
  link: string,
  send: () => Promise<boolean>,
) {
  if (await send()) {
    return;
  }

  if (
    process.env['NODE_ENV'] === 'development' ||
    process.env['AUTH_LOG_RESET_LINKS'] === 'true'
  ) {
    console.log(`Tapiz ${kind} link for ${to}: ${link}`);
  } else {
    console.warn(`Could not email the ${kind} link; configure SMTP.`);
  }
}

async function startEmailVerification(account: Account) {
  if (!account.email) {
    return;
  }

  const token = generateToken();

  await db.user.setEmailVerification(
    account.id,
    hashToken(token),
    VERIFY_TTL_MS,
  );

  const email = account.email;
  const link = `${getAuthConfig().frontendUrl}/verify-email#token=${token}`;

  void deliverLink('email verification', email, link, () =>
    // names who registered, so the owner of a borrowed address can tell
    sendVerificationEmail(email, link, account.name),
  ).catch(logError);
}

async function sendPasswordReset(email: string) {
  const account = await db.user.getUserByEmail(email);

  if (!account || account.isGuest || !account.email) {
    return;
  }

  const token = generateToken();

  await db.user.setPasswordReset(account.id, hashToken(token), RESET_TTL_MS);
  const to = account.email;
  // the token is in the fragment so it never reaches server logs or Referer
  const link = `${getAuthConfig().frontendUrl}/reset-password#token=${token}`;

  await deliverLink('password reset', to, link, () =>
    sendPasswordResetEmail(to, link),
  );
}

// The request's own session is replaced (login, reset) or ended (logout).
async function endCurrentSession(req: FastifyRequest, reason: string) {
  const sessionId =
    req.principal?.via === 'session' ? req.principal.sessionId : null;

  if (!sessionId) {
    return;
  }

  await deleteSession(sessionId);
  getServer()?.disconnectSessions([sessionId], reason);
}

async function startSession(reply: FastifyReply, accountId: string) {
  const session = await createSession(accountId, false);

  setSessionCookie(reply, session.token, session.expiresAt);

  return session;
}

// REST rather than tRPC: a tRPC batch shares one context, so a call batched
// after login would still run as the previous user.
export async function authRoutes(fastify: FastifyInstance) {
  // 10 per 15 minutes per email, counted before the password is checked, so
  // the right password does not get through once the limit is hit. This lets
  // anyone lock an email out of password logins for 15 minutes.
  const loginEmailLimit = fastify.createRateLimit({
    max: 10,
    timeWindow: '15 minutes',
    keyGenerator: emailKey,
  });

  const resetEmailLimit = fastify.createRateLimit({
    max: 3,
    timeWindow: '1 hour',
    keyGenerator: emailKey,
  });

  const verifyResendAccountLimit = fastify.createRateLimit({
    max: 3,
    timeWindow: '1 hour',
    keyGenerator: (req) => req.principal?.sub ?? req.ip,
  });

  fastify.addHook('onRequest', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  // Never 401, so the web app's bootstrap can't loop.
  fastify.get('/api/auth/session', async (req, reply) => {
    const principal = req.principal;

    if (!principal) {
      if (
        req.headers.authorization === undefined &&
        req.cookies[getAuthConfig().cookieName]
      ) {
        clearSessionCookie(reply);
      }

      return { user: null };
    }

    const account = await db.user.getUser(principal.sub);

    return { user: account ? toAuthUser(account) : null };
  });

  fastify.post(
    '/api/auth/register',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const principal = req.principal;

      if (principal && !principal.isGuest) {
        return sendError(reply, 409, 'ALREADY_SIGNED_IN');
      }

      const body = registerBody.safeParse(req.body);

      if (!body.success) {
        return sendError(reply, 400, 'INVALID_REQUEST');
      }

      const { name, email, password } = body.data;

      // reveals that the email has an account (accepted trade-off)
      if (await db.user.getUserByEmail(email)) {
        return sendError(reply, 409, 'EMAIL_TAKEN');
      }

      try {
        const passwordHash = await hashPassword(password);
        let account: Account;

        if (principal?.isGuest) {
          // upgraded in place: same id, so memberships and notes carry over
          const upgraded = await db.user.upgradeGuest(principal.sub, {
            name,
            email,
            passwordHash,
          });

          // a concurrent registration from the same guest won
          if (!upgraded) {
            return sendError(reply, 409, 'ALREADY_SIGNED_IN');
          }

          account = upgraded;
          await deleteAccountSessions(account.id);
        } else {
          account = await db.user.createAccount({ name, email, passwordHash });
        }

        const session = await startSession(reply, account.id);

        if (principal?.isGuest) {
          // live sockets keep going under the new identity
          getServer()?.updateIdentity(account.id, {
            name: account.name,
            isGuest: false,
            sessionId: session.sessionId,
          });
        }

        await startEmailVerification(account);

        return reply.code(201).send({ user: toAuthUser(account) });
      } catch (e) {
        return sendKnownError(reply, e);
      }
    },
  );

  fastify.get<{ Params: { boardId: string } }>(
    '/api/auth/board-link/:boardId',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const board = await getLinkBoard(req.params.boardId);

      if (!board) {
        return sendError(reply, 404, 'NOT_FOUND');
      }

      return { name: board.name };
    },
  );

  // Joins a board shared by link without an account.
  fastify.post(
    '/api/auth/guest',
    { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const body = guestBody.safeParse(req.body);

      if (!body.success) {
        return sendError(reply, 400, 'INVALID_REQUEST');
      }

      // checked before anything is created
      if (!(await getLinkBoard(body.data.boardId))) {
        return sendError(reply, 404, 'NOT_FOUND');
      }

      const principal = req.principal;

      if (principal && !principal.isGuest) {
        return sendError(reply, 409, 'ALREADY_SIGNED_IN');
      }

      // another tab already joined as a guest
      if (principal) {
        const account = await db.user.getUser(principal.sub);

        if (
          !account ||
          !(await db.board.ensureBoardMember(body.data.boardId, account.id))
        ) {
          return sendError(reply, 404, 'NOT_FOUND');
        }

        return { user: toAuthUser(account) };
      }

      const guest = await db.user.createGuest({ name: body.data.name });

      // link sharing was turned off meanwhile
      if (!(await db.board.ensureBoardMember(body.data.boardId, guest.id))) {
        await db.user.deleteAccount(guest.id);

        return sendError(reply, 404, 'NOT_FOUND');
      }

      const session = await createSession(guest.id, true);

      setSessionCookie(reply, session.token, session.expiresAt);

      return reply.code(201).send({ user: toAuthUser(guest) });
    },
  );

  fastify.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = loginBody.safeParse(req.body);

      if (!body.success) {
        return sendError(reply, 400, 'INVALID_REQUEST');
      }

      const { email, password } = body.data;

      try {
        const limited = isExceeded(await loginEmailLimit(req));
        const account = limited
          ? undefined
          : await db.user.getUserByEmail(email);
        const stored =
          account && !account.isGuest ? account.passwordHash : null;

        // always hashes, so unknown and limited emails take as long
        const valid = await verifyPassword(password, stored);

        if (!valid || !account || !stored) {
          return sendError(reply, 400, 'INVALID_CREDENTIALS');
        }

        // a guest identity is abandoned, not merged
        await endCurrentSession(req, 'session_ended');
        await startSession(reply, account.id);

        if (needsRehash(stored)) {
          void hashPassword(password)
            .then((hash) =>
              db.user.updatePasswordHash(account.id, stored, hash),
            )
            .catch(logError);
        }

        return { user: toAuthUser(account) };
      } catch (e) {
        return sendKnownError(reply, e);
      }
    },
  );

  fastify.post('/api/auth/logout', async (req, reply) => {
    await endCurrentSession(req, 'logged_out');
    clearSessionCookie(reply);

    return reply.code(204).send();
  });

  fastify.post(
    '/api/auth/password',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      const principal = req.principal;

      if (!principal) {
        return sendError(reply, 401, 'UNAUTHENTICATED');
      }

      if (principal.isGuest) {
        return sendError(reply, 403, 'ACCOUNT_REQUIRED');
      }

      if (principal.via !== 'session') {
        return sendError(reply, 403, 'SESSION_REQUIRED');
      }

      const body = passwordChangeBody.safeParse(req.body);

      if (!body.success) {
        return sendError(reply, 400, 'INVALID_REQUEST');
      }

      try {
        const account = await db.user.getUser(principal.sub);
        const valid = await verifyPassword(
          body.data.currentPassword,
          account?.passwordHash ?? null,
        );

        if (!account || !valid) {
          return sendError(reply, 400, 'INVALID_CREDENTIALS');
        }

        const oldSessionIds = await db.user.setPassword(
          account.id,
          await hashPassword(body.data.newPassword),
        );

        await startSession(reply, account.id);
        getServer()?.disconnectSessions(oldSessionIds, 'password_changed');

        return reply.code(204).send();
      } catch (e) {
        return sendKnownError(reply, e);
      }
    },
  );

  // Always 202, so it never tells whether an account exists.
  fastify.post(
    '/api/auth/password-reset/request',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      const body = resetRequestBody.safeParse(req.body);

      if (!body.success) {
        return sendError(reply, 400, 'INVALID_REQUEST');
      }

      // over the per-email limit, the request is dropped silently
      if (!isExceeded(await resetEmailLimit(req))) {
        void sendPasswordReset(body.data.email).catch(logError);
      }

      return reply.code(202).send({ ok: true });
    },
  );

  fastify.post(
    '/api/auth/password-reset/confirm',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      const body = resetConfirmBody.safeParse(req.body);

      if (!body.success) {
        return sendError(reply, 400, 'INVALID_REQUEST');
      }

      if (!isWellFormedToken(body.data.token)) {
        return sendError(reply, 400, 'INVALID_OR_EXPIRED_TOKEN');
      }

      try {
        const reset = await db.user.consumePasswordReset(
          hashToken(body.data.token),
          await hashPassword(body.data.password),
        );

        if (!reset) {
          return sendError(reply, 400, 'INVALID_OR_EXPIRED_TOKEN');
        }

        const { accountId } = reset;

        // the account's sessions are gone with the reset; this browser may be
        // signed in as someone else
        await endCurrentSession(req, 'session_ended');
        getServer()?.disconnectAccount(accountId, 'password_reset');

        await startSession(reply, accountId);

        const account = await db.user.getUser(accountId);

        return { user: account ? toAuthUser(account) : null };
      } catch (e) {
        return sendKnownError(reply, e);
      }
    },
  );

  // Needs a browser session of the account the link was sent for: anyone can
  // register someone else's address, and the owner's click must not verify
  // it for them. Without one the link is left unused (401 LOGIN_REQUIRED).
  fastify.post(
    '/api/auth/verify-email',
    { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      const body = verifyEmailBody.safeParse(req.body);

      if (!body.success || !isWellFormedToken(body.data.token)) {
        return sendError(reply, 400, 'INVALID_OR_EXPIRED_TOKEN');
      }

      const principal = req.principal;

      if (!principal || principal.isGuest || principal.via !== 'session') {
        return sendError(reply, 401, 'LOGIN_REQUIRED');
      }

      const verifyHash = hashToken(body.data.token);
      const accountId = await db.user.consumeEmailVerification(
        verifyHash,
        principal.sub,
      );

      if (!accountId) {
        // signed in as another account than the one the link is for
        return (await db.user.isEmailVerificationPending(verifyHash))
          ? sendError(reply, 401, 'LOGIN_REQUIRED')
          : sendError(reply, 400, 'INVALID_OR_EXPIRED_TOKEN');
      }

      const account = await db.user.getUser(accountId);

      if (!account) {
        return sendError(reply, 400, 'INVALID_OR_EXPIRED_TOKEN');
      }

      return { user: toAuthUser(account) };
    },
  );

  fastify.post(
    '/api/auth/verify-email/resend',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const principal = req.principal;

      if (!principal) {
        return sendError(reply, 401, 'UNAUTHENTICATED');
      }

      if (principal.isGuest) {
        return sendError(reply, 403, 'ACCOUNT_REQUIRED');
      }

      if (principal.via !== 'session') {
        return sendError(reply, 403, 'SESSION_REQUIRED');
      }

      const account = await db.user.getUser(principal.sub);

      if (!account) {
        return sendError(reply, 401, 'UNAUTHENTICATED');
      }

      if (account.emailVerifiedAt) {
        return reply.code(204).send();
      }

      if (isExceeded(await verifyResendAccountLimit(req))) {
        return sendError(reply, 429, 'RATE_LIMITED');
      }

      await startEmailVerification(account);

      return reply.code(202).send({ ok: true });
    },
  );
}
