import { randomUUID } from 'node:crypto';
import { startDB } from '../app/db/init-db';
import {
  createGuest,
  createMultipleUsers,
  getAuth,
  getGuestAuth,
  getUserCaller,
  initTestServer,
  initWs,
  tryWs,
} from './test-helpers';
import { getBoardUser } from '../app/db/board-db';
import { Server } from '../app/server';
import { sendUserEvent } from '../app/subscriptor';
import { revokeBoardAccess } from '../app/global';
import { isUserNode, type TuNode } from '@tapiz/board-commons';
import db from '../app/db';
import { addTeamMember } from '../app/db/user-db';
import { io } from 'socket.io-client';
import customParser from 'socket.io-msgpack-parser';

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

  // the client is registered before the handshake completes
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
    for (let i = 0; i < 5; i++) {
      await createGuest(i);
    }
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

    const intruder = await connect('tapiz_session=2');
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

    const visitor = await connect('tapiz_session=3');

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

    const visitor = await connect('tapiz_session=4');
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

    const secondTab = await connect('tapiz_session=1');
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
    const tabs = [
      await connect('tapiz_session=5'),
      await connect('tapiz_session=5'),
    ];
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

    const tab = await connect('tapiz_session=6');
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

    const tab = await connect('tapiz_session=7');

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

    const tab = await connect('tapiz_session=8');
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

    const visitor = await connect('tapiz_session=10');
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

    const member = await connect('tapiz_session=12');
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

  // listeners attached before the handshake, so early events aren't missed
  const authErrorsOf = (cookie: string) => {
    const ws = io(`ws://localhost:${port}`, {
      transports: ['websocket'],
      parser: customParser,
      reconnection: false,
      extraHeaders: { Cookie: cookie },
    });
    const errors: string[] = [];

    ws.on('auth_error', (reason: string) => errors.push(reason));

    return { ws, errors };
  };

  it('refuses handshakes without a valid session', async () => {
    for (const cookie of ['', 'tapiz_session=nope', 'tapiz_session=g19']) {
      const { ws } = authErrorsOf(cookie);
      const connectErrors: string[] = [];

      ws.on('connect_error', (err) => connectErrors.push(err.message));

      await vi.waitFor(() => {
        expect(connectErrors).toEqual(['unauthenticated']);
      });

      expect(ws.connected).toEqual(false);
      // socket.io does not retry a refused handshake by itself
      expect(ws.active).toEqual(false);

      ws.close();
    }
  });

  it('answers a join sent as soon as the socket connects', async () => {
    const owner = await getUserCaller(20);
    const board = await owner.board.create({ name: 'early join' });
    await owner.board.changePrivacy({ boardId: board.id, isPublic: true });

    const ws = io(`ws://localhost:${port}`, {
      transports: ['websocket'],
      parser: customParser,
      reconnection: false,
      extraHeaders: { Cookie: 'tapiz_session=21' },
    });
    const received: unknown[] = [];

    ws.on('board', (msgs: unknown[]) => received.push(...msgs));
    ws.on('connect', () => {
      ws.emit('correlationId', 'early-correlation');
      ws.emit('board', { action: 'join', boardId: board.id });
    });

    try {
      await vi.waitFor(() => {
        expect(
          rooms()
            .get(board.id)
            ?.has(ws.id ?? ''),
        ).toEqual(true);
        expect(received.length).toBeGreaterThan(0);
      });

      expect(
        wsServer.clients.find((client) => client.socket.id === ws.id),
      ).toMatchObject({
        boardId: board.id,
        correlationId: 'early-correlation',
      });
    } finally {
      ws.close();
    }
  });

  it('disconnects the sockets of ended sessions only', async () => {
    const ended = [
      authErrorsOf('tapiz_session=13'),
      authErrorsOf('tapiz_session=13'),
    ];
    const kept = authErrorsOf('tapiz_session=14');

    await vi.waitFor(() => {
      expect(
        wsServer.clients.filter((client) =>
          [getAuth(13).sub, getAuth(14).sub].includes(client.id),
        ),
      ).toHaveLength(3);
    });

    wsServer.disconnectSessions(['test-13'], 'logged_out');

    await vi.waitFor(() => {
      ended.forEach(({ ws, errors }) => {
        expect(errors).toEqual(['logged_out']);
        expect(ws.connected).toEqual(false);
      });
    });
    expect(kept.ws.connected).toEqual(true);
    expect(wsServer.clients.some((it) => it.id === getAuth(13).sub)).toEqual(
      false,
    );

    wsServer.disconnectAccount(getAuth(14).sub, 'account_deleted');

    await vi.waitFor(() => {
      expect(kept.errors).toEqual(['account_deleted']);
    });

    [...ended, kept].forEach(({ ws }) => ws.close());
  });

  it('pushes identity changes to the board', async () => {
    const caller = await getUserCaller(15);
    const board = await caller.board.create({ name: 'identity' });
    await caller.board.changePrivacy({ boardId: board.id, isPublic: true });

    const tab = await connect('tapiz_session=15');
    const watcher = await connect('tapiz_session=16');
    const received: unknown[] = [];

    watcher.on('board', (msgs: unknown[]) => received.push(...msgs));

    await sendFrom(tab, { action: 'join', boardId: board.id });
    await sendFrom(watcher, { action: 'join', boardId: board.id });

    wsServer.updateIdentity(getAuth(15).sub, {
      name: 'Renamed',
      sessionId: 'new-session',
    });

    const userNode = () =>
      wsServer
        .getStateBoardUsers(board.id)
        .find((node) => node.id === getAuth(15).sub);

    expect(userNode()?.content).toMatchObject({ name: 'Renamed' });
    expect(
      wsServer.clients.find((client) => client.socket.id === tab.id),
    ).toMatchObject({ username: 'Renamed', sessionId: 'new-session' });

    await vi.waitFor(() => {
      expect(received).toContainEqual({
        type: expect.any(String),
        data: [
          {
            op: 'patch',
            data: {
              type: 'user',
              id: getAuth(15).sub,
              content: { name: 'Renamed' },
            },
          },
        ],
      });
    });

    tab.close();
    watcher.close();
  });

  it('guests join public boards as non-admins', async () => {
    const caller = await getUserCaller(17);
    const board = await caller.board.create({ name: 'guests' });
    await caller.board.changePrivacy({ boardId: board.id, isPublic: true });

    const guest = await connect('tapiz_session=g0');

    await sendFrom(guest, { action: 'join', boardId: board.id });

    const client = wsServer.clients.find((it) => it.socket.id === guest.id);

    await vi.waitFor(() => {
      expect(client?.boardId).toEqual(board.id);
    });

    expect(client?.isAdmin).toEqual(false);
    expect(
      wsServer
        .getStateBoardUsers(board.id)
        .find((node) => node.id === getGuestAuth(0).sub)?.content,
    ).toMatchObject({ name: getGuestAuth(0).name, isGuest: true });

    guest.close();
  });

  it('refuses guests on boards that are not shared', async () => {
    const caller = await getUserCaller(18);
    const board = await caller.board.create({ name: 'not shared' });

    const guest = await connect('tapiz_session=g1');
    const errors = errorsOf(guest);

    await sendFrom(guest, { action: 'join', boardId: board.id });

    await vi.waitFor(() => {
      expect(errors).toEqual(['unauthorized']);
    });

    expect(wsServer.getBoard(board.id)).toBeUndefined();
    expect(await getBoardUser(board.id, getGuestAuth(1).sub)).toBeFalsy();

    guest.close();
  });

  it('drops guests when link sharing is turned off', async () => {
    const caller = await getUserCaller(18);
    const board = await caller.board.create({ name: 'shared for a while' });
    await caller.board.changePrivacy({ boardId: board.id, isPublic: true });

    const guest = await connect('tapiz_session=g2');
    const errors = errorsOf(guest);

    await sendFrom(guest, { action: 'join', boardId: board.id });

    const client = wsServer.clients.find((it) => it.socket.id === guest.id);

    await vi.waitFor(() => {
      expect(client?.boardId).toEqual(board.id);
    });

    await caller.board.changePrivacy({ boardId: board.id, isPublic: false });

    await vi.waitFor(() => {
      expect(errors).toEqual(['unauthorized']);
      expect(client?.boardId).toBeUndefined();
    });

    guest.close();
  });

  it('refuses guests whose access ends before the board loads', async () => {
    const caller = await getUserCaller(18);
    const board = await caller.board.create({ name: 'unshared mid join' });
    await caller.board.changePrivacy({ boardId: board.id, isPublic: true });

    const guest = await connect('tapiz_session=g0');
    const errors = errorsOf(guest);
    const createBoard = vi.spyOn(wsServer, 'createBoard');
    const boardDb = db.board;

    // sharing ends after the first access check, before this client is on
    // the board where checkBoardAccess could reach it
    db.board = {
      ...boardDb,
      haveAccess: async (boardId, userId) => {
        db.board = boardDb;
        await boardDb.setBoardPrivacy(boardId, false);

        return boardDb.haveAccess(boardId, userId);
      },
    };

    try {
      await sendFrom(guest, { action: 'join', boardId: board.id });

      await vi.waitFor(() => {
        expect(errors).toEqual(['unauthorized']);
      });

      expect(createBoard).not.toHaveBeenCalledWith(board.id);
      expect(wsServer.getBoard(board.id)).toBeUndefined();
      expect(
        wsServer.clients.some((client) => client.boardId === board.id),
      ).toEqual(false);
    } finally {
      db.board = boardDb;
      createBoard.mockRestore();
      guest.close();
    }
  });

  it('keeps an upgraded guest on the board under its new identity', async () => {
    const caller = await getUserCaller(19);
    const board = await caller.board.create({ name: 'upgrade' });
    await caller.board.changePrivacy({ boardId: board.id, isPublic: true });

    const guest = await connect('tapiz_session=g3');
    const guestId = getGuestAuth(3).sub;

    await sendFrom(guest, { action: 'join', boardId: board.id });

    const client = wsServer.clients.find((it) => it.socket.id === guest.id);

    await vi.waitFor(() => {
      expect(client?.boardId).toEqual(board.id);
    });

    wsServer.updateIdentity(guestId, {
      name: 'Signed Up',
      isGuest: false,
      sessionId: 'upgraded-session',
    });

    expect(client).toMatchObject({
      username: 'Signed Up',
      isGuest: false,
      sessionId: 'upgraded-session',
    });
    expect(guest.connected).toEqual(true);
    expect(
      wsServer.getStateBoardUsers(board.id).find((node) => node.id === guestId)
        ?.content,
    ).toMatchObject({ name: 'Signed Up', isGuest: false });

    guest.close();
  });

  it('stores guest rich text without script handlers', async () => {
    const caller = await getUserCaller(20);
    const board = await caller.board.create({ name: 'xss' });
    await caller.board.changePrivacy({ boardId: board.id, isPublic: true });

    const guest = await connect('tapiz_session=g4');

    await sendFrom(guest, { action: 'join', boardId: board.id });

    const client = wsServer.clients.find((it) => it.socket.id === guest.id);

    await vi.waitFor(() => {
      expect(client?.boardId).toEqual(board.id);
    });

    const textId = randomUUID();

    await sendFrom(guest, [
      {
        op: 'add',
        data: {
          type: 'text',
          id: textId,
          content: {
            text: '<img src=x onerror="alert(document.domain)"><p>hi</p>',
            position: { x: 0, y: 0 },
            width: 200,
            height: 100,
            color: '#000000',
            size: 16,
            layer: 0,
            rotation: 0,
          },
        },
      },
    ]);

    const findText = (nodes: TuNode[] | undefined) =>
      nodes?.find((it) => it.id === textId)?.content as
        { text: string } | undefined;

    await vi.waitFor(() => {
      expect(findText(wsServer.getBoard(board.id))?.text).toEqual('<p>hi</p>');
    });

    // validators and the sanitizer follow the claimed type, so a patch
    // that names another type is dropped
    await sendFrom(
      guest,
      ['comment', 'token'].map((type) => ({
        op: 'patch',
        data: {
          type,
          id: textId,
          content: { text: '<img src=x onerror="alert(document.domain)">' },
        },
      })),
    );

    expect(findText(wsServer.getBoard(board.id))?.text).toEqual('<p>hi</p>');

    // the last client leaving writes the board to the database
    guest.close();

    await vi.waitFor(async () => {
      const stored = await db.board.getBoard(board.id);

      expect(findText(stored?.board)?.text).toEqual('<p>hi</p>');
      expect(JSON.stringify(stored?.board)).not.toContain('onerror');
    });
  });
});
