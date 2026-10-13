import { randomUUID } from 'node:crypto';
import type { Server as WsServer } from 'socket.io';
import { vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  expandLayout,
  type LayoutSpecInput,
  type TuNode,
} from '@tapiz/board-commons';
import { startDB, db as drizzle } from './db/init-db.js';
import db from './db/index.js';
import { addTeamMember } from './db/user-db.js';
import * as schema from './schema.js';
import { insertTemplateAsMcpUser } from './layout-service.js';
import { Server } from './server.js';
import {
  createMultipleUsers,
  deleteTestBoards,
  getAuth,
  getUserCaller,
} from '../tests/test-helpers.js';

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

const retro: LayoutSpecInput = {
  kind: 'columns',
  title: 'Retro',
  cells: [
    { title: 'Went well', notes: ['Pairing', 'Fast reviews'] },
    { title: 'To improve', notes: ['Flaky tests'] },
    { title: 'Actions', notes: [] },
  ],
};

const template = () => expandLayout(retro, { noteColor: '#fff2cc' }).template;

const note = (id: string, ownerId: string, x = 0): TuNode => ({
  id,
  type: 'note',
  content: {
    text: '<p>existing</p>',
    position: { x, y: 0 },
    layer: 0,
    ownerId,
    votes: [],
    emojis: [],
    drawing: [],
    width: 300,
    height: 300,
    color: '#fee2e2',
  },
});

const panel = (id: string): TuNode => ({
  id,
  type: 'panel',
  content: {
    position: { x: -2000, y: 0 },
    width: 1000,
    height: 800,
    layer: 1,
    text: '<p>Existing lane</p>',
    rotation: 0,
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

const layerOf = (node: TuNode | undefined) =>
  (node?.content as { layer?: number } | undefined)?.layer;

const membershipRow = async (boardId: string, userId: string) =>
  drizzle
    .select()
    .from(schema.acountsToBoards)
    .where(
      and(
        eq(schema.acountsToBoards.boardId, boardId),
        eq(schema.acountsToBoards.accountId, userId),
      ),
    );

describe('insertTemplateAsMcpUser', () => {
  beforeAll(async () => {
    await startDB();
    await createMultipleUsers();
  });

  afterAll(async () => {
    await deleteTestBoards();
  });

  it('inserts an admin layout behind existing notes, in template order', async () => {
    const admin = mcpUser(1);
    const board = await getUserCaller(1).board.create({
      name: 'layout admin',
    });
    const existingPanel = randomUUID();
    const existingNote = randomUUID();

    await db.board.updateBoard(board.id, [
      panel(existingPanel),
      note(existingNote, admin.id),
    ]);

    const data = template();
    const result = await insertTemplateAsMcpUser(
      newServer(),
      admin,
      board.id,
      data,
    );

    expect(result.status).toBe('applied');
    expect(result.rejected).toEqual([]);
    expect(result.layerCoerced).toBe(false);
    expect(result.nodeCount).toBe(data.nodes.length);
    // right of the existing content, 400px away
    expect(result.origin).toEqual({ x: 300 + 400, y: 0 });
    expect(result.lint.filter((it) => it.level === 'error')).toEqual([]);

    const nodes = await persisted(board.id);
    const ids = nodes.map((it) => it.id);
    const panelRefs = data.nodes
      .filter((it) => it.type === 'panel')
      .map((it) => it.ref);
    const panelIds = panelRefs.map((ref) => result.refs[ref]);

    Object.values(result.refs).forEach((id) => {
      expect(ids).toContain(id);
    });

    // after the existing panel, before the existing note, in template order
    expect(ids.slice(1, 1 + panelIds.length)).toEqual(panelIds);
    expect(ids[0]).toBe(existingPanel);
    expect(ids.indexOf(existingNote)).toBeGreaterThan(
      ids.indexOf(panelIds[panelIds.length - 1]),
    );

    panelIds.forEach((id) => {
      expect(layerOf(nodes.find((it) => it.id === id))).toBe(1);
    });
    data.nodes
      .filter((it) => it.type === 'note')
      .forEach((it) => {
        const added = nodes.find((node) => node.id === result.refs[it.ref]);

        expect(layerOf(added)).toBe(0);
        expect(added?.content).toMatchObject({ ownerId: admin.id });
      });
  });

  it('moves a member layout to layer 0 with layer auto', async () => {
    const board = await teamBoard('layout member auto');
    const member = mcpUser(2);

    const result = await insertTemplateAsMcpUser(
      newServer(),
      member,
      board.id,
      template(),
    );

    expect(result.status).toBe('applied');
    expect(result.layerCoerced).toBe(true);

    const nodes = await persisted(board.id);
    const added = Object.values(result.refs).map((id) =>
      nodes.find((it) => it.id === id),
    );

    expect(added.every((it) => it && layerOf(it) === 0)).toBe(true);
  });

  it('rejects asStored for a member and leaves the board unchanged', async () => {
    const board = await teamBoard('layout member asStored');
    const member = mcpUser(2);
    const before = (await db.board.getBoard(board.id))?.board ?? [];

    const result = await insertTemplateAsMcpUser(
      newServer(),
      member,
      board.id,
      template(),
      { layer: 'asStored' },
    );

    expect(result.status).toBe('rejected');
    expect(result.refs).toEqual({});
    expect(result.rejected).toEqual([
      expect.objectContaining({
        index: -1,
        code: 'layer_admin_only',
        hint: expect.stringContaining('auto'),
      }),
    ]);

    const after = await persisted(board.id);

    expect(after.filter((it) => it.type !== 'user')).toEqual(
      before.filter((it) => it.type !== 'user'),
    );
  });

  it('writes nothing in a dry run, not even a membership row', async () => {
    const board = await teamBoard('layout dry run');
    const member = mcpUser(2);

    expect(await membershipRow(board.id, member.id)).toEqual([]);

    const data = template();
    const result = await insertTemplateAsMcpUser(
      newServer(),
      member,
      board.id,
      data,
      { dryRun: true, origin: { x: 100, y: 200 } },
    );

    expect(result.status).toBe('dry_run');
    expect(result.origin).toEqual({ x: 100, y: 200 });
    expect(result.layerCoerced).toBe(true);
    expect(result.nodes).toHaveLength(data.nodes.length);
    expect(result.nodes?.[0]).toMatchObject({
      ref: data.nodes[0].ref,
      x: 100 + data.nodes[0].content.position.x,
      y: 200 + data.nodes[0].content.position.y,
      layer: 0,
    });
    expect(await membershipRow(board.id, member.id)).toEqual([]);
    expect(await persisted(board.id)).toEqual([]);
  });

  it('rejects a member on a read-only board, dry run or not', async () => {
    const board = await teamBoard('layout read only');
    const member = mcpUser(2);
    const settings: TuNode = {
      id: randomUUID(),
      type: 'settings',
      content: { readOnly: true },
    };

    await db.board.updateBoard(board.id, [settings]);

    for (const dryRun of [true, false]) {
      const result = await insertTemplateAsMcpUser(
        newServer(),
        member,
        board.id,
        template(),
        { dryRun },
      );

      expect(result.status).toBe('rejected');
      expect(result.rejected).toEqual([
        expect.objectContaining({ index: -1, code: 'read_only' }),
      ]);
    }

    expect(
      (await persisted(board.id)).filter((it) => it.type !== 'user'),
    ).toEqual([settings]);
  });

  it('accepts the inserted notes while notes are hidden', async () => {
    const board = await teamBoard('layout notes hidden');
    const member = mcpUser(2);

    await db.board.updateBoard(board.id, [
      { id: randomUUID(), type: 'settings', content: { notesHidden: true } },
      note(randomUUID(), getAuth(1).sub),
    ]);

    const data = template();
    const result = await insertTemplateAsMcpUser(
      newServer(),
      member,
      board.id,
      data,
    );

    expect(result.status).toBe('applied');

    const nodes = await persisted(board.id);

    data.nodes
      .filter((it) => it.type === 'note')
      .forEach((it) => {
        expect(nodes.find((node) => node.id === result.refs[it.ref])).toEqual(
          expect.objectContaining({
            content: expect.objectContaining({ ownerId: member.id }),
          }),
        );
      });
  });

  it('refuses a board the user cannot access', async () => {
    const board = await getUserCaller(1).board.create({
      name: 'layout private',
    });

    await expect(
      insertTemplateAsMcpUser(newServer(), mcpUser(2), board.id, template(), {
        dryRun: true,
      }),
    ).rejects.toThrow('Unable to read board');
    await expect(
      insertTemplateAsMcpUser(newServer(), mcpUser(2), board.id, template()),
    ).rejects.toThrow('Unable to join board');
    expect(await persisted(board.id)).toEqual([]);
  });
});
