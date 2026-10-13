import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { TuNode } from '@tapiz/board-commons';
import { db as drizzleDb, startDB } from '../app/db/init-db';
import db from '../app/db';
import { boardTemplates } from '../app/schema';
import {
  TEMPLATE_QUOTAS,
  saveTemplateFromBoard,
} from '../app/template-service';
import {
  createGuest,
  createMultipleUsers,
  deleteTestBoards,
  deleteTestTemplates,
  errorCall,
  getAuth,
  getGuestCaller,
  getUserCaller,
} from './test-helpers';

const OWNER = 1; // team admin
const MEMBER = 2;
const CREATOR = 3; // team member who saves a team template
const OUTSIDER = 4; // in another team
const BOARD_ADMIN = 5; // admin of the team board, not in the team

const panel = (
  id: string,
  x: number,
  y: number,
  size: number,
  text = '<p>Lane</p>',
): TuNode => ({
  id,
  type: 'panel',
  content: {
    position: { x, y },
    width: size,
    height: size,
    layer: 1,
    text,
    rotation: 0,
    drawing: [],
  },
});

const note = (
  id: string,
  x: number,
  y: number,
  ownerId: string,
  text = `<p>${id}</p>`,
): TuNode => ({
  id,
  type: 'note',
  content: {
    position: { x, y },
    width: 300,
    height: 300,
    layer: 0,
    text,
    votes: [{ userId: ownerId, vote: 1 }],
    emojis: [],
    drawing: [],
    ownerId,
  },
});

const text = (id: string, x: number, y: number, html: string): TuNode => ({
  id,
  type: 'text',
  content: {
    position: { x, y },
    width: 400,
    height: 100,
    layer: 0,
    text: html,
    rotation: 0,
  },
});

const asset = (id: string, type: string, x: number, url: string): TuNode => ({
  id,
  type,
  content: {
    position: { x, y: 0 },
    width: 50,
    height: 50,
    layer: 0,
    rotation: 0,
    url,
  },
});

const arrow = (id: string, start: string, end: string): TuNode => ({
  id,
  type: 'arrow',
  content: {
    position: { x: 100, y: 100 },
    width: 2000,
    height: 100,
    layer: 0,
    start: { x: 0, y: 0 },
    end: { x: 2000, y: 100 },
    strokeStyle: 'solid',
    arrowType: 'sharp',
    startAttachment: { nodeId: start, offset: { x: 300, y: 150 } },
    endAttachment: { nodeId: end, offset: { x: 0, y: 150 } },
  },
});

const settings = (notesHidden = false): TuNode => ({
  id: 'settings',
  type: 'settings',
  content: { notesHidden },
});

const boardNodes = (): TuNode[] => [
  settings(),
  { id: getAuth(OWNER).sub, type: 'user', content: { name: 'Owner' } },
  { id: 'timer', type: 'timer', content: {} },
  panel(
    'panel-1',
    0,
    0,
    1000,
    '<p>Lane</p><script>alert(1)</script><img src="x" onerror="alert(1)">',
  ),
  note('note-a', 100, 200, getAuth(OWNER).sub),
  note('note-b', 500, 200, getAuth(MEMBER).sub),
  text('text-1', 100, 700, '<p>Hi<script>alert(1)</script></p>'),
  note('note-out', 2000, 0, getAuth(OWNER).sub),
  arrow('arrow-1', 'note-a', 'note-out'),
  asset('image-web', 'image', 1200, 'https://example.com/a.png'),
  asset('image-upload', 'image', 1300, 'f81d4fae-7dec.png'),
  asset('vector-data', 'vector', 1400, 'data:image/svg+xml;base64,AAAA'),
  asset('vector-web', 'vector', 1500, 'https://example.com/v.svg'),
];

// a valid template row, written straight to the table
const templateRow = (
  scope: { accountId: string } | { teamId: string },
  data: unknown = {
    version: 1,
    size: { width: 300, height: 300 },
    nodes: [
      {
        ref: 'n0',
        type: 'note',
        content: {
          ...note('n0', 0, 0, '').content,
          votes: [],
        },
      },
    ],
  },
) => ({
  name: 'Seeded template',
  data: data as typeof boardTemplates.$inferInsert.data,
  nodeCount: 1,
  width: 300,
  height: 300,
  accountId: null,
  teamId: null,
  ...scope,
});

describe('Api - templates', () => {
  let teamId: string;
  let otherTeamId: string;
  let boardId: string;

  const save = (
    userIndex: number,
    input: Partial<
      Parameters<
        ReturnType<typeof getUserCaller>['template']['createFromBoard']
      >[0]
    > = {},
  ) =>
    getUserCaller(userIndex).template.createFromBoard({
      boardId,
      nodeIds: ['panel-1'],
      name: 'Retro',
      scope: 'personal',
      ...input,
    });

  beforeAll(async () => {
    await startDB();
    await createMultipleUsers();

    teamId = (await getUserCaller(OWNER).team.new({ name: 'Templates team' }))
      .id;
    otherTeamId = (
      await getUserCaller(OUTSIDER).team.new({ name: 'Other team' })
    ).id;

    await db.user.addTeamMember(getAuth(MEMBER).sub, teamId, 'member');
    await db.user.addTeamMember(getAuth(CREATOR).sub, teamId, 'member');

    boardId = (
      await db.board.createBoard(
        'Templates board',
        getAuth(OWNER).sub,
        boardNodes(),
        teamId,
      )
    ).id;

    await db.user.addBoardMember(getAuth(BOARD_ADMIN).sub, boardId, 'admin');
  });

  afterAll(async () => {
    await deleteTestTemplates();
    await deleteTestBoards();
  });

  describe('createFromBoard', () => {
    it('saves a panel with the nodes inside it, in board order', async () => {
      const result = await save(OWNER);

      expect(result.template).toMatchObject({
        name: 'Retro',
        scope: { kind: 'personal' },
        nodeCount: 4,
        width: 1000,
        height: 1000,
        createdBy: getAuth(OWNER).sub,
        canEdit: true,
      });
      expect(result.dropped).toEqual([]);
      expect(result.detachedArrows).toEqual([]);

      const { data } = await getUserCaller(OWNER).template.get({
        templateId: result.template.id,
      });

      expect(data.nodes.map((it) => it.ref)).toEqual([
        'panel-1',
        'note-a',
        'note-b',
        'text-1',
      ]);
      expect(data.nodes[1].content).toMatchObject({
        position: { x: 100, y: 200 },
        ownerId: '',
        votes: [],
      });
    });

    it('takes only the selected nodes without includeContained', async () => {
      const result = await saveTemplateFromBoard(null, {
        userId: getAuth(OWNER).sub,
        boardId,
        nodeIds: ['panel-1'],
        includeContained: false,
        name: 'Just the panel',
        scope: 'personal',
      });

      expect(result.template.nodeCount).toBe(1);
    });

    it('sanitizes rich text', async () => {
      const { template } = await save(OWNER, {
        nodeIds: ['panel-1', 'text-1'],
      });
      const { data } = await getUserCaller(OWNER).template.get({
        templateId: template.id,
      });
      const html = JSON.stringify(data.nodes.map((it) => it.content['text']));

      expect(html).toContain('Lane');
      expect(html).toContain('Hi');
      expect(html).not.toContain('<script');
      expect(html).not.toContain('onerror');
    });

    it('drops runtime nodes and board-scoped assets', async () => {
      const result = await save(OWNER, {
        nodeIds: [
          'settings',
          getAuth(OWNER).sub,
          'timer',
          'image-upload',
          'vector-data',
          'image-web',
          'vector-web',
        ],
      });

      expect(result.template.nodeCount).toBe(2);
      expect(result.dropped).toEqual(
        expect.arrayContaining([
          { id: 'settings', type: 'settings', reason: 'type_not_allowed' },
          {
            id: getAuth(OWNER).sub,
            type: 'user',
            reason: 'type_not_allowed',
          },
          { id: 'timer', type: 'timer', reason: 'type_not_allowed' },
          { id: 'image-upload', type: 'image', reason: 'board_scoped_asset' },
          { id: 'vector-data', type: 'vector', reason: 'board_scoped_asset' },
        ]),
      );
      expect(result.dropped).toHaveLength(5);
    });

    it('detaches arrows from nodes outside the selection', async () => {
      const result = await save(OWNER, { nodeIds: ['arrow-1', 'note-a'] });

      expect(result.detachedArrows).toEqual(['arrow-1']);

      const { data } = await getUserCaller(OWNER).template.get({
        templateId: result.template.id,
      });
      const saved = data.nodes.find((it) => it.ref === 'arrow-1');

      expect(saved?.content['startAttachment']).toMatchObject({
        nodeId: 'note-a',
      });
      expect(saved?.content).not.toHaveProperty('endAttachment');
    });

    it('drops notes the user cannot read while notes are hidden', async () => {
      const hiddenBoard = await db.board.createBoard(
        'Hidden notes',
        getAuth(OWNER).sub,
        [
          settings(true),
          note('mine', 0, 0, getAuth(MEMBER).sub),
          note('theirs', 400, 0, getAuth(OWNER).sub, '<p>secret</p>'),
        ],
        teamId,
      );

      const result = await save(MEMBER, {
        boardId: hiddenBoard.id,
        nodeIds: ['mine', 'theirs'],
      });

      expect(result.dropped).toEqual([
        { id: 'theirs', type: 'note', reason: 'masked_note' },
      ]);

      const { data } = await getUserCaller(MEMBER).template.get({
        templateId: result.template.id,
      });

      expect(JSON.stringify(data)).not.toContain('secret');

      const allMasked = await errorCall(() =>
        save(MEMBER, { boardId: hiddenBoard.id, nodeIds: ['theirs'] }),
      );

      expect(allMasked?.code).toBe('BAD_REQUEST');
    });

    it("drops other users' notes with private text", async () => {
      const privateNote = (id: string, owner: number, textHidden?: boolean) => {
        const node = note(id, 0, 0, getAuth(owner).sub, '<p>secret</p>');

        return textHidden === undefined
          ? node
          : { ...node, content: { ...node.content, textHidden } };
      };
      const privateBoard = await db.board.createBoard(
        'Private text',
        getAuth(OWNER).sub,
        [
          settings(),
          { id: getAuth(OWNER).sub, type: 'user', content: { visible: false } },
          {
            id: getAuth(CREATOR).sub,
            type: 'user',
            content: { visible: true },
          },
          // the owner hides the text of all their notes
          privateNote('owner-default', OWNER),
          // a note's own textHidden wins over its owner's setting
          privateNote('owner-shown', OWNER, false),
          privateNote('creator-private', CREATOR, true),
          privateNote('creator-plain', CREATOR),
          privateNote('mine-private', MEMBER, true),
        ],
        teamId,
      );

      const result = await save(MEMBER, {
        boardId: privateBoard.id,
        nodeIds: [
          'owner-default',
          'owner-shown',
          'creator-private',
          'creator-plain',
          'mine-private',
        ],
      });

      expect(result.dropped).toEqual([
        { id: 'owner-default', type: 'note', reason: 'masked_note' },
        { id: 'creator-private', type: 'note', reason: 'masked_note' },
      ]);

      const { data } = await getUserCaller(MEMBER).template.get({
        templateId: result.template.id,
      });

      expect(data.nodes.map((it) => it.ref)).toEqual([
        'owner-shown',
        'creator-plain',
        'mine-private',
      ]);

      // the owner can save their own private notes
      const owner = await save(OWNER, {
        boardId: privateBoard.id,
        nodeIds: ['owner-default'],
      });

      expect(owner.dropped).toEqual([]);
    });

    it('saves the whole board when no node ids are given', async () => {
      const result = await saveTemplateFromBoard(null, {
        userId: getAuth(OWNER).sub,
        boardId,
        name: 'Whole board',
        scope: 'personal',
      });

      // 3 runtime nodes and 2 board-scoped assets are dropped
      expect(result.template.nodeCount).toBe(boardNodes().length - 5);
    });

    it('answers an unknown node id with bad request', async () => {
      const result = await errorCall(() =>
        save(OWNER, { nodeIds: ['panel-1', 'missing'] }),
      );

      expect(result?.code).toBe('BAD_REQUEST');
      expect(result?.message).toContain('missing');
    });

    it('answers an inaccessible board with not found', async () => {
      const result = await errorCall(() => save(OUTSIDER));

      expect(result?.code).toBe('NOT_FOUND');
      // no membership row is created on the way
      expect(
        await db.board.getBoardUser(boardId, getAuth(OUTSIDER).sub),
      ).toBeUndefined();

      const unknown = await errorCall(() =>
        save(OWNER, { boardId: randomUUID() }),
      );

      expect(unknown?.code).toBe('NOT_FOUND');
    });

    it('saves a team template to the board team', async () => {
      const result = await save(MEMBER, { scope: 'team' });

      expect(result.template.scope).toEqual({
        kind: 'team',
        teamId,
        teamName: 'Templates team',
      });
      expect(result.template.canEdit).toBe(true);
    });

    it('refuses team scope to a board admin outside the team', async () => {
      const boardTeam = await errorCall(() =>
        save(BOARD_ADMIN, { scope: 'team' }),
      );

      expect(boardTeam?.code).toBe('FORBIDDEN');

      const explicitTeam = await errorCall(() =>
        save(BOARD_ADMIN, { scope: 'team', teamId }),
      );

      expect(explicitTeam?.code).toBe('FORBIDDEN');

      // the board itself is open to them
      expect((await save(BOARD_ADMIN)).template.scope.kind).toBe('personal');
    });

    it("refuses team scope for a team the user isn't in", async () => {
      const result = await errorCall(() =>
        save(MEMBER, { scope: 'team', teamId: otherTeamId }),
      );

      expect(result?.code).toBe('FORBIDDEN');
    });

    it('needs a team for team scope on a board without one', async () => {
      const personalBoard = await db.board.createBoard(
        'No team',
        getAuth(OWNER).sub,
        [note('n', 0, 0, getAuth(OWNER).sub)],
        null,
      );

      const result = await errorCall(() =>
        save(OWNER, {
          boardId: personalBoard.id,
          nodeIds: ['n'],
          scope: 'team',
        }),
      );

      expect(result?.code).toBe('BAD_REQUEST');
    });

    it('rejects templates over the node limit', async () => {
      const notes = [...Array(501)].map((_, i) =>
        note(
          `big-${i}`,
          (i % 25) * 310,
          Math.floor(i / 25) * 310,
          getAuth(OWNER).sub,
        ),
      );
      const bigBoard = await db.board.createBoard(
        'Big',
        getAuth(OWNER).sub,
        [panel('big-panel', 0, 0, 10_000), ...notes],
        null,
      );

      const result = await errorCall(() =>
        save(OWNER, { boardId: bigBoard.id, nodeIds: ['big-panel'] }),
      );

      expect(result?.code).toBe('BAD_REQUEST');
      expect(result?.message).toContain('has 502 nodes');
    });

    it('rejects templates over the size limit', async () => {
      const texts = [...Array(30)].map((_, i) =>
        text(`long-${i}`, 0, i * 200, `<p>${'x'.repeat(19_000)}</p>`),
      );
      const bigBoard = await db.board.createBoard(
        'Long',
        getAuth(OWNER).sub,
        texts,
        null,
      );

      const result = await errorCall(() =>
        save(OWNER, {
          boardId: bigBoard.id,
          nodeIds: texts.map((it) => it.id),
        }),
      );

      expect(result?.code).toBe('BAD_REQUEST');
      expect(result?.message).toContain('has 30 nodes');
    });

    it('enforces the account and team quotas', async () => {
      const user = 6;
      const ownBoard = await db.board.createBoard(
        'Quota',
        getAuth(user).sub,
        [note('n', 0, 0, getAuth(user).sub)],
        null,
      );

      await drizzleDb
        .insert(boardTemplates)
        .values(
          [...Array(TEMPLATE_QUOTAS.account)].map(() =>
            templateRow({ accountId: getAuth(user).sub }),
          ),
        );

      const personal = await errorCall(() =>
        save(user, { boardId: ownBoard.id, nodeIds: ['n'] }),
      );

      expect(personal?.code).toBe('BAD_REQUEST');

      const quotaTeam = await getUserCaller(user).team.new({ name: 'Quota' });
      const teamBoard = await db.board.createBoard(
        'Quota team',
        getAuth(user).sub,
        [note('n', 0, 0, getAuth(user).sub)],
        quotaTeam.id,
      );

      // the account quota doesn't count team templates
      await save(user, {
        boardId: teamBoard.id,
        nodeIds: ['n'],
        scope: 'team',
      });

      await drizzleDb
        .insert(boardTemplates)
        .values(
          [...Array(TEMPLATE_QUOTAS.team - 1)].map(() =>
            templateRow({ teamId: quotaTeam.id }),
          ),
        );

      const team = await errorCall(() =>
        save(user, { boardId: teamBoard.id, nodeIds: ['n'], scope: 'team' }),
      );

      expect(team?.code).toBe('BAD_REQUEST');
    });
    it('keeps parallel saves within the quota', async () => {
      const user = 7;
      const ownBoard = await db.board.createBoard(
        'Quota race',
        getAuth(user).sub,
        [note('n', 0, 0, getAuth(user).sub)],
        null,
      );

      await drizzleDb
        .insert(boardTemplates)
        .values(
          [...Array(TEMPLATE_QUOTAS.account - 1)].map(() =>
            templateRow({ accountId: getAuth(user).sub }),
          ),
        );

      const results = await Promise.allSettled(
        [...Array(8)].map(() =>
          save(user, { boardId: ownBoard.id, nodeIds: ['n'] }),
        ),
      );

      expect(results.filter((it) => it.status === 'fulfilled')).toHaveLength(1);
      results
        .filter((it) => it.status === 'rejected')
        .forEach((it) =>
          expect((it as PromiseRejectedResult).reason.code).toBe('BAD_REQUEST'),
        );

      const rows = await drizzleDb
        .select({ id: boardTemplates.id })
        .from(boardTemplates)
        .where(eq(boardTemplates.accountId, getAuth(user).sub));

      expect(rows).toHaveLength(TEMPLATE_QUOTAS.account);
    });
  });

  describe('access', () => {
    let personalId: string;
    let creatorTeamId: string;
    let adminTeamId: string;

    beforeAll(async () => {
      personalId = (await save(OWNER, { name: 'Personal' })).template.id;
      creatorTeamId = (
        await save(CREATOR, { name: 'By creator', scope: 'team' })
      ).template.id;
      adminTeamId = (await save(OWNER, { name: 'By admin', scope: 'team' }))
        .template.id;
    });

    const list = async (userIndex: number, filter?: { teamId: string }) =>
      new Map(
        (await getUserCaller(userIndex).template.list(filter)).map((it) => [
          it.id,
          it.canEdit,
        ]),
      );

    it('lists what each user may read, and what they may change', async () => {
      const owner = await list(OWNER);

      expect(owner.get(personalId)).toBe(true);
      expect(owner.get(creatorTeamId)).toBe(true);
      expect(owner.get(adminTeamId)).toBe(true);

      const member = await list(MEMBER);

      expect(member.has(personalId)).toBe(false);
      expect(member.get(creatorTeamId)).toBe(false);
      expect(member.get(adminTeamId)).toBe(false);

      const creator = await list(CREATOR);

      expect(creator.get(creatorTeamId)).toBe(true);
      expect(creator.get(adminTeamId)).toBe(false);

      const outsider = await list(OUTSIDER);

      [personalId, creatorTeamId, adminTeamId].forEach((id) =>
        expect(outsider.has(id)).toBe(false),
      );
    });

    it('narrows the list to a team only within the user teams', async () => {
      const member = await list(MEMBER, { teamId });

      expect(member.has(creatorTeamId)).toBe(true);

      const owner = await list(OWNER, { teamId });

      expect(owner.has(personalId)).toBe(false);
      expect(owner.has(adminTeamId)).toBe(true);

      expect(await list(OUTSIDER, { teamId })).toEqual(new Map());
    });

    it('gets the data only for readers', async () => {
      const team = await getUserCaller(MEMBER).template.get({
        templateId: adminTeamId,
      });

      expect(team.canEdit).toBe(false);
      expect(team.data.version).toBe(1);

      const personal = await errorCall(() =>
        getUserCaller(MEMBER).template.get({ templateId: personalId }),
      );

      expect(personal?.code).toBe('NOT_FOUND');

      const outsider = await errorCall(() =>
        getUserCaller(OUTSIDER).template.get({ templateId: creatorTeamId }),
      );

      expect(outsider?.code).toBe('NOT_FOUND');
    });

    it('refuses deletes to readers and hides templates from outsiders', async () => {
      const member = await errorCall(() =>
        getUserCaller(MEMBER).template.delete({ templateId: creatorTeamId }),
      );

      expect(member?.code).toBe('FORBIDDEN');

      const creator = await errorCall(() =>
        getUserCaller(CREATOR).template.delete({ templateId: adminTeamId }),
      );

      expect(creator?.code).toBe('FORBIDDEN');

      const outsider = await errorCall(() =>
        getUserCaller(OUTSIDER).template.delete({ templateId: personalId }),
      );

      expect(outsider?.code).toBe('NOT_FOUND');
    });

    it('lets a guest do nothing', async () => {
      await createGuest(0);

      const guest = getGuestCaller(0);
      const results = await Promise.all([
        errorCall(() => guest.template.list()),
        errorCall(() => guest.template.get({ templateId: personalId })),
        errorCall(() =>
          guest.template.createFromBoard({
            boardId,
            nodeIds: ['panel-1'],
            name: 'Guest',
            scope: 'personal',
          }),
        ),
        errorCall(() => guest.template.delete({ templateId: personalId })),
      ]);

      results.forEach((result) => expect(result?.code).toBe('FORBIDDEN'));
    });

    it('takes access away from a removed member, creator included', async () => {
      await db.team.deleteMember(teamId, getAuth(CREATOR).sub);

      expect((await list(CREATOR)).has(creatorTeamId)).toBe(false);

      const result = await errorCall(() =>
        getUserCaller(CREATOR).template.delete({ templateId: creatorTeamId }),
      );

      expect(result?.code).toBe('NOT_FOUND');
    });

    it('lets the team admin and the owner delete', async () => {
      await getUserCaller(OWNER).template.delete({ templateId: creatorTeamId });
      await getUserCaller(OWNER).template.delete({ templateId: personalId });

      const owner = await list(OWNER);

      expect(owner.has(creatorTeamId)).toBe(false);
      expect(owner.has(personalId)).toBe(false);
    });

    it('lets a creator who is still a member delete', async () => {
      const id = (await save(MEMBER, { name: 'Mine', scope: 'team' })).template
        .id;

      await getUserCaller(MEMBER).template.delete({ templateId: id });

      expect((await list(OWNER)).has(id)).toBe(false);
    });
  });

  describe('stored data', () => {
    it('rejects unknown versions and corrupt data on read', async () => {
      const ownerId = getAuth(OWNER).sub;
      const rows = await drizzleDb
        .insert(boardTemplates)
        .values([
          templateRow({ accountId: ownerId }, { version: 2, nodes: [] }),
          templateRow(
            { accountId: ownerId },
            {
              version: 1,
              size: { width: 1, height: 1 },
              nodes: [{ ref: 'bad ref!', type: 'note', content: {} }],
            },
          ),
        ])
        .returning({ id: boardTemplates.id });

      const listed = await getUserCaller(OWNER).template.list();

      for (const { id } of rows) {
        // the list never reads the data
        expect(listed.some((it) => it.id === id)).toBe(true);

        const owner = await errorCall(() =>
          getUserCaller(OWNER).template.get({ templateId: id }),
        );

        expect(owner?.code).toBe('BAD_REQUEST');
        expect(owner?.message).toContain('not valid');

        const outsider = await errorCall(() =>
          getUserCaller(OUTSIDER).template.get({ templateId: id }),
        );

        expect(outsider?.code).toBe('NOT_FOUND');
      }
    });
    it('lets the owner delete a template that no longer parses', async () => {
      const corrupt = { version: 2, nodes: [] };
      const [personal, team] = await drizzleDb
        .insert(boardTemplates)
        .values([
          templateRow({ accountId: getAuth(OWNER).sub }, corrupt),
          {
            ...templateRow({ teamId }, corrupt),
            createdBy: getAuth(OWNER).sub,
          },
        ])
        .returning({ id: boardTemplates.id });

      // write access is checked before the data
      const reader = await errorCall(() =>
        getUserCaller(MEMBER).template.delete({ templateId: team.id }),
      );

      expect(reader?.code).toBe('FORBIDDEN');

      await getUserCaller(OWNER).template.delete({ templateId: personal.id });
      await getUserCaller(OWNER).template.delete({ templateId: team.id });

      const listed = await getUserCaller(OWNER).template.list();

      expect(listed.some((it) => it.id === personal.id)).toBe(false);
      expect(listed.some((it) => it.id === team.id)).toBe(false);
    });
  });

  describe('account deletion', () => {
    const ADMIN = 95;
    const LEAVER = 96;

    it('keeps team templates and deletes personal ones', async () => {
      const deletedTeam = (
        await getUserCaller(ADMIN).team.new({ name: 'Deletion team' })
      ).id;

      await db.user.addTeamMember(getAuth(LEAVER).sub, deletedTeam, 'member');

      const board = await db.board.createBoard(
        'Deletion',
        getAuth(ADMIN).sub,
        [note('n', 0, 0, getAuth(ADMIN).sub)],
        deletedTeam,
      );
      const input = { boardId: board.id, nodeIds: ['n'] };
      const team = await save(LEAVER, { ...input, scope: 'team' });
      const personal = await save(LEAVER, input);
      const adminPersonal = await save(ADMIN, input);

      await db.user.deleteAccount(getAuth(LEAVER).sub);

      const kept = await getUserCaller(ADMIN).template.get({
        templateId: team.template.id,
      });

      expect(kept.createdBy).toBeNull();
      expect(kept.canEdit).toBe(true);

      const rowsOf = (id: string) =>
        drizzleDb
          .select({ id: boardTemplates.id })
          .from(boardTemplates)
          .where(eq(boardTemplates.id, id));

      expect(await rowsOf(personal.template.id)).toEqual([]);

      await db.user.deleteAccount(getAuth(ADMIN).sub);

      expect(await rowsOf(adminPersonal.template.id)).toEqual([]);
      // the team outlives its members, and so does its template
      expect(await rowsOf(team.template.id)).toHaveLength(1);

      await db.board.deleteBoard(board.id);
      await db.team.deleteTeam(deletedTeam);
    });
  });
});
