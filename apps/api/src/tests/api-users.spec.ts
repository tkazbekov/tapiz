import { API_TOKEN_PREFIX, hashApiToken } from '../app/api-token';
import { resolvePrincipal } from '../app/auth/principal';
import { createSession, validateSessionToken } from '../app/auth/session';
import db from '../app/db';
import { startDB } from '../app/db/init-db';
import {
  createGuest,
  createMultipleUsers,
  getAuth,
  getGuestAuth,
  getUserCaller,
} from './test-helpers';
import { vi } from 'vitest';
import { addTeamMember } from '../app/db/user-db';
import type { FastifyReply, FastifyRequest } from 'fastify';

const principalFor = (headers: Record<string, string>, cookies = {}) =>
  resolvePrincipal(
    { headers, cookies } as unknown as FastifyRequest,
    { setCookie: vi.fn() } as unknown as FastifyReply,
  );

describe('user', () => {
  beforeAll(async () => {
    await startDB();
    await createMultipleUsers();
  });

  it('delete account should delete user and sessions', async () => {
    const caller = await getUserCaller(5);
    const session = await createSession(getAuth(5).sub, false);

    expect(await validateSessionToken(session.token)).toBeTruthy();

    await caller.user.removeAccount();

    const user = await db.user.getUser(getAuth(5).sub);

    expect(user).toBeFalsy();
    expect(await validateSessionToken(session.token)).toBeNull();
  });

  it('delete account should delete empty team/board', async () => {
    const caller = await getUserCaller(6);

    const resultCreateTeam = await caller.team.new({
      name: 'test',
    });

    const teamId = resultCreateTeam.id;

    const resultCreateBoard = await caller.board.create({
      name: 'test',
      teamId,
    });

    const boardId = resultCreateBoard.id;

    await caller.user.removeAccount();

    const team = await db.team.getTeam(teamId);
    const board = await db.board.getBoard(boardId);

    expect(team).toBeFalsy();
    expect(board).toBeFalsy();
  });

  it('generates and regenerates an api token for bearer auth', async () => {
    const caller = await getUserCaller(9);
    const tokenInfo = await caller.user.apiToken();

    expect(tokenInfo.hasToken).toEqual(false);

    const firstToken = await caller.user.generateApiToken();

    expect(firstToken.token.startsWith(API_TOKEN_PREFIX)).toEqual(true);

    const storedUser = await db.user.getUserByApiTokenHash(
      hashApiToken(firstToken.token),
    );

    expect(storedUser?.id).toEqual(getAuth(9).sub);
    expect(storedUser?.apiTokenHash).not.toEqual(firstToken.token);

    const firstPrincipal = await principalFor({
      authorization: `Bearer ${firstToken.token}`,
    });

    expect(firstPrincipal?.sub).toEqual(getAuth(9).sub);
    expect(firstPrincipal?.via).toEqual('api_token');

    const secondToken = await caller.user.generateApiToken();
    const oldTokenPrincipal = await principalFor({
      authorization: `Bearer ${firstToken.token}`,
    });
    const newTokenPrincipal = await principalFor({
      authorization: `Bearer ${secondToken.token}`,
    });

    expect(oldTokenPrincipal).toBeNull();
    expect(newTokenPrincipal?.sub).toEqual(getAuth(9).sub);
  });

  it('a bearer header ignores the session cookie', async () => {
    const session = await createSession(getAuth(10).sub, false);
    const cookies = { tapiz_session: session.token };

    expect((await principalFor({}, cookies))?.sub).toEqual(getAuth(10).sub);
    expect(
      await principalFor({ authorization: 'Bearer nope' }, cookies),
    ).toBeNull();
  });

  it('delete account should transfer ownership', async () => {
    const caller = await getUserCaller(7);
    const newAdmin = await getUserCaller(8);

    const resultCreateTeam = await caller.team.new({
      name: 'test',
    });

    const teamId = resultCreateTeam.id;

    await caller.board.create({
      name: 'test',
      teamId,
    });

    const publicBoard = await caller.board.create({
      name: 'test2',
    });

    await caller.board.changePrivacy({
      boardId: publicBoard.id,
      isPublic: true,
    });

    await db.board.joinBoard(getAuth(8).sub, publicBoard.id);

    await newAdmin.board.board({
      boardId: publicBoard.id,
    });

    // invite to team
    const teamInvitation = await caller.team.invite({
      email: getAuth(8).email,
      teamId,
      role: 'member',
    });
    await newAdmin.user.acceptInvite({
      inviteId: teamInvitation.id,
    });

    await caller.user.removeAccount();

    const teams = await newAdmin.team.getAll();
    const boards = await newAdmin.board.boards({});

    expect(teams[0].teamMember.role).toEqual('admin');
    expect(boards[0].isAdmin).toBeTruthy();
    expect(boards[1].isAdmin).toBeTruthy();
  });

  it('delete account handles more than 10 boards and shared teams', async () => {
    const caller = await getUserCaller(20);
    const member = getAuth(21).sub;
    const coAdmin = getAuth(22).sub;
    const user = getAuth(20).sub;

    const soloBoards: string[] = [];

    for (let i = 0; i < 12; i++) {
      soloBoards.push((await caller.board.create({ name: `solo ${i}` })).id);
    }

    const sharedBoard = await caller.board.create({ name: 'shared' });
    await db.board.joinBoard(member, sharedBoard.id);

    const coAdminBoard = await caller.board.create({ name: 'co-admin' });
    await db.board.joinBoard(coAdmin, coAdminBoard.id);
    await db.board.joinBoard(member, coAdminBoard.id);
    await db.board.changeRole(coAdminBoard.id, coAdmin, 'admin');

    const soloTeam = await caller.team.new({ name: 'solo team' });
    const soloTeamBoard = await caller.board.create({
      name: 'solo team board',
      teamId: soloTeam.id,
    });

    const sharedTeam = await caller.team.new({ name: 'shared team' });
    await addTeamMember(member, sharedTeam.id, 'member');
    const sharedTeamBoard = await caller.board.create({
      name: 'shared team board',
      teamId: sharedTeam.id,
    });

    await caller.user.removeAccount();

    // everything is settled once the call resolves
    expect(await db.user.getUser(user)).toBeFalsy();

    for (const boardId of soloBoards) {
      expect(await db.board.getBoard(boardId)).toBeFalsy();
    }

    expect((await db.board.getBoardUser(sharedBoard.id, member))?.role).toEqual(
      'admin',
    );

    expect(
      (await db.board.getBoardUser(coAdminBoard.id, coAdmin))?.role,
    ).toEqual('admin');
    expect(
      (await db.board.getBoardUser(coAdminBoard.id, member))?.role,
    ).toEqual('member');

    expect(await db.team.getTeam(soloTeam.id)).toBeFalsy();
    expect(await db.board.getBoard(soloTeamBoard.id)).toBeFalsy();

    const sharedTeamMembers = await db.team.getTeamMembers(sharedTeam.id);

    expect(sharedTeamMembers).toEqual([
      expect.objectContaining({ id: member, role: 'admin' }),
    ]);
    expect(await db.board.getBoard(sharedTeamBoard.id)).toBeTruthy();
  });

  it('delete account never hands a board to a guest', async () => {
    const caller = await getUserCaller(23);
    const board = await caller.board.create({ name: 'guest only' });

    await caller.board.changePrivacy({ boardId: board.id, isPublic: true });
    await createGuest(0);
    await db.board.ensureBoardMember(board.id, getGuestAuth(0).sub);

    await caller.user.removeAccount();

    expect(await db.board.getBoard(board.id)).toBeFalsy();
  });

  it('rejects negative notification offsets', async () => {
    const caller = await getUserCaller(40);

    expect(
      await caller.user.notifications({ offset: -1 }).catch((e) => e.code),
    ).toEqual('BAD_REQUEST');
    expect(await caller.user.notifications({ offset: 0 })).toMatchObject({
      items: [],
    });
  });

  describe('invites', () => {
    let caller: Awaited<ReturnType<typeof getUserCaller>>;
    let caller2: Awaited<ReturnType<typeof getUserCaller>>;
    let caller3: Awaited<ReturnType<typeof getUserCaller>>;
    let resultCreateTeam: Awaited<ReturnType<typeof caller.team.new>>;

    beforeAll(async () => {
      caller = await getUserCaller(1);
      caller2 = await getUserCaller(2);
      caller3 = await getUserCaller(3);

      resultCreateTeam = await caller.team.new({
        name: 'test',
      });
    });

    it('invite', async () => {
      await caller.team.invite({
        email: getAuth(2).email,
        teamId: resultCreateTeam.id,
        role: 'member',
      });

      await caller.team.invite({
        email: getAuth(3).email,
        teamId: resultCreateTeam.id,
        role: 'member',
      });

      await caller.team.invite({
        email: getAuth(4).email,
        teamId: resultCreateTeam.id,
        role: 'member',
      });

      const invites = await caller2.user.invites();

      expect(invites.length).toEqual(1);
    });

    it('accept invite', async () => {
      const invites = await caller2.user.invites();

      const result = await caller2.user.acceptInvite({
        inviteId: invites[0].id,
      });

      expect(result.success).toEqual(true);

      const invites2 = await caller2.user.invites();

      expect(invites2).toHaveLength(0);
    });

    it('cancel invite', async () => {
      const invites = await caller3.user.invites();

      expect(invites).toHaveLength(1);

      await caller.user.cancelInvite({
        inviteId: invites[0].id,
      });

      const invites2 = await caller3.user.invites();

      expect(invites2).toHaveLength(0);
    });
  });
});
