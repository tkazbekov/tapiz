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

  it('switching boards sends each board only its own updates', async () => {
    const owner = await getUserCaller(60);
    const boardA = await owner.board.create({ name: 'switch A' });
    const boardB = await owner.board.create({ name: 'switch B' });
    await owner.board.changePrivacy({ boardId: boardA.id, isPublic: true });
    await owner.board.changePrivacy({ boardId: boardB.id, isPublic: true });

    const moverId = getAuth(61).sub;
    const mover = await connect('tapiz_session=61');
    const watcherA = await connect('tapiz_session=62');
    const watcherB = await connect('tapiz_session=63');

    await sendFrom(watcherA, { action: 'join', boardId: boardA.id });
    await sendFrom(watcherB, { action: 'join', boardId: boardB.id });
    await sendFrom(mover, { action: 'join', boardId: boardA.id });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const framesOf = (ws: typeof socket) => {
      const frames: string[] = [];
      ws.on('board', (msg: unknown) => frames.push(JSON.stringify(msg)));

      return frames;
    };
    const seenByA = framesOf(watcherA);
    const seenByB = framesOf(watcherB);

    // in-app navigation: leave, then join the next board right away
    mover.emit('leaveBoard');
    mover.emit('board', { action: 'join', boardId: boardB.id });

    const joinedB = (frame: string) =>
      frame.includes(moverId) && frame.includes('"connected":true');

    await vi.waitFor(() => {
      expect(seenByB.some(joinedB)).toEqual(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(seenByA.some(joinedB)).toEqual(false);

    [mover, watcherA, watcherB].forEach((tab) => tab.close());
  });

  it('disconnects sockets that flood events', async () => {
    const tab = await connect('tapiz_session=64');
    let disconnected = false;
    tab.on('disconnect', () => (disconnected = true));

    for (let i = 0; i < 300; i++) {
      tab.emit('correlationId', `flood-${i}`);
    }

    await vi.waitFor(() => {
      expect(disconnected).toEqual(true);
    });
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

  it('applies settings added after the board loaded', async () => {
    const owner = await getUserCaller(22);
    const board = await owner.board.create({ name: 'late settings' });
    await owner.board.changePrivacy({ boardId: board.id, isPublic: true });

    const admin = await connect('tapiz_session=22');
    const member = await connect('tapiz_session=23');
    await sendFrom(admin, { action: 'join', boardId: board.id });
    await sendFrom(member, { action: 'join', boardId: board.id });

    // the board has no settings node yet, so this is the first one
    await sendFrom(admin, [
      {
        op: 'add',
        data: {
          id: randomUUID(),
          type: 'settings',
          content: { readOnly: true },
        },
      },
    ]);

    await vi.waitFor(() => {
      expect(
        wsServer.getBoard(board.id)?.some((it) => it.type === 'settings'),
      ).toEqual(true);
    });

    const noteId = randomUUID();

    await sendFrom(member, [
      {
        op: 'add',
        data: {
          id: noteId,
          type: 'note',
          content: {
            text: 'read only',
            position: { x: 0, y: 0 },
            layer: 0,
            ownerId: getAuth(23).sub,
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
      false,
    );

    admin.close();
    member.close();
  });

  it('lets only board admins edit the background layer', async () => {
    const owner = await getUserCaller(24);
    const team = await db.team.createTeam('layers', getAuth(24).sub);
    await addTeamMember(getAuth(25).sub, team.id, 'admin');
    await addTeamMember(getAuth(26).sub, team.id, 'member');
    const board = await owner.board.create({
      name: 'layers',
      teamId: team.id,
    });

    const teamAdmin = await connect('tapiz_session=25');
    const member = await connect('tapiz_session=26');
    await sendFrom(teamAdmin, { action: 'join', boardId: board.id });
    await sendFrom(member, { action: 'join', boardId: board.id });

    // a team admin only holds a member role on the board itself
    expect((await getBoardUser(board.id, getAuth(25).sub))?.role).toEqual(
      'member',
    );

    const addPanel = (ws: typeof socket, id: string) =>
      sendFrom(ws, [
        {
          op: 'add',
          data: {
            id,
            type: 'panel',
            content: {
              position: { x: 0, y: 0 },
              width: 400,
              height: 400,
              layer: 1,
            },
          },
        },
      ]);

    const memberPanel = randomUUID();
    const adminPanel = randomUUID();

    await addPanel(member, memberPanel);
    await addPanel(teamAdmin, adminPanel);

    await vi.waitFor(() => {
      expect(
        wsServer.getBoard(board.id)?.some((it) => it.id === adminPanel),
      ).toEqual(true);
    });
    expect(
      wsServer.getBoard(board.id)?.some((it) => it.id === memberPanel),
    ).toEqual(false);

    teamAdmin.close();
    member.close();
  });

  describe('votes', () => {
    const noteContent = (ownerId: string) => ({
      text: 'vote me',
      position: { x: 0, y: 0 },
      layer: 0,
      ownerId,
      votes: [],
      emojis: [],
      drawing: [],
      width: 240,
      height: 160,
      color: '#fee2e2',
    });

    const voteOn = (
      noteId: string,
      votes: { userId: string; vote: number }[],
    ) => [
      { op: 'patch', data: { id: noteId, type: 'note', content: { votes } } },
    ];

    const storedVotes = (boardId: string, noteId: string) =>
      (
        wsServer.getBoard(boardId)?.find((it) => it.id === noteId)?.content as
          { votes: { userId: string; vote: number }[] } | undefined
      )?.votes;

    // owner (admin) and a member on a public board with one note
    const votingBoard = async (owner: number, member: number) => {
      const caller = await getUserCaller(owner);
      const board = await caller.board.create({ name: 'votes' });
      await caller.board.changePrivacy({ boardId: board.id, isPublic: true });

      const admin = await connect(`tapiz_session=${owner}`);
      const other = await connect(`tapiz_session=${member}`);
      await sendFrom(admin, { action: 'join', boardId: board.id });
      await sendFrom(other, { action: 'join', boardId: board.id });

      const noteId = randomUUID();

      await sendFrom(admin, [
        {
          op: 'add',
          data: {
            id: noteId,
            type: 'note',
            content: noteContent(getAuth(owner).sub),
          },
        },
      ]);

      await vi.waitFor(() => {
        expect(storedVotes(board.id, noteId)).toEqual([]);
      });

      return { board, admin, other, noteId };
    };

    it('broadcasts the votes stored when the batch is sent', async () => {
      const { admin, other, noteId } = await votingBoard(45, 46);
      const adminId = getAuth(45).sub;
      const otherId = getAuth(46).sub;

      const frames: string[] = [];
      admin.on('board', (msg: unknown) => frames.push(JSON.stringify(msg)));

      // the member's vote is queued for the admin, then the admin votes
      // before that batch goes out
      other.emit('board', voteOn(noteId, [{ userId: otherId, vote: 1 }]));
      await new Promise((resolve) => setTimeout(resolve, 10));
      admin.emit('board', voteOn(noteId, [{ userId: adminId, vote: 1 }]));

      await vi.waitFor(() => {
        expect(frames.some((it) => it.includes('State action'))).toEqual(true);
      });

      const broadcast = frames.find((it) => it.includes('State action'));

      expect(broadcast).toContain(`{"userId":"${adminId}","vote":1}`);

      admin.close();
      other.close();
    });

    it('keeps concurrent votes of two users', async () => {
      const { board, admin, other, noteId } = await votingBoard(27, 28);
      const adminId = getAuth(27).sub;
      const otherId = getAuth(28).sub;

      // each client only knows its own vote
      admin.emit('board', voteOn(noteId, [{ userId: adminId, vote: 1 }]));
      other.emit('board', voteOn(noteId, [{ userId: otherId, vote: 1 }]));

      await vi.waitFor(() => {
        expect(storedVotes(board.id, noteId)).toHaveLength(2);
      });
      expect(storedVotes(board.id, noteId)).toEqual(
        expect.arrayContaining([
          { userId: adminId, vote: 1 },
          { userId: otherId, vote: 1 },
        ]),
      );

      admin.close();
      other.close();
    });

    it("can't remove the vote of another user", async () => {
      const { board, admin, other, noteId } = await votingBoard(29, 30);
      const adminId = getAuth(29).sub;

      await sendFrom(admin, voteOn(noteId, [{ userId: adminId, vote: 2 }]));
      await sendFrom(other, voteOn(noteId, []));
      await sendFrom(other, voteOn(noteId, [{ userId: adminId, vote: 0 }]));

      expect(storedVotes(board.id, noteId)).toEqual([
        { userId: adminId, vote: 2 },
      ]);

      admin.close();
      other.close();
    });

    it('clamps votes over the budget and corrects the sender', async () => {
      const { board, admin, other, noteId } = await votingBoard(31, 32);
      const otherId = getAuth(32).sub;

      await sendFrom(admin, [
        {
          op: 'add',
          data: {
            id: randomUUID(),
            type: 'settings',
            content: { votesPerUser: 2 },
          },
        },
      ]);

      const frames: string[] = [];
      other.on('board', (msg: unknown) => frames.push(JSON.stringify(msg)));

      await sendFrom(other, voteOn(noteId, [{ userId: otherId, vote: 1 }]));
      await sendFrom(other, voteOn(noteId, [{ userId: otherId, vote: 2 }]));

      expect(frames).toEqual([]);

      await sendFrom(other, voteOn(noteId, [{ userId: otherId, vote: 3 }]));

      expect(storedVotes(board.id, noteId)).toEqual([
        { userId: otherId, vote: 2 },
      ]);

      await vi.waitFor(() => {
        expect(frames).toHaveLength(1);
      });
      expect(JSON.parse(frames[0])).toEqual([
        {
          type: '[Board] Vote correction',
          data: voteOn(noteId, [{ userId: otherId, vote: 2 }]),
        },
      ]);

      admin.close();
      other.close();
    });
  });

  describe('hidden notes', () => {
    const noteContent = (ownerId: string, text: string) => ({
      text,
      position: { x: 0, y: 0 },
      layer: 0,
      ownerId,
      votes: [],
      emojis: [],
      drawing: [],
      width: 240,
      height: 160,
      color: '#fee2e2',
    });

    const addNote = (
      ws: typeof socket,
      id: string,
      ownerId: string,
      text: string,
    ) =>
      sendFrom(ws, [
        {
          op: 'add',
          data: { id, type: 'note', content: noteContent(ownerId, text) },
        },
      ]);

    const framesOf = (ws: typeof socket) => {
      const frames: string[] = [];
      ws.on('board', (msg: unknown) => frames.push(JSON.stringify(msg)));

      return frames;
    };

    const messagesOf = (frames: string[], type: string) =>
      frames
        .flatMap(
          (frame) => JSON.parse(frame) as { type: string; data: unknown }[],
        )
        .filter((msg) => msg.type === type);

    const nodeIn = (nodes: unknown, id: string) =>
      (nodes as TuNode<Record<string, unknown>>[]).find((it) => it.id === id);

    const stored = (boardId: string, id: string) =>
      wsServer.getBoard(boardId)?.find((it) => it.id === id)?.content as
        Record<string, unknown> | undefined;

    const setHidden = async (
      ws: typeof socket,
      boardId: string,
      notesHidden: boolean,
    ) => {
      const settings = wsServer
        .getBoard(boardId)
        ?.find((it) => it.type === 'settings');

      await sendFrom(ws, [
        {
          op: settings ? 'patch' : 'add',
          data: {
            id: settings?.id ?? randomUUID(),
            type: 'settings',
            content: { notesHidden },
          },
        },
      ]);

      await vi.waitFor(() => {
        expect(wsServer.getBoardSettings(boardId).notesHidden).toEqual(
          notesHidden,
        );
      });
    };

    // admin (two tabs) and a member on a public board, with one admin note
    const hiddenBoard = async (owner: number, member: number, hide = true) => {
      const caller = await getUserCaller(owner);
      const board = await caller.board.create({ name: 'hidden notes' });
      await caller.board.changePrivacy({ boardId: board.id, isPublic: true });

      const admin = await connect(`tapiz_session=${owner}`);
      const adminTab = await connect(`tapiz_session=${owner}`);
      const other = await connect(`tapiz_session=${member}`);

      for (const ws of [admin, adminTab, other]) {
        await sendFrom(ws, { action: 'join', boardId: board.id });
      }

      const noteId = randomUUID();

      await addNote(admin, noteId, getAuth(owner).sub, 'secret-a');

      await vi.waitFor(() => {
        expect(stored(board.id, noteId)?.['text']).toEqual('secret-a');
      });

      if (hide) {
        await setHidden(admin, board.id, true);
      }

      const close = () => [admin, adminTab, other].forEach((ws) => ws.close());

      return { board, admin, adminTab, other, noteId, close };
    };

    it('sends the content of a hidden note to its owner only', async () => {
      const { board, admin, adminTab, other, noteId, close } =
        await hiddenBoard(33, 34);
      const adminId = getAuth(33).sub;
      const otherId = getAuth(34).sub;
      const seenByAdmin = framesOf(admin);
      const seenByTab = framesOf(adminTab);
      const seenByOther = framesOf(other);
      const otherNote = randomUUID();

      await addNote(other, otherNote, otherId, 'secret-b');

      await vi.waitFor(() => {
        expect(seenByAdmin.some((it) => it.includes(otherNote))).toEqual(true);
      });
      expect(seenByAdmin.join()).not.toContain('secret-b');
      expect(
        nodeIn(
          messagesOf(seenByAdmin, '[Board] State action').flatMap((msg) =>
            (msg.data as { data: TuNode }[]).map((it) => it.data),
          ),
          otherNote,
        )?.content,
      ).toMatchObject({ text: '', ownerId: otherId });

      // the owner's text patch reaches the other tab, but not its text
      await sendFrom(admin, [
        {
          op: 'patch',
          data: {
            id: noteId,
            type: 'note',
            content: { text: 'secret-a2', position: { x: 50, y: 50 } },
          },
        },
      ]);

      await vi.waitFor(() => {
        expect(seenByTab.join()).toContain('secret-a2');
        expect(
          seenByOther.some(
            (it) => it.includes(noteId) && it.includes('"x":50'),
          ),
        ).toEqual(true);
      });
      expect(seenByOther.join()).not.toContain('secret-a');

      // a text-only patch doesn't reach others at all
      await sendFrom(admin, [
        {
          op: 'patch',
          data: { id: noteId, type: 'note', content: { text: 'secret-a3' } },
        },
      ]);

      await vi.waitFor(() => {
        expect(seenByTab.join()).toContain('secret-a3');
      });
      expect(seenByOther.join()).not.toContain('secret-a');

      // a new tab loads a masked board
      const otherTab = await connect('tapiz_session=34');
      const snapshot = framesOf(otherTab);

      await sendFrom(otherTab, { action: 'join', boardId: board.id });

      await vi.waitFor(() => {
        expect(messagesOf(snapshot, '[Board] Set state')).toHaveLength(1);
      });

      const [{ data: nodes }] = messagesOf(snapshot, '[Board] Set state');

      expect(nodeIn(nodes, noteId)?.content).toMatchObject({
        text: '',
        ownerId: adminId,
      });
      expect(nodeIn(nodes, otherNote)?.content).toMatchObject({
        text: 'secret-b',
      });
      expect(snapshot.join()).not.toContain('secret-a');

      otherTab.close();
      close();
    });

    it('lets others move a hidden note but not edit it', async () => {
      const { board, other, noteId, close } = await hiddenBoard(35, 36);
      const otherId = getAuth(36).sub;

      await sendFrom(other, [
        {
          op: 'patch',
          data: { id: noteId, type: 'note', content: { text: 'hijacked' } },
        },
      ]);
      await sendFrom(other, [
        {
          op: 'patch',
          data: {
            id: noteId,
            type: 'note',
            content: { votes: [{ userId: otherId, vote: 1 }] },
          },
        },
      ]);
      await sendFrom(other, [
        { op: 'remove', data: { id: noteId, type: 'note' } },
      ]);
      await sendFrom(other, [
        {
          op: 'patch',
          data: {
            id: noteId,
            type: 'note',
            content: { position: { x: 70, y: 80 }, width: 300 },
          },
        },
      ]);

      expect(stored(board.id, noteId)).toMatchObject({
        text: 'secret-a',
        votes: [],
        position: { x: 70, y: 80 },
        width: 300,
      });

      close();
    });

    it('resyncs every socket when notes are hidden or revealed', async () => {
      const { board, admin, other, noteId, close } = await hiddenBoard(
        37,
        38,
        false,
      );
      const seenByAdmin = framesOf(admin);
      const seenByOther = framesOf(other);
      const resyncs = (frames: string[]) =>
        messagesOf(frames, '[Board] Resync state').map(
          (msg) => nodeIn(msg.data, noteId)?.content['text'],
        );

      await setHidden(admin, board.id, true);

      await vi.waitFor(() => {
        expect(resyncs(seenByOther)).toEqual(['']);
        expect(resyncs(seenByAdmin)).toEqual(['secret-a']);
      });

      await setHidden(admin, board.id, false);

      await vi.waitFor(() => {
        expect(resyncs(seenByOther)).toEqual(['', 'secret-a']);
        expect(resyncs(seenByAdmin)).toEqual(['secret-a', 'secret-a']);
      });

      // other settings don't resync
      await sendFrom(admin, [
        {
          op: 'patch',
          data: {
            id: wsServer
              .getBoard(board.id)
              ?.find((it) => it.type === 'settings')?.id,
            type: 'settings',
            content: { readOnly: false },
          },
        },
      ]);

      expect(resyncs(seenByOther)).toHaveLength(2);

      close();
    });

    it('keeps notes hidden after the board reloads', async () => {
      const { board, close } = await hiddenBoard(41, 42);

      // the last leave empties the board; its user patches flush afterwards
      close();

      await vi.waitFor(() => {
        expect(wsServer.getBoard(board.id)).toBeUndefined();
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const admin = await connect('tapiz_session=41');
      const other = await connect('tapiz_session=42');
      await sendFrom(admin, { action: 'join', boardId: board.id });
      await sendFrom(other, { action: 'join', boardId: board.id });

      const seenByOther = framesOf(other);
      const noteId = randomUUID();

      await addNote(admin, noteId, getAuth(41).sub, 'secret-reloaded');

      await vi.waitFor(() => {
        expect(seenByOther.some((it) => it.includes(noteId))).toEqual(true);
      });
      expect(seenByOther.join()).not.toContain('secret-reloaded');

      admin.close();
      other.close();
    });

    it("doesn't broadcast notes of a board that isn't loaded", () => {
      const action = (type: string) => ({
        type: '[Board] State action',
        data: [{ op: 'patch', data: { id: randomUUID(), type, content: {} } }],
      });

      expect(wsServer.needsMasking(randomUUID(), [action('note')])).toEqual(
        true,
      );
      expect(wsServer.needsMasking(randomUUID(), [action('user')])).toEqual(
        false,
      );
    });

    it('copies the live board with hidden notes blank', async () => {
      const { board, other, noteId, close } = await hiddenBoard(43, 44);
      const ownNote = randomUUID();

      await addNote(other, ownNote, getAuth(44).sub, 'secret-copier');

      // the stored board lags behind the live one
      const stored = (await db.board.getBoard(board.id))?.board;

      expect(nodeIn(stored, ownNote)).toBeUndefined();

      const copy = await getUserCaller(44).board.duplicate({
        boardId: board.id,
      });
      const nodes = (await db.board.getBoard(copy.id))?.board ?? [];

      expect(nodeIn(nodes, ownNote)?.content['text']).toEqual('secret-copier');
      expect(nodeIn(nodes, noteId)?.content['text']).toEqual('');
      expect(JSON.stringify(nodes)).not.toContain('secret-a');

      close();
    });

    it('keeps the comments of a hidden note from others', async () => {
      const { board, admin, adminTab, other, noteId, close } =
        await hiddenBoard(39, 40);
      const seenByTab = framesOf(adminTab);
      const seenByOther = framesOf(other);
      const commentId = randomUUID();

      await sendFrom(admin, [
        {
          op: 'add',
          parent: noteId,
          data: {
            id: commentId,
            type: 'comment',
            content: {
              text: 'secret-comment',
              userId: getAuth(39).sub,
              date: 1,
            },
          },
        },
      ]);

      await vi.waitFor(() => {
        expect(seenByTab.join()).toContain('secret-comment');
      });
      expect(seenByOther.join()).not.toContain(commentId);

      // nor can others comment on it
      await sendFrom(other, [
        {
          op: 'add',
          parent: noteId,
          data: {
            id: randomUUID(),
            type: 'comment',
            content: { text: 'hi', userId: getAuth(40).sub, date: 1 },
          },
        },
      ]);

      expect(
        wsServer.getBoard(board.id)?.find((it) => it.id === noteId)?.children,
      ).toHaveLength(1);

      close();
    });
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
