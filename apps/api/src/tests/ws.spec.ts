import { randomUUID } from 'node:crypto';
import { startDB } from '../app/db/init-db';
import {
  createMultipleUsers,
  getAuth,
  getUserCaller,
  initTestServer,
  initWs,
  tryWs,
} from './test-helpers';
import { getBoardUser } from '../app/db/board-db';
import { Server } from '../app/server';
import { sendUserEvent } from '../app/subscriptor';
import { revokeBoardAccess } from '../app/global';
import { isUserNode } from '@tapiz/board-commons';
import db from '../app/db';
import { addTeamMember } from '../app/db/user-db';

describe('ws', () => {
  let socket: Awaited<ReturnType<typeof initWs>>;
  let wsServer: Server;
  const port = 8011;

  const sendFrom = (ws: typeof socket, obj: unknown) => {
    ws.emit('board', obj);

    return new Promise((resolve) => setTimeout(resolve, 100));
  };

  const errorsOf = (ws: typeof socket) => {
    const errors: string[] = [];
    ws.on('error', (type: string) => {
      errors.push(type);
    });

    return errors;
  };

  const rooms = () => wsServer.io.of('/').adapter.rooms;

  // messages sent before the session is validated are not handled yet
  const connect = async (cookie: string) => {
    const ws = await initWs(port, { cookie });

    await vi.waitFor(() => {
      expect(
        wsServer.clients.some((client) => client.socket.id === ws.id),
      ).toEqual(true);
    });

    return ws;
  };

  const send = (obj: unknown) => {
    return new Promise((resolve) => {
      socket.emit('board', obj);

      setTimeout(() => {
        resolve(null);
      }, 100); // wait for ws & db
    });
  };

  beforeAll(async () => {
    await startDB();
    await createMultipleUsers();
    wsServer = await initTestServer(port);
    socket = await initWs(port);
  });

  it('invialid msg', async () => {
    await socket.send('something');

    expect(socket.connected).toEqual(true);
  });

  it('join', async () => {
    const caller = await getUserCaller(1);

    const board1 = await caller.board.create({
      name: 'board 1',
    });

    await send({ action: 'join', boardId: board1.id });

    const board = await getBoardUser(board1.id, getAuth(1).sub);

    expect(board).toBeTruthy();
    expect(socket.connected).toEqual(true);
  });

  it('join without access leaves no state, membership or room', async () => {
    const caller = await getUserCaller(1);
    const privateBoard = await caller.board.create({ name: 'private' });

    const intruder = await connect('auth=2');
    const errors = errorsOf(intruder);

    await sendFrom(intruder, { action: 'join', boardId: privateBoard.id });

    await vi.waitFor(() => {
      expect(errors).toEqual(['unauthorized']);
    });

    expect(wsServer.getBoard(privateBoard.id)).toBeUndefined();
    expect(rooms().get(privateBoard.id)).toBeUndefined();
    expect(await getBoardUser(privateBoard.id, getAuth(2).sub)).toBeFalsy();
    expect(
      wsServer.clients.some((client) => client.boardId === privateBoard.id),
    ).toEqual(false);
  });

  it('join on a public board creates the membership', async () => {
    const caller = await getUserCaller(1);
    const board = await caller.board.create({ name: 'public' });
    await caller.board.changePrivacy({ boardId: board.id, isPublic: true });

    const visitor = await connect('auth=3');

    await sendFrom(visitor, { action: 'join', boardId: board.id });

    await vi.waitFor(() => {
      expect(
        rooms()
          .get(board.id)
          ?.has(visitor.id ?? ''),
      ).toEqual(true);
    });
    expect(await getBoardUser(board.id, getAuth(3).sub)).toBeTruthy();

    visitor.close();
  });

  it('revoked access leaves the board and its event room', async () => {
    const caller = await getUserCaller(1);
    const board = await caller.board.create({ name: 'revoke' });
    await caller.board.changePrivacy({ boardId: board.id, isPublic: true });

    const visitor = await connect('auth=4');
    const errors = errorsOf(visitor);

    visitor.emit('sub', { type: 'board', id: board.id });
    await sendFrom(visitor, { action: 'join', boardId: board.id });

    const client = wsServer.clients.find((it) => it.id === getAuth(4).sub);

    await vi.waitFor(() => {
      expect(client?.boardId).toEqual(board.id);
      expect(
        rooms()
          .get(`board:${board.id}`)
          ?.has(visitor.id ?? ''),
      ).toEqual(true);
    });

    // the membership row alone no longer grants access to a private board
    await caller.board.changePrivacy({ boardId: board.id, isPublic: false });

    await vi.waitFor(() => {
      expect(errors).toEqual(['unauthorized']);
      expect(client?.boardId).toBeUndefined();
    });

    expect(
      rooms()
        .get(board.id)
        ?.has(visitor.id ?? ''),
    ).toBeFalsy();
    expect(
      rooms()
        .get(`board:${board.id}`)
        ?.has(visitor.id ?? ''),
    ).toBeFalsy();

    visitor.close();
  });

  it('rejoining refreshes the user name', async () => {
    const caller = await getUserCaller(1);
    const board = await caller.board.create({ name: 'names' });

    await send({ action: 'join', boardId: board.id });

    await vi.waitFor(() => {
      expect(wsServer.isUserInBoard(board.id, getAuth(1).sub)).toEqual(true);
    });

    wsServer.setState(board.id, (state) =>
      state.map((node) =>
        isUserNode(node) && node.id === getAuth(1).sub
          ? { ...node, content: { ...node.content, name: 'stale' } }
          : node,
      ),
    );

    const secondTab = await connect('auth=1');
    await sendFrom(secondTab, { action: 'join', boardId: board.id });

    await vi.waitFor(() => {
      const userNode = wsServer
        .getStateBoardUsers(board.id)
        .find((node) => node.id === getAuth(1).sub);

      expect(userNode?.content).toMatchObject({ name: getAuth(1).name });
      expect(userNode?.content).not.toHaveProperty('username');
    });

    secondTab.close();
  });

  it('user events reach every socket of the user', async () => {
    const userId = getAuth(5).sub;
    const tabs = [await connect('auth=5'), await connect('auth=5')];
    const received = tabs.map(() => [] as unknown[]);

    tabs.forEach((tab, index) => {
      tab.on('user', (event: unknown) => received[index].push(event));
    });

    expect(rooms().get(`user:${userId}`)?.size).toEqual(2);

    const event = {
      userId,
      event: 'mentionUser' as const,
      content: { userId, boardId: randomUUID() },
    };

    sendUserEvent(event);

    await vi.waitFor(() => {
      expect(received).toEqual([[event], [event]]);
    });

    tabs.forEach((tab) => tab.close());
  });

  it('a second join leaves the socket on the latest board only', async () => {
    const caller = await getUserCaller(6);
    const boardA = await caller.board.create({ name: 'A' });
    const boardB = await caller.board.create({ name: 'B' });

    const tab = await connect('auth=6');
    const tabId = tab.id ?? '';
    const client = wsServer.clients.find((it) => it.socket.id === tabId);

    // back to back, so the second join starts while the first is in flight
    tab.emit('board', { action: 'join', boardId: boardA.id });
    tab.emit('board', { action: 'join', boardId: boardB.id });

    await vi.waitFor(() => {
      expect(rooms().get(`board:${boardB.id}`)?.has(tabId)).toEqual(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(client?.boardId).toEqual(boardB.id);
    expect(rooms().get(boardB.id)?.has(tabId)).toEqual(true);
    expect(rooms().get(boardA.id)?.has(tabId)).toBeFalsy();
    expect(rooms().get(`board:${boardA.id}`)?.has(tabId)).toBeFalsy();
    expect(wsServer.getBoard(boardA.id)).toBeUndefined();

    // revoking A no longer reaches this socket
    const errors = errorsOf(tab);
    revokeBoardAccess(boardA.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(errors).toEqual([]);

    tab.close();
  });

  it('joining again after a reconnect restores board events', async () => {
    const caller = await getUserCaller(7);
    const board = await caller.board.create({ name: 'reconnect' });

    const tab = await connect('auth=7');

    // a fresh socket only re-sends `join`, never `sub`
    await sendFrom(tab, { action: 'join', boardId: board.id });

    await vi.waitFor(() => {
      expect(
        rooms()
          .get(`board:${board.id}`)
          ?.has(tab.id ?? ''),
      ).toEqual(true);
    });

    tab.close();
  });

  it('leaving and rejoining loads the latest state', async () => {
    const caller = await getUserCaller(8);
    const board = await caller.board.create({ name: 'flush' });
    const noteId = randomUUID();

    const tab = await connect('auth=8');
    await sendFrom(tab, { action: 'join', boardId: board.id });
    await sendFrom(tab, [
      {
        op: 'add',
        data: {
          id: noteId,
          type: 'note',
          content: {
            text: 'last edit',
            position: { x: 0, y: 0 },
            layer: 1,
            ownerId: getAuth(8).sub,
            votes: [],
            emojis: [],
            drawing: [],
            width: 240,
            height: 160,
            color: '#fee2e2',
          },
        },
      },
    ]);

    expect(wsServer.getBoard(board.id)?.some((it) => it.id === noteId)).toEqual(
      true,
    );

    // the last client leaving empties the board; rejoining right away must
    // not load the row before that final write lands
    tab.emit('leaveBoard');
    await sendFrom(tab, { action: 'join', boardId: board.id });

    await vi.waitFor(() => {
      expect(
        wsServer.getBoard(board.id)?.some((it) => it.id === noteId),
      ).toEqual(true);
    });

    tab.close();
  });

  it('removing an account revokes its single-member team boards', async () => {
    const owner = await getUserCaller(9);
    const team = await db.team.createTeam('solo team', getAuth(9).sub);
    const board = await owner.board.create({ name: 'solo', teamId: team.id });
    await owner.board.changePrivacy({ boardId: board.id, isPublic: true });

    const visitor = await connect('auth=10');
    const errors = errorsOf(visitor);
    await sendFrom(visitor, { action: 'join', boardId: board.id });

    await vi.waitFor(() => {
      expect(
        rooms()
          .get(board.id)
          ?.has(visitor.id ?? ''),
      ).toEqual(true);
    });

    await owner.user.removeAccount();

    await vi.waitFor(() => {
      expect(errors).toEqual(['unauthorized']);
    });
    expect(rooms().get(board.id)).toBeUndefined();
    expect(wsServer.getBoard(board.id)).toBeUndefined();

    visitor.close();
  });

  it('a removed team member loses team and board subscriptions', async () => {
    const admin = await getUserCaller(11);
    const team = await db.team.createTeam('members', getAuth(11).sub);
    await addTeamMember(getAuth(12).sub, team.id, 'member');
    const board = await admin.board.create({ name: 'team', teamId: team.id });

    const member = await connect('auth=12');
    const memberId = member.id ?? '';
    const errors = errorsOf(member);

    member.emit('sub', { type: 'team', id: team.id });
    member.emit('sub', { type: 'board', id: board.id });

    await vi.waitFor(() => {
      expect(rooms().get(`team:${team.id}`)?.has(memberId)).toEqual(true);
      expect(rooms().get(`board:${board.id}`)?.has(memberId)).toEqual(true);
    });

    await admin.team.deleteMember({
      teamId: team.id,
      memberId: getAuth(12).sub,
    });

    await vi.waitFor(() => {
      expect(rooms().get(`team:${team.id}`)?.has(memberId)).toBeFalsy();
      expect(rooms().get(`board:${board.id}`)?.has(memberId)).toBeFalsy();
    });
    // not on the board, so the page is not sent away
    expect(errors).toEqual([]);
    expect(member.connected).toEqual(true);

    member.close();
  });

  it('rejects handshakes from other origins', async () => {
    expect(await tryWs(port, { origin: 'http://evil.example' })).toEqual(false);
    expect(
      await tryWs(port, {
        origin: new URL(process.env['FRONTEND_URL'] ?? '').origin,
      }),
    ).toEqual(true);
    expect(await tryWs(port)).toEqual(true);
  });
});
