import { randomUUID } from 'node:crypto';
import type { Socket, Server as WsServer } from 'socket.io';
import { vi } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
import type { StateActions, TuNode } from '@tapiz/board-commons';
import { startDB } from './db/init-db.js';
import db from './db/index.js';
import { addTeamMember } from './db/user-db.js';
import { Client } from './client.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  applyBoardActionsAsMcpUser,
  compactBoardNodes,
  createCocomaterialNodeAction,
  createTapizMcpServer,
  hideQueryDetails,
  readBoardAsMcpUser,
  TAPIZ_MCP_INSTRUCTIONS,
} from './mcp.js';
import { Server } from './server.js';
import {
  createMultipleUsers,
  deleteTestBoards,
  getAuth,
  getUserCaller,
} from '../tests/test-helpers.js';

describe('mcp', () => {
  beforeAll(async () => {
    await startDB();
    await createMultipleUsers();
  });

  afterAll(async () => {
    await deleteTestBoards();
  });

  it('exposes board-building guidance in server instructions', () => {
    expect(TAPIZ_MCP_INSTRUCTIONS).toContain('apply_board_actions');
    expect(TAPIZ_MCP_INSTRUCTIONS).toContain('notes are editable/votable');
    expect(TAPIZ_MCP_INSTRUCTIONS).toContain('panels are visual lanes');
    expect(TAPIZ_MCP_INSTRUCTIONS).toContain(
      'Do not use content.layer as z-index',
    );
    expect(TAPIZ_MCP_INSTRUCTIONS).toContain(
      'Do not invent arbitrary layers such as layer 2',
    );
    expect(TAPIZ_MCP_INSTRUCTIONS).toContain(
      'validation only accepts layers 0 and 1',
    );
    expect(TAPIZ_MCP_INSTRUCTIONS).toContain('area selection');
    expect(TAPIZ_MCP_INSTRUCTIONS).toContain(
      'Visual depth/z-index comes from node order in the board array',
    );
    expect(TAPIZ_MCP_INSTRUCTIONS).toContain(
      'later sibling nodes render above earlier sibling nodes',
    );
    expect(TAPIZ_MCP_INSTRUCTIONS).toContain('300x300');
    expect(TAPIZ_MCP_INSTRUCTIONS).toContain('leave real empty space');
    expect(TAPIZ_MCP_INSTRUCTIONS).toContain(
      'panel color instead of their own note color',
    );
    expect(TAPIZ_MCP_INSTRUCTIONS).toContain('high-contrast note colors');
    expect(TAPIZ_MCP_INSTRUCTIONS).toContain('avoid raw h1/h2/h3');
    expect(TAPIZ_MCP_INSTRUCTIONS).toContain('verify it in the web app');
  });

  it('applies board actions through a realtime client', async () => {
    const server = new Server({
      to: () => ({
        emit: vi.fn(),
      }),
      of: () => ({
        adapter: {
          rooms: new Map(),
        },
      }),
    } as unknown as WsServer);
    const caller = getUserCaller(1);
    const user = getAuth(1);
    const board = await caller.board.create({
      name: 'mcp board',
    });
    const noteId = randomUUID();

    const result = await applyBoardActionsAsMcpUser(
      server,
      {
        id: user.sub,
        name: user.name,
        email: user.email,
      },
      board.id,
      [
        {
          op: 'add',
          data: {
            id: noteId,
            type: 'note',
            content: {
              text: 'What made this sprint fun?',
              position: {
                x: 120,
                y: 80,
              },
              layer: 1,
              ownerId: user.sub,
              votes: [],
              emojis: [],
              drawing: [],
              width: 240,
              height: 160,
              color: '#fee2e2',
            },
          },
        },
      ],
    );

    expect(result.appliedActions).toHaveLength(1);
    expect(result.board).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: noteId,
          type: 'note',
        }),
      ]),
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    const persistedBoard = await db.board.getBoard(board.id);

    expect(persistedBoard?.board).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: noteId,
          type: 'note',
        }),
      ]),
    );
  });

  it('returns hidden notes of other users as blank cards', async () => {
    const server = new Server({
      to: () => ({
        emit: vi.fn(),
      }),
      of: () => ({
        adapter: {
          rooms: new Map(),
        },
      }),
    } as unknown as WsServer);
    const user = getAuth(1);
    const mcpUser = { id: user.sub, name: user.name, email: user.email };
    const board = await getUserCaller(1).board.create({
      name: 'mcp hidden notes',
    });
    const note = (id: string, ownerId: string, text: string): TuNode => ({
      id,
      type: 'note',
      content: {
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
      },
    });
    const otherNote = randomUUID();
    const ownNote = randomUUID();

    await db.board.updateBoard(board.id, [
      { id: randomUUID(), type: 'settings', content: { notesHidden: true } },
      note(otherNote, getAuth(2).sub, 'secret of another user'),
      note(ownNote, user.sub, 'my own text'),
    ]);

    const textOf = (nodes: TuNode[], id: string) =>
      (nodes.find((it) => it.id === id)?.content as { text?: string })?.text;

    const read = await readBoardAsMcpUser(server, mcpUser, board.id);

    expect(textOf(read.nodes, otherNote)).toEqual('');
    expect(textOf(read.nodes, ownNote)).toEqual('my own text');

    const added = randomUUID();
    const result = await applyBoardActionsAsMcpUser(server, mcpUser, board.id, [
      { op: 'add', data: note(added, user.sub, 'added by mcp') },
    ]);

    expect(result.appliedActions).toHaveLength(1);
    expect(textOf(result.board ?? [], otherNote)).toEqual('');
    expect(textOf(result.board ?? [], added)).toEqual('added by mcp');
    expect(JSON.stringify(result)).not.toContain('secret of another user');
  });

  describe('rejections and same-batch references', () => {
    const newServer = () =>
      new Server({
        to: () => ({
          emit: vi.fn(),
        }),
        of: () => ({
          adapter: {
            rooms: new Map(),
          },
        }),
      } as unknown as WsServer);
    const mcpUser = (index: number) => {
      const auth = getAuth(index);

      return { id: auth.sub, name: auth.name, email: auth.email };
    };
    const noteAction = (
      id: string,
      ownerId: string,
      layer = 0,
    ): StateActions => ({
      op: 'add',
      data: {
        id,
        type: 'note',
        content: {
          text: '<p>idea</p>',
          position: { x: 0, y: 400 },
          layer,
          ownerId,
          votes: [],
          emojis: [],
          drawing: [],
          width: 300,
          height: 300,
          color: '#fee2e2',
        },
      },
    });
    const panelAction = (id: string): StateActions => ({
      op: 'add',
      data: {
        id,
        type: 'panel',
        content: {
          position: { x: 0, y: 0 },
          width: 1000,
          height: 800,
          layer: 1,
          text: '<p>Lane</p>',
          rotation: 0,
        },
      },
    });
    // user 2 is a plain member: the board belongs to a team user 2 is in
    const teamBoard = async (name: string) => {
      const caller = getUserCaller(1);
      const team = await caller.team.new({ name: `${name} team` });

      await addTeamMember(getAuth(2).sub, team.id, 'member');

      return caller.board.create({ name, teamId: team.id });
    };
    const persisted = async (boardId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 100));

      return (await db.board.getBoard(boardId))?.board ?? [];
    };

    it('rejects a layer-1 node from a member and applies nothing', async () => {
      const board = await teamBoard('mcp member layers');
      const member = mcpUser(2);
      const noteId = randomUUID();

      const result = await applyBoardActionsAsMcpUser(
        newServer(),
        member,
        board.id,
        [panelAction(randomUUID()), noteAction(noteId, member.id)],
      );

      expect(result.status).toBe('rejected');
      expect(result.appliedActions).toEqual([]);
      expect(result.rejected).toEqual([
        expect.objectContaining({
          index: 0,
          op: 'add',
          type: 'panel',
          code: 'layer_admin_only',
          hint: expect.stringContaining('layer 0'),
        }),
        expect.objectContaining({
          index: 1,
          id: noteId,
          code: 'batch_aborted',
        }),
      ]);
      expect((await persisted(board.id)).some((it) => it.id === noteId)).toBe(
        false,
      );
    });

    it('applies a note and a comment on it in one batch', async () => {
      const board = await getUserCaller(1).board.create({
        name: 'mcp same batch',
      });
      const user = mcpUser(1);
      const noteId = randomUUID();
      const commentId = randomUUID();

      const result = await applyBoardActionsAsMcpUser(
        newServer(),
        user,
        board.id,
        [
          noteAction(noteId, user.id),
          {
            op: 'patch',
            data: {
              id: noteId,
              type: 'note',
              content: { text: '<p>edited</p>' },
            },
          },
          {
            op: 'add',
            parent: noteId,
            data: {
              id: commentId,
              type: 'comment',
              content: { text: 'first', userId: user.id, date: 1 },
            },
          },
        ],
      );

      expect(result.status).toBe('applied');
      expect(result.rejected).toEqual([]);
      expect(result.appliedActions).toHaveLength(3);

      const note = (await persisted(board.id)).find((it) => it.id === noteId);

      expect(note?.content).toMatchObject({ text: '<p>edited</p>' });
      expect(note?.children).toEqual([
        expect.objectContaining({ id: commentId, type: 'comment' }),
      ]);
    });

    it('reports read_only for a member on a read-only board', async () => {
      const board = await teamBoard('mcp read only');
      const member = mcpUser(2);

      await db.board.updateBoard(board.id, [
        { id: randomUUID(), type: 'settings', content: { readOnly: true } },
      ]);

      const result = await applyBoardActionsAsMcpUser(
        newServer(),
        member,
        board.id,
        [noteAction(randomUUID(), member.id)],
      );

      expect(result.status).toBe('rejected');
      expect(result.rejected).toEqual([
        expect.objectContaining({
          index: 0,
          code: 'read_only',
          hint: expect.any(String),
        }),
      ]);
      expect(
        (await persisted(board.id)).filter((it) => it.type === 'note'),
      ).toEqual([]);
    });

    it('leaves the board out when includeBoard is false', async () => {
      const board = await getUserCaller(1).board.create({
        name: 'mcp no board',
      });
      const user = mcpUser(1);

      const result = await applyBoardActionsAsMcpUser(
        newServer(),
        user,
        board.id,
        [noteAction(randomUUID(), user.id)],
        { includeBoard: false },
      );

      expect(result.status).toBe('applied');
      expect(result.appliedActions).toHaveLength(1);
      expect(result).not.toHaveProperty('board');
    });

    it('describes the viewer and a compact board', async () => {
      const board = await teamBoard('mcp viewer');
      const noteId = randomUUID();

      await db.board.updateBoard(board.id, [
        {
          id: randomUUID(),
          type: 'settings',
          content: { readOnly: true, notesHidden: true },
        },
        {
          id: noteId,
          type: 'note',
          content: {
            text: `<p>${'a'.repeat(100)} &amp; <strong>${'b'.repeat(100)}</strong></p>`,
            position: { x: 10, y: 20 },
            layer: 0,
            ownerId: getAuth(2).sub,
            votes: [],
            emojis: [],
            drawing: [],
            width: 300,
            height: 300,
            color: '#fee2e2',
          },
          children: [
            {
              id: 'comment-1',
              type: 'comment',
              content: { text: 'c', userId: getAuth(2).sub, date: 1 },
            },
          ],
        },
      ]);

      const server = newServer();
      const admin = await readBoardAsMcpUser(server, mcpUser(1), board.id);
      const member = await readBoardAsMcpUser(server, mcpUser(2), board.id);

      expect(admin.viewer).toEqual({
        userId: getAuth(1).sub,
        isAdmin: true,
        readOnly: true,
        notesHidden: true,
      });
      expect(member.viewer).toMatchObject({
        userId: getAuth(2).sub,
        isAdmin: false,
      });

      // the admin sees the member's hidden note as a blank card
      expect(compactBoardNodes(admin.nodes)).toContainEqual({
        id: noteId,
        type: 'note',
        layer: 0,
        x: 10,
        y: 20,
        width: 300,
        height: 300,
      });

      const compact = compactBoardNodes(member.nodes);
      const note = compact.find((it) => it.id === noteId);

      expect(note?.text).toHaveLength(120);
      expect(note?.text).toMatch(/^a+ & b+$/);
      expect(compact).toContainEqual(
        expect.objectContaining({
          id: 'comment-1',
          type: 'comment',
          parent: noteId,
          text: 'c',
        }),
      );
    });

    it('serves compact boards and full results through the tools', async () => {
      const board = await teamBoard('mcp tools');
      const noteId = randomUUID();
      const ownNoteId = randomUUID();
      const server = newServer();
      const admin = mcpUser(1);

      await db.board.updateBoard(board.id, [
        {
          id: randomUUID(),
          type: 'settings',
          content: { notesHidden: true },
        },
        {
          ...noteAction(noteId, getAuth(2).sub).data,
          content: {
            ...(noteAction(noteId, getAuth(2).sub).data.content as object),
            text: '<p>secret of the member</p>',
          },
          children: [
            {
              id: 'comment-1',
              type: 'comment',
              content: { text: 'c', userId: getAuth(2).sub, date: 1 },
            },
          ],
        } as TuNode,
        {
          ...noteAction(ownNoteId, admin.id).data,
          children: [
            {
              id: 'comment-2',
              type: 'comment',
              content: { text: 'c', userId: admin.id, date: 1 },
            },
          ],
        } as TuNode,
      ]);

      const callTool = async (name: string, args: Record<string, unknown>) => {
        const [clientTransport, serverTransport] =
          InMemoryTransport.createLinkedPair();
        const client = new McpClient({ name: 'test', version: '0.0.0' });

        await createTapizMcpServer(server, admin).connect(serverTransport);
        await client.connect(clientTransport);

        const result = await client.callTool({ name, arguments: args });

        await client.close();

        return JSON.parse(
          (result.content as { type: 'text'; text: string }[])[0].text,
        );
      };

      const compact = await callTool('get_board', {
        boardId: board.id,
        format: 'compact',
      });
      const ids = compact.nodes.map((it: { id: string }) => it.id);

      // the member's hidden note is a blank card without its comments
      expect(compact.nodes[ids.indexOf(noteId)]).not.toHaveProperty('text');
      expect(ids).not.toContain('comment-1');
      expect(compact.nodes[ids.indexOf(ownNoteId) + 1]).toMatchObject({
        id: 'comment-2',
        parent: ownNoteId,
      });

      const written = await callTool('apply_board_actions', {
        boardId: board.id,
        actions: [noteAction(randomUUID(), admin.id)],
      });

      expect(written.status).toBe('applied');
      expect(Array.isArray(written.board)).toBe(true);
    });

    it('reports board_unavailable without a joined board', async () => {
      const client = new Client(
        { on: () => undefined } as unknown as Socket,
        newServer(),
        { id: 'user-1', name: 'user', isGuest: false, sessionId: null },
      );

      await expect(
        client.applyStateActions([noteAction('note-1', 'user-1')]),
      ).resolves.toEqual({
        applied: [],
        rejected: [
          expect.objectContaining({ index: 0, code: 'board_unavailable' }),
        ],
      });
    });
  });

  it('creates a Tapiz vector action from a Cocomaterial asset', () => {
    const action = createCocomaterialNodeAction({
      url: 'https://cocomaterial.com/media/sea_starfish_1.svg',
      width: 150,
      height: 100,
      center: {
        x: 300,
        y: 200,
      },
      layer: 1,
      rotation: 0,
    });

    expect(action).toEqual({
      op: 'add',
      data: {
        id: expect.any(String),
        type: 'vector',
        content: {
          url: 'https://cocomaterial.com/media/sea_starfish_1.svg',
          width: 150,
          height: 100,
          position: {
            x: 225,
            y: 150,
          },
          layer: 1,
          rotation: 0,
        },
      },
    });
  });

  it('hides the SQL and params of failed queries from tool errors', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const handler = hideQueryDetails(
      async ({ boardId }: { boardId: string }) => {
        throw new DrizzleQueryError(
          'select "board" from "boards" where "id" = $1',
          [boardId],
          new Error('duplicate key value violates unique constraint'),
        );
      },
    );

    const error = await handler({ boardId: 'secret-board-id' }).catch(
      (e: Error) => e,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'duplicate key value violates unique constraint',
    );
    expect((error as Error).message).not.toContain('Failed query');
    expect((error as Error).message).not.toContain('secret-board-id');

    const other = new Error('Unable to read board with this API token');

    await expect(
      hideQueryDetails(async () => {
        throw other;
      })(),
    ).rejects.toBe(other);

    consoleError.mockRestore();
  });
});
