import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { vi } from 'vitest';
import { db as drizzleDb, startDB } from '../app/db/init-db';
import db from '../app/db';
import { accounts, sessions } from '../app/schema';
import { appRouter } from '../app/routers';
import { createCallerFactory } from '../app/trpc';
import { toPrincipal } from '../app/auth/principal';
import { createSession } from '../app/auth/session';
import { hashApiToken } from '../app/api-token';
import { EmailTakenError } from '../app/db/user-db';
import {
  buildAuthTestApp,
  createMultipleUsers,
  createTestContext,
  getUserCaller,
} from './test-helpers';

const mail = vi.hoisted(() => ({
  reset: vi.fn(),
  verify: vi.fn(),
}));

vi.mock('../app/mailer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app/mailer')>();

  return {
    ...actual,
    sendPasswordResetEmail: async (to: string, link: string) => {
      mail.reset(to, link);
      return true;
    },
    sendVerificationEmail: async (to: string, link: string, name: string) => {
      mail.verify(to, link, name);
      return true;
    },
  };
});

const origin = process.env['FRONTEND_URL'] ?? '';
const password = 'correct horse battery';
const userKeys = [
  'email',
  'emailVerified',
  'id',
  'isGuest',
  'name',
  'picture',
  'settings',
];

let ipSeq = 0;
// every test gets its own client IP, so per-IP limits don't interfere
const nextIp = () => `10.20.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

const newEmail = () => `${randomUUID()}@tapiz.test`;

const sessionCookie = (response: LightMyRequestResponse) =>
  response.cookies.find((cookie) => cookie.name === 'tapiz_session');

const tokenFrom = (link: string) => new URL(link).hash.replace('#token=', '');

describe('auth routes', () => {
  let app: FastifyInstance;

  const post = (
    url: string,
    payload: object,
    {
      cookie,
      ip = '10.0.0.1',
      headers = {},
    }: { cookie?: string; ip?: string; headers?: Record<string, string> } = {},
  ) =>
    app.inject({
      method: 'POST',
      url,
      payload,
      remoteAddress: ip,
      headers: {
        origin,
        ...(cookie ? { cookie: `tapiz_session=${cookie}` } : {}),
        ...headers,
      },
    });

  const getSession = (cookie?: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: {
        ...(cookie ? { cookie: `tapiz_session=${cookie}` } : {}),
        ...headers,
      },
    });

  const register = async (
    email = newEmail(),
    { cookie, ip = nextIp() }: { cookie?: string; ip?: string } = {},
  ) => {
    const response = await post(
      '/api/auth/register',
      { name: 'Ana', email, password },
      { cookie, ip },
    );

    return {
      response,
      email,
      cookie: sessionCookie(response)?.value ?? '',
      user: response.json().user,
    };
  };

  const login = (email: string, pw = password, ip = nextIp()) =>
    post('/api/auth/login', { email, password: pw }, { ip });

  const currentUser = async (cookie: string) =>
    (await getSession(cookie)).json().user;

  beforeAll(async () => {
    await startDB();
    await createMultipleUsers(3);
    app = await buildAuthTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mail.reset.mockClear();
    mail.verify.mockClear();
  });

  describe('register', () => {
    it('signs the new account in with a hardened cookie', async () => {
      const { response, email, cookie, user } = await register();

      expect(response.statusCode).toEqual(201);
      expect(response.headers['cache-control']).toEqual('no-store');
      expect(Object.keys(user).sort()).toEqual(userKeys);
      expect(user).toMatchObject({
        name: 'Ana',
        email,
        isGuest: false,
        emailVerified: false,
      });

      const setCookie = String(response.headers['set-cookie']);

      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).toContain('Path=/');
      expect(setCookie).not.toContain('Secure');
      expect(sessionCookie(response)?.maxAge).toBeGreaterThan(29 * 86400);

      expect(await currentUser(cookie)).toEqual(user);
    });

    it('marks the cookie Secure for an https API', async () => {
      vi.stubEnv('API_URL', 'https://api.tapiz.test/api');

      try {
        const { response } = await register();

        expect(sessionCookie(response)?.secure).toEqual(true);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('rejects taken emails, signed-in accounts and bad input', async () => {
      const { email, cookie } = await register();

      const taken = await register(`  ${email.toUpperCase()} `);

      expect(taken.response.statusCode).toEqual(409);
      expect(taken.response.json()).toEqual({ error: 'EMAIL_TAKEN' });

      const signedIn = await register(newEmail(), { cookie });

      expect(signedIn.response.statusCode).toEqual(409);
      expect(signedIn.response.json()).toEqual({ error: 'ALREADY_SIGNED_IN' });

      const invalid = await post(
        '/api/auth/register',
        { name: 'Ana', email: newEmail(), password: 'short' },
        { ip: nextIp() },
      );

      expect(invalid.statusCode).toEqual(400);
    });

    it('maps a racing duplicate insert to EMAIL_TAKEN', async () => {
      const email = newEmail();

      await db.user.createAccount({ name: 'First', email, passwordHash: null });

      await expect(
        db.user.createAccount({
          name: 'Second',
          email: email.toUpperCase(),
          passwordHash: null,
        }),
      ).rejects.toBeInstanceOf(EmailTakenError);
    });

    it('upgrades a guest in place', async () => {
      const owner = await getUserCaller(0);
      const board = await owner.board.create({ name: 'guest board' });
      await owner.board.changePrivacy({ boardId: board.id, isPublic: true });

      const guest = await db.user.createGuest({ name: 'Guest Ana' });
      const guestSession = await createSession(guest.id, true);

      await db.board.ensureBoardMember(board.id, guest.id);
      await db.user.mentionUser(board.id, guest.id);

      const { response, cookie, user, email } = await register(newEmail(), {
        cookie: guestSession.token,
      });

      expect(response.statusCode).toEqual(201);
      expect(user).toMatchObject({
        id: guest.id,
        isGuest: false,
        email,
        emailVerified: false,
      });
      expect(mail.verify).toHaveBeenCalledWith(
        email,
        expect.stringContaining('/verify-email#token='),
        'Ana',
      );
      expect(cookie).not.toEqual(guestSession.token);
      expect(await currentUser(guestSession.token)).toBeNull();
      expect((await currentUser(cookie))?.id).toEqual(guest.id);
      expect(await db.board.getBoardUser(board.id, guest.id)).toBeTruthy();
      expect(await db.user.getUserNotifications(guest.id)).toHaveLength(1);
    });

    it('lets only one of two concurrent upgrades win', async () => {
      const guest = await db.user.createGuest({ name: 'Racer' });
      const guestSession = await createSession(guest.id, true);

      const results = await Promise.all([
        register(newEmail(), { cookie: guestSession.token }),
        register(newEmail(), { cookie: guestSession.token }),
      ]);

      expect(results.map((it) => it.response.statusCode).sort()).toEqual([
        201, 409,
      ]);
    });
  });

  describe('guests', () => {
    let publicBoardId: string;
    let privateBoardId: string;

    const guestName = () => `Guest ${randomUUID().slice(0, 8)}`;

    const joinAsGuest = (
      boardId: string,
      { name = guestName(), cookie }: { name?: string; cookie?: string } = {},
    ) => post('/api/auth/guest', { name, boardId }, { cookie, ip: nextIp() });

    const boardLink = (boardId: string) =>
      app.inject({
        method: 'GET',
        url: `/api/auth/board-link/${boardId}`,
        remoteAddress: nextIp(),
      });

    beforeAll(async () => {
      const owner = getUserCaller(0);

      publicBoardId = (await owner.board.create({ name: 'link board' })).id;
      privateBoardId = (await owner.board.create({ name: 'secret board' })).id;

      await owner.board.changePrivacy({
        boardId: publicBoardId,
        isPublic: true,
      });
    });

    it('tells only whether a board is shared by link', async () => {
      const shared = await boardLink(publicBoardId);

      expect(shared.statusCode).toEqual(200);
      expect(shared.json()).toEqual({ name: 'link board' });

      for (const id of [privateBoardId, randomUUID(), 'not-a-uuid']) {
        const response = await boardLink(id);

        expect(response.statusCode).toEqual(404);
        expect(response.json()).toEqual({ error: 'NOT_FOUND' });
      }
    });

    it('creates nothing for boards that are not shared', async () => {
      for (const boardId of [privateBoardId, randomUUID()]) {
        const name = guestName();
        const response = await joinAsGuest(boardId, { name });

        expect(response.statusCode).toEqual(404);
        expect(sessionCookie(response)).toBeUndefined();
        expect(await db.user.getUserByName(name)).toBeUndefined();
      }
    });

    it('joins a shared board with a guest session', async () => {
      const name = guestName();
      const response = await joinAsGuest(publicBoardId, { name });
      const cookie = sessionCookie(response);
      const { user } = response.json();

      expect(response.statusCode).toEqual(201);
      expect(Object.keys(user).sort()).toEqual(userKeys);
      expect(user).toMatchObject({
        name,
        email: null,
        isGuest: true,
        emailVerified: false,
      });
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
      // guests can't sign back in, so their session outlives an account's
      expect(cookie?.maxAge).toBeGreaterThan(90 * 24 * 60 * 60);
      expect(await currentUser(cookie?.value ?? '')).toMatchObject({
        id: user.id,
        isGuest: true,
      });
      expect(await db.board.getBoardUser(publicBoardId, user.id)).toBeTruthy();
    });

    it('reuses the guest session of another tab', async () => {
      const first = await joinAsGuest(publicBoardId);
      const cookie = sessionCookie(first)?.value ?? '';
      const otherBoard = await getUserCaller(1).board.create({
        name: 'second link board',
      });

      await getUserCaller(1).board.changePrivacy({
        boardId: otherBoard.id,
        isPublic: true,
      });

      const name = guestName();
      const again = await joinAsGuest(otherBoard.id, { name, cookie });

      expect(again.statusCode).toEqual(200);
      expect(again.json().user.id).toEqual(first.json().user.id);
      expect(sessionCookie(again)).toBeUndefined();
      expect(await db.user.getUserByName(name)).toBeUndefined();
      expect(
        await db.board.getBoardUser(otherBoard.id, first.json().user.id),
      ).toBeTruthy();
    });

    it('rejects accounts and invalid names', async () => {
      const { cookie } = await register();

      const signedIn = await joinAsGuest(publicBoardId, { cookie });

      expect(signedIn.statusCode).toEqual(409);
      expect(signedIn.json()).toEqual({ error: 'ALREADY_SIGNED_IN' });

      for (const name of ['', '   ', 'Ana\u202e', 'x'.repeat(65)]) {
        expect((await joinAsGuest(publicBoardId, { name })).statusCode).toEqual(
          400,
        );
      }
    });

    it('signs up from a link without losing the board', async () => {
      const joined = await joinAsGuest(publicBoardId);
      const guestCookie = sessionCookie(joined)?.value ?? '';
      const guestId = joined.json().user.id;

      const { response, cookie, user } = await register(newEmail(), {
        cookie: guestCookie,
      });

      expect(response.statusCode).toEqual(201);
      expect(user.id).toEqual(guestId);
      expect(await currentUser(guestCookie)).toBeNull();
      expect((await currentUser(cookie))?.isGuest).toEqual(false);
      expect(await db.board.getBoardUser(publicBoardId, guestId)).toBeTruthy();
    });
  });

  describe('login', () => {
    it('gives the same answer for unknown emails and wrong passwords', async () => {
      const { email } = await register();

      const unknown = await login(newEmail());
      const wrong = await login(email, 'wrong password');

      expect(unknown.statusCode).toEqual(400);
      expect(wrong.statusCode).toEqual(400);
      expect(unknown.json()).toEqual({ error: 'INVALID_CREDENTIALS' });
      expect(wrong.json()).toEqual(unknown.json());
      expect(sessionCookie(wrong)).toBeUndefined();
    });

    it('rotates the session', async () => {
      const { email, cookie: first } = await register();

      const response = await post(
        '/api/auth/login',
        { email: email.toUpperCase(), password },
        { cookie: first, ip: nextIp() },
      );
      const second = sessionCookie(response)?.value ?? '';

      expect(response.statusCode).toEqual(200);
      expect(Object.keys(response.json().user).sort()).toEqual(userKeys);
      expect(second).not.toEqual(first);
      expect(await currentUser(second)).toMatchObject({ email });

      const stale = await getSession(first);

      expect(stale.json()).toEqual({ user: null });
      // only the session check clears a dead cookie
      expect(sessionCookie(stale)?.value).toEqual('');
    });
  });

  it('logout ends only the current session', async () => {
    const { email, cookie: first } = await register();
    const second = sessionCookie(await login(email))?.value ?? '';

    const response = await post('/api/auth/logout', {}, { cookie: first });

    expect(response.statusCode).toEqual(204);
    expect(sessionCookie(response)?.value).toEqual('');
    expect(await currentUser(first)).toBeNull();
    expect(await currentUser(second)).toMatchObject({ email });
  });

  describe('password reset', () => {
    const requestReset = (email: string) =>
      post('/api/auth/password-reset/request', { email }, { ip: nextIp() });

    const resetToken = async (email: string) => {
      await vi.waitFor(() => {
        expect(mail.reset).toHaveBeenCalledWith(email, expect.any(String));
      });

      const link = mail.reset.mock.calls.find(([to]) => to === email)?.[1];

      expect(link).toMatch(`${origin}/reset-password#token=`);

      return tokenFrom(link);
    };

    const confirm = (token: string, pw = 'a brand new password') =>
      post(
        '/api/auth/password-reset/confirm',
        { token, password: pw },
        { ip: nextIp() },
      );

    it('answers 202 whether or not the account exists', async () => {
      const { email } = await register();

      const known = await requestReset(email);
      const unknown = await requestReset(newEmail());

      expect(known.statusCode).toEqual(202);
      expect(unknown.statusCode).toEqual(202);
      expect(unknown.json()).toEqual(known.json());

      await resetToken(email);
      expect(mail.reset).toHaveBeenCalledTimes(1);
    });

    it('resets once, signs in, verifies the email and revokes credentials', async () => {
      const { email, cookie, user } = await register();
      await db.user.updateUserApiToken(
        user.id,
        hashApiToken('tapiz_pat_x'),
        null,
      );

      await requestReset(email);
      const token = await resetToken(email);

      expect((await confirm('x'.repeat(43))).json()).toEqual({
        error: 'INVALID_OR_EXPIRED_TOKEN',
      });

      const response = await confirm(token);
      const newCookie = sessionCookie(response)?.value ?? '';

      expect(response.statusCode).toEqual(200);
      expect(response.json().user).toMatchObject({
        id: user.id,
        emailVerified: true,
      });
      expect((await currentUser(newCookie))?.id).toEqual(user.id);
      expect(await currentUser(cookie)).toBeNull();
      expect(await db.user.getUserApiTokenInfo(user.id)).toMatchObject({
        hasToken: false,
      });

      // single use
      expect((await confirm(token)).statusCode).toEqual(400);

      expect((await login(email)).statusCode).toEqual(400);
      expect((await login(email, 'a brand new password')).statusCode).toEqual(
        200,
      );
    });

    it('rejects expired links', async () => {
      const { email, user } = await register();

      await requestReset(email);
      const token = await resetToken(email);

      await drizzleDb
        .update(accounts)
        .set({ passwordResetExpiresAt: sql`now() - interval '1 second'` })
        .where(eq(accounts.id, user.id));

      expect((await confirm(token)).statusCode).toEqual(400);
      expect((await login(email)).statusCode).toEqual(200);
    });

    // An API token minted on an old session takes that session's row lock
    // first; the reset deletes the sessions before it clears the token, so
    // it waits for the mint and clears its token too.
    it('clears a token minted on an old session while the reset runs', async () => {
      const { email, user } = await register();
      const session = await createSession(user.id, false);

      await requestReset(email);
      const token = await resetToken(email);

      let release = () => undefined as void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked = () => undefined as void;
      const sessionLocked = new Promise<void>((resolve) => (locked = resolve));

      const minting = drizzleDb.transaction(async (tx) => {
        await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.id, session.sessionId))
          .for('share');
        locked();
        await released;
        await tx
          .update(accounts)
          .set({ apiTokenHash: hashApiToken(`tapiz_pat_${randomUUID()}`) })
          .where(eq(accounts.id, user.id));
      });

      await sessionLocked;
      const reset = confirm(token);
      // let the reset reach the locked session row
      await new Promise((resolve) => setTimeout(resolve, 200));
      release();
      await minting;

      expect((await reset).statusCode).toEqual(200);
      expect(await db.user.getUserApiTokenInfo(user.id)).toMatchObject({
        hasToken: false,
      });
      expect(await currentUser(session.token)).toBeNull();
    });

    it('mints no token for a session that is gone', async () => {
      const { user } = await register();
      const session = await createSession(user.id, false);

      await db.session.deleteSession(session.sessionId);

      expect(
        await db.user.updateUserApiToken(
          user.id,
          hashApiToken(`tapiz_pat_${randomUUID()}`),
          session.sessionId,
        ),
      ).toBeUndefined();
      expect(await db.user.getUserApiTokenInfo(user.id)).toMatchObject({
        hasToken: false,
      });

      const live = await createSession(user.id, false);

      expect(
        await db.user.updateUserApiToken(
          user.id,
          hashApiToken(`tapiz_pat_${randomUUID()}`),
          live.sessionId,
        ),
      ).toEqual(expect.any(String));
    });
  });

  describe('email verification', () => {
    const verifyToken = async (email: string) => {
      await vi.waitFor(() => {
        expect(mail.verify).toHaveBeenCalledWith(
          email,
          expect.any(String),
          'Ana',
        );
      });

      const calls = mail.verify.mock.calls.filter(([to]) => to === email);
      const link = calls[calls.length - 1][1];

      expect(link).toMatch(`${origin}/verify-email#token=`);

      return tokenFrom(link);
    };

    const verify = (token: string, cookie?: string) =>
      post('/api/auth/verify-email', { token }, { cookie, ip: nextIp() });

    it('gates email invitations until the address is verified', async () => {
      const { email, user, cookie } = await register();
      const token = await verifyToken(email);

      const admin = await getUserCaller(1);
      const team = await admin.team.new({ name: 'verified only' });
      await admin.team.invite({ email, teamId: team.id, role: 'member' });

      // a tRPC caller with the account's current verification state
      const callerFor = async () => {
        const account = await db.user.getUser(user.id);

        if (!account) {
          throw new Error('account not found');
        }

        return createCallerFactory(appRouter)(
          createTestContext(toPrincipal(account, 'session', null)),
        );
      };

      const unverified = await callerFor();
      const invites = await db.team.getTeamInvitations(team.id);

      expect(await unverified.user.invites()).toEqual([]);
      expect(
        await unverified.user
          .acceptInvite({ inviteId: invites[0].id })
          .catch((e) => e.code),
      ).toEqual('NOT_FOUND');

      const response = await verify(token, cookie);

      expect(response.statusCode).toEqual(200);
      expect(response.json().user).toMatchObject({
        id: user.id,
        emailVerified: true,
      });
      expect((await verify(token, cookie)).statusCode).toEqual(400);

      const verified = await callerFor();

      expect(await verified.user.invites()).toHaveLength(1);
      await verified.user.acceptInvite({ inviteId: invites[0].id });
      expect(await db.team.getUserTeam(team.id, user.id)).toBeTruthy();
    });

    it('does not push invitations to an unverified account', async () => {
      const { email, user } = await register();
      const admin = await getUserCaller(2);
      const team = await admin.team.new({ name: 'by address' });

      await admin.team.invite({ email, teamId: team.id, role: 'member' });

      expect(await db.user.getUserInvitations(user.id)).toEqual([]);
      expect(await db.user.getUserInvitationsByEmail(email)).toHaveLength(1);
    });

    it('resends for unverified accounts with a session', async () => {
      const { email, cookie } = await register();
      const first = await verifyToken(email);
      const resend = () =>
        post('/api/auth/verify-email/resend', {}, { cookie, ip: nextIp() });

      expect((await resend()).statusCode).toEqual(202);

      const second = await verifyToken(email);

      expect(second).not.toEqual(first);
      // the new link replaces the old one
      expect((await verify(first, cookie)).statusCode).toEqual(400);
      expect((await verify(second, cookie)).statusCode).toEqual(200);
      expect((await resend()).statusCode).toEqual(204);

      expect(
        (await post('/api/auth/verify-email/resend', {}, { ip: nextIp() }))
          .statusCode,
      ).toEqual(401);
    });

    it('rejects expired links', async () => {
      const { email, user, cookie } = await register();
      const token = await verifyToken(email);

      await drizzleDb
        .update(accounts)
        .set({ emailVerifyExpiresAt: sql`now() - interval '1 second'` })
        .where(eq(accounts.id, user.id));

      expect((await verify(token, cookie)).statusCode).toEqual(400);
    });

    // someone registers the victim's address, the victim clicks the link
    it('only verifies from a session of the account the link is for', async () => {
      const { email, user, cookie } = await register();
      const token = await verifyToken(email);
      const other = await register();
      const loginRequired = { error: 'LOGIN_REQUIRED' };

      const anonymous = await verify(token);
      const otherAccount = await verify(token, other.cookie);

      expect(anonymous.statusCode).toEqual(401);
      expect(anonymous.json()).toEqual(loginRequired);
      expect(otherAccount.statusCode).toEqual(401);
      expect(otherAccount.json()).toEqual(loginRequired);
      expect((await currentUser(other.cookie))?.emailVerified).toEqual(false);

      // API tokens can't use it either
      const apiToken = `tapiz_pat_${randomUUID()}`;

      await db.user.updateUserApiToken(user.id, hashApiToken(apiToken), null);
      expect(
        (
          await post(
            '/api/auth/verify-email',
            { token },
            {
              ip: nextIp(),
              headers: { authorization: `Bearer ${apiToken}` },
            },
          )
        ).statusCode,
      ).toEqual(401);

      // nothing was consumed
      const response = await verify(token, cookie);

      expect(response.statusCode).toEqual(200);
      expect(response.json().user).toMatchObject({
        id: user.id,
        emailVerified: true,
      });
    });

    it('answers invalid links as invalid when signed in', async () => {
      const { cookie } = await register();

      expect((await verify('x'.repeat(43), cookie)).json()).toEqual({
        error: 'INVALID_OR_EXPIRED_TOKEN',
      });
    });
  });

  it('changes the password and ends the other sessions', async () => {
    const { email, cookie, user } = await register();
    const other = sessionCookie(await login(email))?.value ?? '';
    await db.user.updateUserApiToken(
      user.id,
      hashApiToken('tapiz_pat_y'),
      null,
    );

    const change = (currentPassword: string) =>
      post(
        '/api/auth/password',
        { currentPassword, newPassword: 'another long password' },
        { cookie, ip: nextIp() },
      );

    const wrong = await change('not it');

    expect(wrong.statusCode).toEqual(400);
    expect(wrong.json()).toEqual({ error: 'INVALID_CREDENTIALS' });

    const response = await change(password);
    const newCookie = sessionCookie(response)?.value ?? '';

    expect(response.statusCode).toEqual(204);
    expect((await currentUser(newCookie))?.id).toEqual(user.id);
    expect(await currentUser(cookie)).toBeNull();
    expect(await currentUser(other)).toBeNull();
    expect(await db.user.getUserApiTokenInfo(user.id)).toMatchObject({
      hasToken: false,
    });
    expect((await login(email, 'another long password')).statusCode).toEqual(
      200,
    );

    const anonymous = await post(
      '/api/auth/password',
      { currentPassword: password, newPassword: 'whatever it is' },
      { ip: nextIp() },
    );

    expect(anonymous.statusCode).toEqual(401);
  });

  it('never lets a login rehash undo a newer password', async () => {
    const { email, user } = await register();
    const [{ passwordHash: stale }] = await drizzleDb
      .select({ passwordHash: accounts.passwordHash })
      .from(accounts)
      .where(eq(accounts.id, user.id));

    await db.user.setPassword(user.id, 'new-hash');
    // the rehash of the old password lands after the change
    await db.user.updatePasswordHash(user.id, stale ?? '', 'rehashed');

    const [{ passwordHash }] = await drizzleDb
      .select({ passwordHash: accounts.passwordHash })
      .from(accounts)
      .where(eq(accounts.id, user.id));

    expect(passwordHash).toEqual('new-hash');
    expect((await login(email)).statusCode).toEqual(400);
  });

  describe('rate limits', () => {
    it('limits logins per IP', async () => {
      const ip = nextIp();
      const statuses: number[] = [];

      for (let i = 0; i < 11; i++) {
        statuses.push((await login(newEmail(), 'wrong', ip)).statusCode);
      }

      expect(statuses.slice(0, 10)).toEqual(Array(10).fill(400));
      expect(statuses[10]).toEqual(429);
    });

    it('limits logins per email before checking the password', async () => {
      const { email } = await register();

      for (let i = 0; i < 10; i++) {
        expect((await login(email, 'wrong')).statusCode).toEqual(400);
      }

      // the right password no longer gets through
      const response = await login(email);

      expect(response.statusCode).toEqual(400);
      expect(response.json()).toEqual({ error: 'INVALID_CREDENTIALS' });
    });

    it('limits registrations per IP', async () => {
      const ip = nextIp();
      const statuses: number[] = [];

      for (let i = 0; i < 6; i++) {
        statuses.push((await register(newEmail(), { ip })).response.statusCode);
      }

      expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
    });
  });

  describe('csrf', () => {
    it('requires an allowed Origin on auth routes', async () => {
      const body = { email: newEmail(), password };

      const missing = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: body,
        remoteAddress: nextIp(),
      });
      const foreign = await post('/api/auth/login', body, {
        ip: nextIp(),
        headers: { origin: 'https://evil.example' },
      });

      expect(missing.statusCode).toEqual(403);
      expect(foreign.statusCode).toEqual(403);
    });

    it('requires an allowed Origin with the session cookie', async () => {
      const { cookie } = await register();

      const response = await app.inject({
        method: 'POST',
        url: '/api/upload-file-board',
        payload: {},
        headers: { cookie: `tapiz_session=${cookie}` },
      });

      expect(response.statusCode).toEqual(403);
      expect(await currentUser(cookie)).toBeTruthy();
    });

    it('rejects cross-site requests that carry the cookie', async () => {
      const { cookie } = await register();

      const response = await getSession(cookie, {
        'sec-fetch-site': 'cross-site',
      });

      expect(response.statusCode).toEqual(403);
      expect(
        (await getSession(cookie, { 'sec-fetch-site': 'same-site' }))
          .statusCode,
      ).toEqual(200);
    });

    it('checks percent-encoded paths like the routes they reach', async () => {
      const { cookie } = await register();

      const crossSite = await app.inject({
        method: 'GET',
        url: '/%61pi/auth/session',
        headers: {
          cookie: `tapiz_session=${cookie}`,
          'sec-fetch-site': 'cross-site',
        },
      });
      const foreign = await post(
        '/%61pi/auth/logout',
        {},
        { cookie, ip: nextIp(), headers: { origin: 'https://evil.example' } },
      );

      expect(crossSite.statusCode).toEqual(403);
      expect(foreign.statusCode).toEqual(403);
      expect(await currentUser(cookie)).toBeTruthy();
    });

    it('lets Bearer requests through and never reads their cookie', async () => {
      const { cookie } = await register();

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: {
          authorization: 'Bearer tapiz_pat_unknown',
          cookie: `tapiz_session=${cookie}`,
        },
      });

      expect(response.statusCode).toEqual(204);

      const session = await getSession(cookie, {
        authorization: 'Bearer tapiz_pat_unknown',
      });

      expect(session.json()).toEqual({ user: null });
      // the cookie was never looked at, so it isn't cleared either
      expect(sessionCookie(session)).toBeUndefined();
      expect(await currentUser(cookie)).toBeTruthy();
    });
  });
});
