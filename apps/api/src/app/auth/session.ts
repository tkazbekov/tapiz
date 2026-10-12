import type { FastifyReply } from 'fastify';
import type { CookieSerializeOptions } from '@fastify/cookie';
import db from '../db/index.js';
import { getAuthConfig } from './config.js';
import { generateToken, hashToken, isWellFormedToken } from './tokens.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const SESSION_TTL_MS = {
  account: 30 * DAY_MS,
  // guests have no credentials to sign back in with
  guest: 180 * DAY_MS,
};

// A just-rotated session is not slid again, so a late response for it can't
// race the cookie set by the rotation.
const MIN_AGE_TO_REFRESH_MS = 60 * 1000;

function ttlFor(isGuest: boolean) {
  return isGuest ? SESSION_TTL_MS.guest : SESSION_TTL_MS.account;
}

export async function createSession(accountId: string, isGuest: boolean) {
  const token = generateToken();
  const sessionId = hashToken(token);
  const expiresAt = await db.session.insertSession(
    sessionId,
    accountId,
    ttlFor(isGuest),
  );

  return { token, sessionId, expiresAt };
}

// `slide: false` for sockets: they can't set the cookie, so extending the row
// there would desynchronise it from the browser's cookie.
export async function validateSessionToken(
  token?: string,
  { slide = true }: { slide?: boolean } = {},
) {
  if (!isWellFormedToken(token)) {
    return null;
  }

  const sessionId = hashToken(token);
  const session = await db.session.getSessionWithAccount(sessionId);

  if (!session) {
    return null;
  }

  if (session.expired) {
    await db.session.deleteSession(sessionId);

    return null;
  }

  const ttl = ttlFor(session.account.isGuest);
  let expiresAt = session.expiresAt;
  let refreshed = false;

  if (
    slide &&
    session.remainingMs < ttl / 2 &&
    session.ageMs >= MIN_AGE_TO_REFRESH_MS
  ) {
    const extended = await db.session.extendSession(sessionId, ttl);

    if (extended) {
      expiresAt = extended;
      refreshed = true;
    }
  }

  return { account: session.account, sessionId, expiresAt, refreshed };
}

export function deleteSession(sessionId: string) {
  return db.session.deleteSession(sessionId);
}

// Returns the deleted ids so their sockets can be disconnected.
export function deleteAccountSessions(accountId: string, exceptId?: string) {
  return db.session.deleteAccountSessions(accountId, exceptId);
}

export function deleteExpiredSessions() {
  return db.session.deleteExpiredSessions();
}

function cookieAttributes(): CookieSerializeOptions {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: getAuthConfig().cookieSecure,
  };
}

function sessionCookieAttributes(expiresAt: Date): CookieSerializeOptions {
  return {
    ...cookieAttributes(),
    maxAge: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
  };
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
) {
  reply.setCookie(
    getAuthConfig().cookieName,
    token,
    sessionCookieAttributes(expiresAt),
  );
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(getAuthConfig().cookieName, cookieAttributes());
}

// For the local agent route (agent-auth.ts).
export async function createSessionCookie(accountId: string) {
  const { token, expiresAt } = await createSession(accountId, false);

  return {
    name: getAuthConfig().cookieName,
    value: token,
    attributes: sessionCookieAttributes(expiresAt),
  };
}
