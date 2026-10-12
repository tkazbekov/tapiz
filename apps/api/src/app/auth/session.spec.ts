import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, startDB } from '../db/init-db.js';
import { createAccount } from '../db/user-db.js';
import { sessions } from '../schema.js';
import { hashToken } from './tokens.js';
import {
  SESSION_TTL_MS,
  createSession,
  deleteAccountSessions,
  deleteExpiredSessions,
  validateSessionToken,
} from './session.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('sessions', () => {
  let accountId: string;

  const setTimes = (id: string, createdAgoMs: number, expiresInMs: number) =>
    db
      .update(sessions)
      .set({
        createdAt: sql`now() - ${createdAgoMs} * interval '1 millisecond'`,
        expiresAt: sql`now() + ${expiresInMs} * interval '1 millisecond'`,
      })
      .where(eq(sessions.id, id));

  const getRow = async (id: string) =>
    (await db.select().from(sessions).where(eq(sessions.id, id))).at(0);

  beforeAll(async () => {
    await startDB();

    accountId = (
      await createAccount({
        name: 'Session test',
        email: `${randomUUID()}@tapiz.test`,
        passwordHash: null,
      })
    ).id;
  });

  it('stores only the hash of the token', async () => {
    const session = await createSession(accountId, false);

    expect(session.token).toMatch(/^[\w-]{43}$/);
    expect(session.sessionId).toEqual(hashToken(session.token));
    expect(await getRow(session.sessionId)).toBeTruthy();
    expect(await getRow(session.token)).toBeUndefined();

    const validated = await validateSessionToken(session.token);

    expect(validated?.account.id).toEqual(accountId);
    expect(validated?.sessionId).toEqual(session.sessionId);
    expect(validated?.refreshed).toEqual(false);
    expect(
      Math.abs(
        session.expiresAt.getTime() - Date.now() - SESSION_TTL_MS.account,
      ),
    ).toBeLessThan(60_000);
  });

  it('rejects malformed and unknown tokens', async () => {
    for (const token of [
      undefined,
      '',
      'short',
      'x'.repeat(44),
      'a'.repeat(42) + '!',
      'a'.repeat(43),
    ]) {
      expect(await validateSessionToken(token)).toBeNull();
    }
  });

  it('deletes expired sessions when they are used', async () => {
    const session = await createSession(accountId, false);

    await setTimes(session.sessionId, DAY_MS, -1000);

    expect(await validateSessionToken(session.token)).toBeNull();
    expect(await getRow(session.sessionId)).toBeUndefined();
  });

  it('slides only below half the lifetime and never for young sessions', async () => {
    const session = await createSession(accountId, false);
    const halfLife = SESSION_TTL_MS.account / 2;

    await setTimes(session.sessionId, 2 * DAY_MS, halfLife + DAY_MS);
    expect((await validateSessionToken(session.token))?.refreshed).toEqual(
      false,
    );

    // young sessions were just rotated and are left alone
    await setTimes(session.sessionId, 1000, halfLife - DAY_MS);
    expect((await validateSessionToken(session.token))?.refreshed).toEqual(
      false,
    );

    await setTimes(session.sessionId, 2 * DAY_MS, halfLife - DAY_MS);
    expect(
      (await validateSessionToken(session.token, { slide: false }))?.refreshed,
    ).toEqual(false);

    const refreshed = await validateSessionToken(session.token);

    expect(refreshed?.refreshed).toEqual(true);
    expect(
      Math.abs(
        (refreshed?.expiresAt.getTime() ?? 0) -
          Date.now() -
          SESSION_TTL_MS.account,
      ),
    ).toBeLessThan(60_000);
  });

  it('deletes all sessions of an account but the kept one', async () => {
    const kept = await createSession(accountId, false);
    const other = await createSession(accountId, false);

    const deleted = await deleteAccountSessions(accountId, kept.sessionId);

    expect(deleted).toContain(other.sessionId);
    expect(deleted).not.toContain(kept.sessionId);
    expect(await validateSessionToken(other.token)).toBeNull();
    expect(await validateSessionToken(kept.token)).toBeTruthy();
  });

  it('collects expired sessions', async () => {
    const expired = await createSession(accountId, false);
    const live = await createSession(accountId, false);

    await setTimes(expired.sessionId, DAY_MS, -1000);

    const deleted = await deleteExpiredSessions();

    expect(deleted).toContain(expired.sessionId);
    expect(deleted).not.toContain(live.sessionId);
    expect(await getRow(live.sessionId)).toBeTruthy();
  });
});
