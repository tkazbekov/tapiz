import { randomUUID } from 'node:crypto';
import type { Server as WsServer } from 'socket.io';
import { vi } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
import type { TuNode } from '@tapiz/board-commons';
import { startDB } from './db/init-db.js';
import db from './db/index.js';
import {
  applyBoardActionsAsMcpUser,
  createCocomaterialNodeAction,
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
    expect(textOf(result.board, otherNote)).toEqual('');
    expect(textOf(result.board, added)).toEqual('added by mcp');
    expect(JSON.stringify(result)).not.toContain('secret of another user');
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
