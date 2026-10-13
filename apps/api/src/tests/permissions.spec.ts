import { startDB } from '../app/db/init-db';
import {
  createGuest,
  createMultipleUsers,
  createTestContext,
  errorCall,
  getAuth,
  getGuestAuth,
  getGuestCaller,
  getUserCaller,
} from './test-helpers';
import { randProductName, randUuid } from '@ngneat/falso';
import { testRouter } from './routes-test';
import { appRouter } from '../app/routers';
import { createCallerFactory } from '../app/trpc';
import db from '../app/db/index';
import { db as drizzleDb } from '../app/db/init-db';
import { accounts } from '../app/schema';
import { eq } from 'drizzle-orm';

describe('permissions', () => {
  let teamId: string;
  let boardId: string;

  const createCaller = createCallerFactory(testRouter);

  beforeAll(async () => {
    await startDB();
    await createMultipleUsers();

    /*
      team admin: user1
      team member: user2, user3
      board admin: user2
    */

    const callerUser1 = await getUserCaller(1);
    const callerUser2 = await getUserCaller(2);
    const callerUser3 = await getUserCaller(3);

    const resultCreateTeam = await callerUser1.team.new({
      name: randProductName(),
    });

    teamId = resultCreateTeam.id;

    // user1 invite user2 team
    const resultInviteMember2 = await callerUser1.team.invite({
      email: getAuth(2).email,
      teamId,
      role: 'member',
    });

    await callerUser2.user.acceptInvite({
      inviteId: resultInviteMember2.id,
    });

    // user1 invite user3 team
    const resultInviteMember3 = await callerUser1.team.invite({
      email: getAuth(3).email,
      teamId,
      role: 'member',
    });

    await callerUser3.user.acceptInvite({
      inviteId: resultInviteMember3.id,
    });

    const board = await callerUser2.board.create({
      name: randProductName(),
      teamId,
    });

    boardId = board.id;
  });

  it('no user', async () => {
    const caller = createCaller(createTestContext(null));

    const result = await errorCall(async () => {
      return caller.protected();
    });

    expect(result?.code).toEqual('UNAUTHORIZED');
  });

  it('login user', async () => {
    const user = getAuth(1);

    const caller = createCaller(createTestContext(user));

    const result = await caller.protected();

    expect(result?.ctx.user).toEqual(user);
  });

  describe('team', () => {
    it('team not found', async () => {
      const user = getAuth(1);

      const caller = createCaller(createTestContext(user));

      const result = await errorCall(async () => {
        return caller.team({
          teamId: randUuid(),
        });
      });

      expect(result?.code).toEqual('NOT_FOUND');
    });

    it('team admin not authorized', async () => {
      const user = getAuth(2);

      const caller = createCaller(createTestContext(user));

      const result = await errorCall(async () => {
        return caller.teamAdmin({
          teamId,
        });
      });

      expect(result?.code).toEqual('UNAUTHORIZED');
    });

    it('team admin', async () => {
      const user = getAuth(1);

      const caller = createCaller(createTestContext(user));

      const result = await caller.teamAdmin({
        teamId,
      });

      expect(result.ctx.userTeam.accountId).toBeTruthy();
    });

    it('team member not authorized', async () => {
      const user = getAuth(9);

      const caller = createCaller(createTestContext(user));

      const result = await errorCall(async () => {
        return caller.teamMember({
          teamId,
        });
      });

      expect(result?.code).toEqual('UNAUTHORIZED');
    });

    it('team member', async () => {
      const user = getAuth(2);

      const caller = createCaller(createTestContext(user));

      const result = await caller.teamMember({
        teamId,
      });

      expect(result.ctx.userTeam.accountId).toBeTruthy();
    });
  });

  describe('board', () => {
    it('board not found', async () => {
      const user = getAuth(1);

      const caller = createCaller(createTestContext(user));

      const result = await errorCall(async () => {
        return caller.board({
          boardId: randUuid(),
        });
      });

      expect(result?.code).toEqual('NOT_FOUND');
    });

    it('board admin not authorized', async () => {
      const user = getAuth(9);

      const caller = createCaller(createTestContext(user));

      const result = await errorCall(async () => {
        return caller.boardAdmin({
          boardId,
        });
      });

      expect(result?.code).toEqual('UNAUTHORIZED');
    });

    it('board admin', async () => {
      const user = getAuth(2);

      const caller = createCaller(createTestContext(user));

      const result = await caller.boardAdmin({
        boardId,
      });

      expect(result.ctx.board.id).toEqual(boardId);
    });

    it('board team admin', async () => {
      const user = getAuth(1);

      const caller = createCaller(createTestContext(user));

      const result = await caller.boardAdmin({
        boardId,
      });

      expect(result.ctx.board.id).toEqual(boardId);
    });

    it('board member not authorized', async () => {
      const user = getAuth(9);

      const caller = createCaller(createTestContext(user));

      const result = await errorCall(async () => {
        return caller.boardMember({
          boardId,
        });
      });

      expect(result?.code).toEqual('UNAUTHORIZED');
    });

    it('board member', async () => {
      const user = getAuth(3);

      const caller = createCaller(createTestContext(user));

      const result = await caller.boardMember({
        boardId,
      });

      expect(result.ctx.board.id).toEqual(boardId);
    });

    // board admins keep their boards after leaving the team (haveAccess)
    it('board admin keeps access after leaving the team', async () => {
      const user = getAuth(2);

      const caller = createCaller(createTestContext(user));

      await db.team.deleteMember(teamId, user.sub);

      const result = await caller.boardMember({
        boardId,
      });

      expect(result.ctx.board.id).toEqual(boardId);
    });
  });

  describe('guests', () => {
    let publicBoardId: string;
    let privateBoardId: string;

    const guestCaller = (index: number) =>
      createCaller(createTestContext(getGuestAuth(index)));

    beforeAll(async () => {
      for (let i = 0; i < 3; i++) {
        await createGuest(i);
      }

      const owner = await getUserCaller(4);

      publicBoardId = (await owner.board.create({ name: 'public' })).id;
      privateBoardId = (await owner.board.create({ name: 'private' })).id;

      await owner.board.changePrivacy({
        boardId: publicBoardId,
        isPublic: true,
      });
    });

    it('account-only tiers are forbidden', async () => {
      const caller = guestCaller(0);
      const calls = [
        () => caller.protected(),
        () => caller.team({ teamId }),
        () => caller.teamAdmin({ teamId }),
        () => caller.teamMember({ teamId }),
        () => caller.boardAdmin({ boardId: publicBoardId }),
        () => caller.boardAccountMember({ boardId: publicBoardId }),
      ];

      for (const call of calls) {
        const result = await errorCall(call);

        expect(result?.code).toEqual('FORBIDDEN');
        expect(result?.message).toEqual('ACCOUNT_REQUIRED');
      }
    });

    it('cannot create boards, use api tokens or invites', async () => {
      const caller = getGuestCaller(1);
      const calls = [
        () => caller.board.create({ name: 'nope' }),
        () => caller.board.duplicate({ boardId: publicBoardId }),
        () => caller.user.generateApiToken(),
        () => caller.user.apiToken(),
        () => caller.user.invites(),
        () => caller.team.new({ name: 'nope' }),
      ];

      for (const call of calls) {
        expect((await errorCall(call))?.code).toEqual('FORBIDDEN');
      }

      // the account check runs before the membership row is created
      expect(
        await db.board.getBoardUser(publicBoardId, getGuestAuth(1).sub),
      ).toBeFalsy();
    });

    it('uses participant procedures', async () => {
      const guest = getGuestAuth(0);
      const caller = getGuestCaller(0);

      expect((await guestCaller(0).participant()).ctx.user).toEqual(guest);
      expect(await caller.user.user()).toMatchObject({
        id: guest.sub,
        name: guest.name,
        email: null,
        isGuest: true,
        emailVerified: false,
      });
      expect(await caller.user.settings()).toBeTruthy();
      expect((await caller.user.notifications({})).items).toEqual([]);
    });

    it('joins public boards only', async () => {
      const caller = guestCaller(0);

      const result = await caller.boardMember({ boardId: publicBoardId });

      expect(result.ctx.userBoard.id).toEqual(publicBoardId);

      const denied = await errorCall(() =>
        caller.boardMember({ boardId: privateBoardId }),
      );

      expect(denied?.code).toEqual('UNAUTHORIZED');
    });

    it('cannot be made a board admin', async () => {
      const owner = await getUserCaller(4);

      const result = await errorCall(() =>
        owner.board.changeRole({
          boardId: publicBoardId,
          userId: getGuestAuth(0).sub,
          role: 'admin',
        }),
      );

      expect(result?.code).toEqual('BAD_REQUEST');
      expect(result?.message).toEqual('GUEST_CANNOT_BE_ADMIN');
    });

    it('cannot hold an api token', async () => {
      const update = async () => {
        await drizzleDb
          .update(accounts)
          .set({ apiTokenHash: 'x'.repeat(64) })
          .where(eq(accounts.id, getGuestAuth(2).sub));
      };

      // drizzle wraps the PostgresError
      await expect(update()).rejects.toMatchObject({
        cause: { constraint_name: 'accounts_identity_chk' },
      });
    });

    it('loses access when link sharing is turned off', async () => {
      const owner = await getUserCaller(4);

      await owner.board.changePrivacy({
        boardId: publicBoardId,
        isPublic: false,
      });

      const result = await errorCall(() =>
        guestCaller(0).boardMember({ boardId: publicBoardId }),
      );

      expect(result?.code).toEqual('UNAUTHORIZED');
    });
  });

  describe('api tokens', () => {
    it('cannot mint a token or remove the account', async () => {
      const caller = createCallerFactory(appRouter)(
        createTestContext({
          ...getAuth(5),
          via: 'api_token',
        }),
      );

      for (const call of [
        () => caller.user.generateApiToken(),
        () => caller.user.removeAccount(),
      ]) {
        const result = await errorCall(call);

        expect(result?.code).toEqual('FORBIDDEN');
      }

      expect(await db.user.getUser(getAuth(5).sub)).toBeTruthy();
    });
  });
});
