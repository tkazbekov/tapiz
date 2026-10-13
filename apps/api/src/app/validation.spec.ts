import { describe, expect, it, vi } from 'vitest';
import { StateActions, TuNode } from '@tapiz/board-commons';
import {
  validateAction,
  validateActionDetailed,
  validateBatch,
  validation,
} from './validation';

describe('validateAction', () => {
  it('accepts arrow add actions', async () => {
    const action: StateActions = {
      op: 'add',
      data: {
        id: 'arrow-1',
        type: 'arrow',
        content: {
          layer: 1,
          position: { x: 90, y: 90 },
          width: 120,
          height: 80,
          start: { x: 10, y: 10 },
          end: { x: 110, y: 70 },
          color: '#1c1c1c',
          strokeStyle: 'solid',
          strokeWidth: 4,
          arrowType: 'sharp',
          heads: ['end'],
          startAttachment: {
            nodeId: 'note-1',
            offset: { x: 100, y: 40 },
          },
        },
      },
      position: 0,
    };

    await expect(
      validateAction(action, [], 'user-1', true, 'board-1', 'private-1'),
    ).resolves.toEqual(action);
  });

  it('rejects arrow stroke widths outside the allowed options', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const action: StateActions = {
      op: 'add',
      data: {
        id: 'arrow-1',
        type: 'arrow',
        content: {
          layer: 1,
          position: { x: 90, y: 90 },
          width: 120,
          height: 80,
          start: { x: 10, y: 10 },
          end: { x: 110, y: 70 },
          color: '#1c1c1c',
          strokeStyle: 'solid',
          strokeWidth: 5,
          arrowType: 'sharp',
        },
      },
      position: 0,
    };

    await expect(
      validateAction(action, [], 'user-1', true, 'board-1', 'private-1'),
    ).resolves.toBe(false);

    consoleError.mockRestore();
  });

  it('rejects add actions with unsupported board layers', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const action: StateActions = {
      op: 'add',
      data: {
        id: 'text-1',
        type: 'text',
        content: {
          layer: 2,
          position: { x: 90, y: 90 },
          width: 120,
          height: 80,
          text: '<p>Invalid layer</p>',
          rotation: 0,
        },
      },
      position: 0,
    };

    await expect(
      validateAction(action, [], 'user-1', false, 'board-1', 'private-1'),
    ).resolves.toBe(false);

    consoleError.mockRestore();
  });

  it('rejects patch actions that move nodes to unsupported board layers', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const action: StateActions = {
      op: 'patch',
      data: {
        id: 'text-1',
        type: 'text',
        content: {
          layer: 2,
        },
      },
    };

    await expect(
      validateAction(
        action,
        [
          {
            id: 'text-1',
            type: 'text',
            content: {
              layer: 0,
              position: { x: 90, y: 90 },
              width: 120,
              height: 80,
              text: '<p>Valid layer</p>',
              rotation: 0,
            },
          },
        ],
        'user-1',
        false,
        'board-1',
        'private-1',
      ),
    ).resolves.toBe(false);

    consoleError.mockRestore();
  });
});

describe('validation rich text', () => {
  const payload = '<img src=x onerror="alert(document.domain)"><p>ok</p>';
  const textContent = {
    text: payload,
    position: { x: 0, y: 0 },
    width: 200,
    height: 100,
    color: '#000000',
    size: 16,
    layer: 0,
    rotation: 0,
  };

  const run = (actions: StateActions[], nodes: TuNode[] = []) =>
    validation(actions, nodes, 'user-1', false, 'board-1', 'private-1');

  it('sanitizes text added to the board', async () => {
    const [action] = await run([
      {
        op: 'add',
        data: { id: 'text-1', type: 'text', content: textContent },
      },
    ]);

    expect(action.data).toMatchObject({ content: { text: '<p>ok</p>' } });
  });

  it('sanitizes note and panel patches', async () => {
    const nodes: TuNode[] = [
      { id: 'note-1', type: 'note', content: { text: '' } },
      { id: 'panel-1', type: 'panel', content: { text: '' } },
    ];

    const actions = await run(
      [
        {
          op: 'patch',
          data: { id: 'note-1', type: 'note', content: { text: payload } },
        },
        {
          op: 'patch',
          data: {
            id: 'panel-1',
            type: 'panel',
            content: { text: '<a href="javascript:alert(1)">x</a>' },
          },
        },
      ],
      nodes,
    );

    expect(actions.map((it) => (it.data as TuNode).content)).toEqual([
      { text: '<p>ok</p>' },
      { text: '<a>x</a>' },
    ]);
  });

  it('sanitizes estimation story descriptions', async () => {
    const [action] = await run([
      {
        op: 'add',
        data: {
          id: 'estimation-config-1',
          type: 'estimation.config',
          content: {
            scale: 'fibonacci',
            step: 0,
            stories: [
              {
                id: '5b3a6a2b-6d5e-4b9b-8d1c-6a2f9d4f1c11',
                title: 'Story',
                description: payload,
                show: false,
              },
            ],
          },
        },
      },
    ]);

    expect(action.data).toMatchObject({
      content: { stories: [{ description: '<p>ok</p>' }] },
    });
  });
});

describe('validateAction node type', () => {
  const payload = '<img src=x onerror="alert(document.domain)">';
  const nodes: TuNode[] = [
    {
      id: 'text-1',
      type: 'text',
      content: { text: '<p>hi</p>' },
    },
    {
      id: 'note-1',
      type: 'note',
      content: { text: '', ownerId: 'user-1' },
      children: [
        {
          id: 'comment-1',
          type: 'comment',
          content: { text: 'mine', userId: 'user-1', date: 1 },
        },
        {
          id: 'comment-2',
          type: 'comment',
          content: { text: 'theirs', userId: 'user-2', date: 1 },
        },
      ],
    },
  ];

  const run = (action: StateActions) =>
    validateAction(action, nodes, 'user-1', false, 'board-1', 'private-1');

  it.each(['comment', 'token', 'vector', 'note'])(
    'rejects a %s patch aimed at a text node',
    async (type) => {
      await expect(
        run({
          op: 'patch',
          data: { id: 'text-1', type, content: { text: payload } },
        }),
      ).resolves.toBe(false);
    },
  );

  it.each(['comment', 'vector'])(
    'rejects a %s remove aimed at a text node',
    async (type) => {
      await expect(
        run({ op: 'remove', data: { id: 'text-1', type } }),
      ).resolves.toBe(false);
    },
  );

  it('accepts a patch that names the node type', async () => {
    await expect(
      run({
        op: 'patch',
        data: { id: 'text-1', type: 'text', content: { text: '<p>ok</p>' } },
      }),
    ).resolves.toMatchObject({ op: 'patch' });
  });

  it('lets only the author edit the text of a comment', async () => {
    await expect(
      run({
        op: 'patch',
        parent: 'note-1',
        data: {
          id: 'comment-1',
          type: 'comment',
          content: { text: 'edited', userId: 'user-2', date: 2 },
        },
      }),
    ).resolves.toMatchObject({
      data: { content: { text: 'edited' } },
    });

    const result = await run({
      op: 'patch',
      parent: 'note-1',
      data: {
        id: 'comment-1',
        type: 'comment',
        content: { userId: 'user-2', date: 2 },
      },
    });

    expect(result && result.data).toMatchObject({ content: {} });
    expect(result && (result.data as TuNode).content).not.toHaveProperty(
      'userId',
    );

    await expect(
      run({
        op: 'patch',
        parent: 'note-1',
        data: {
          id: 'comment-2',
          type: 'comment',
          content: { text: 'hijacked' },
        },
      }),
    ).resolves.toBe(false);
  });
});

describe('validation node type', () => {
  it('stores nothing when a patch claims another type', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(
      validation(
        [
          {
            op: 'patch',
            data: {
              id: 'text-1',
              type: 'token',
              content: { text: '<img src=x onerror=alert(1)>PWN' },
            },
          },
        ],
        [{ id: 'text-1', type: 'text', content: { text: '<p>hi</p>' } }],
        'user-1',
        false,
        'board-1',
        'private-1',
      ),
    ).resolves.toEqual([]);

    consoleError.mockRestore();
  });

  it('accepts removes, which carry no content', async () => {
    const actions: StateActions[] = [
      { op: 'remove', data: { id: 'text-1', type: 'text' } },
      { op: 'remove', data: { id: 'note-1', type: 'note' } },
    ];

    await expect(
      validation(
        actions,
        [
          { id: 'text-1', type: 'text', content: { text: '<p>hi</p>' } },
          {
            id: 'note-1',
            type: 'note',
            content: { text: '', ownerId: 'user-1' },
          },
        ],
        'user-1',
        false,
        'board-1',
        'private-1',
      ),
    ).resolves.toMatchObject(actions);
  });
});

describe('validateAction background layer', () => {
  const textContent = {
    text: '<p>label</p>',
    position: { x: 0, y: 0 },
    width: 200,
    height: 100,
    rotation: 0,
  };
  const pollId = 'b3a1c3c4-6f1e-4d55-9b5e-0f7f3f1f2a10';
  const optionId = '5b3a6a2b-6d5e-4b9b-8d1c-6a2f9d4f1c11';
  const nodes: TuNode[] = [
    { id: 'text-0', type: 'text', content: { ...textContent, layer: 0 } },
    {
      id: 'panel-1',
      type: 'panel',
      content: { position: { x: 0, y: 0 }, width: 400, height: 400, layer: 1 },
    },
    {
      id: pollId,
      type: 'poll',
      content: {
        layer: 1,
        position: { x: 0, y: 0 },
        title: 'Lunch?',
        finished: false,
        mode: 'public',
        options: [{ id: optionId, text: 'Yes' }],
      },
    },
  ];

  const run = (action: StateActions, isAdmin = false) =>
    validateAction(action, nodes, 'user-1', isAdmin, 'board-1', 'private-1');

  it('lets only admins add nodes to the background layer', async () => {
    const action: StateActions = {
      op: 'add',
      data: {
        id: 'text-1',
        type: 'text',
        content: { ...textContent, layer: 1 },
      },
    };

    await expect(run(action)).resolves.toBe(false);
    await expect(run(action, true)).resolves.toMatchObject({ op: 'add' });
  });

  it('rejects a non-admin moving a node to the background layer', async () => {
    await expect(
      run({
        op: 'patch',
        data: { id: 'text-0', type: 'text', content: { layer: 1 } },
      }),
    ).resolves.toBe(false);
  });

  it('rejects a non-admin editing or removing a background node', async () => {
    const move: StateActions = {
      op: 'patch',
      data: {
        id: 'panel-1',
        type: 'panel',
        content: { position: { x: 5, y: 5 } },
      },
    };

    await expect(run(move)).resolves.toBe(false);
    await expect(run(move, true)).resolves.toMatchObject({ op: 'patch' });
    await expect(
      run({ op: 'remove', data: { id: 'panel-1', type: 'panel' } }),
    ).resolves.toBe(false);
  });

  it('lets members answer a poll on the background layer', async () => {
    await expect(
      run({
        op: 'add',
        parent: pollId,
        data: {
          id: 'answer-1',
          type: 'poll.answer',
          content: { optionId, userId: 'user-1' },
        },
      }),
    ).resolves.toMatchObject({ op: 'add', parent: pollId });
  });

  it('rejects notes and groups on the background layer from non-admins', async () => {
    const note: StateActions = {
      op: 'add',
      data: {
        id: 'note-1',
        type: 'note',
        content: {
          text: '',
          position: { x: 0, y: 0 },
          layer: 1,
          ownerId: 'user-1',
          votes: [],
          emojis: [],
          drawing: [],
          width: 300,
          height: 300,
        },
      },
    };
    const group: StateActions = {
      op: 'add',
      data: {
        id: 'group-1',
        type: 'group',
        content: {
          position: { x: 0, y: 0 },
          width: 400,
          height: 400,
          layer: 1,
        },
      },
    };

    await expect(run(note)).resolves.toBe(false);
    await expect(run(group)).resolves.toBe(false);
    await expect(run(note, true)).resolves.toMatchObject({ op: 'add' });
    await expect(run(group, true)).resolves.toMatchObject({ op: 'add' });
  });
});

describe('validateAction group', () => {
  const content = {
    title: 'Ideas',
    position: { x: 0, y: 0 },
    width: 400,
    height: 400,
    layer: 0,
    votes: [],
  };
  const nodes: TuNode[] = [
    { id: 'group-1', type: 'group', content },
    { id: 'text-1', type: 'text', content: { text: '<p>hi</p>' } },
  ];

  const run = (action: StateActions) =>
    validateAction(action, nodes, 'user-1', false, 'board-1', 'private-1');

  it('accepts adds, patches and removes as before', async () => {
    await expect(
      run({
        op: 'add',
        data: {
          id: 'group-2',
          type: 'group',
          content,
          children: [],
        } as TuNode,
        position: 1,
      }),
    ).resolves.toEqual({
      op: 'add',
      data: { id: 'group-2', type: 'group', content },
      position: 1,
    });

    await expect(
      run({
        op: 'patch',
        data: { id: 'group-1', type: 'group', content: { title: 'Renamed' } },
      }),
    ).resolves.toEqual({
      op: 'patch',
      data: { id: 'group-1', type: 'group', content: { title: 'Renamed' } },
    });

    await expect(
      run({ op: 'remove', data: { id: 'group-1', type: 'group' } }),
    ).resolves.toEqual({
      op: 'remove',
      data: { id: 'group-1', type: 'group' },
    });
  });

  it('rejects an add without a position or size', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(
      run({
        op: 'add',
        data: { id: 'group-2', type: 'group', content: { title: 'x' } },
      }),
    ).resolves.toBe(false);

    consoleError.mockRestore();
  });

  it('rejects a patch to a missing node', async () => {
    await expect(
      run({
        op: 'patch',
        data: { id: 'missing', type: 'group', content: { title: 'x' } },
      }),
    ).resolves.toBe(false);
  });

  it('rejects a patch that claims another type', async () => {
    await expect(
      run({
        op: 'patch',
        data: { id: 'text-1', type: 'group', content: { title: 'x' } },
      }),
    ).resolves.toBe(false);
  });
});

describe('validateAction hidden notes', () => {
  const noteContent = (ownerId: string) => ({
    text: '<p>secret</p>',
    position: { x: 0, y: 0 },
    layer: 0,
    ownerId,
    votes: [],
    emojis: [],
    drawing: [],
    width: 300,
    height: 300,
    color: '#fee2e2',
  });
  const nodes: TuNode[] = [
    { id: 'settings', type: 'settings', content: { notesHidden: true } },
    {
      id: 'note-1',
      type: 'note',
      content: noteContent('user-1'),
      children: [
        {
          id: 'comment-1',
          type: 'comment',
          content: { text: 'mine', userId: 'user-2', date: 1 },
        },
      ],
    },
    { id: 'note-2', type: 'note', content: noteContent('user-2') },
  ];

  // user-2 owns note-2 and wrote comment-1 on note-1
  const run = (action: StateActions, isAdmin = false, board = nodes) =>
    validateAction(action, board, 'user-2', isAdmin, 'board-1', 'private-1');

  const patch = (id: string, content: object): StateActions => ({
    op: 'patch',
    data: { id, type: 'note', content },
  });

  it('lets others move and resize a hidden note', async () => {
    await expect(
      run(
        patch('note-1', {
          position: { x: 10, y: 10 },
          width: 400,
          height: 200,
          layer: 0,
        }),
      ),
    ).resolves.toMatchObject({ op: 'patch' });
  });

  it.each([
    { text: '<p>edited</p>' },
    { votes: [{ userId: 'user-2', vote: 1 }] },
    { color: '#ffffff' },
    { emojis: [] },
    { drawing: [] },
    { textHidden: false },
    { ownerId: 'user-2' },
    { position: { x: 1, y: 1 }, text: 'sneaky' },
  ])('rejects others changing %o of a hidden note', async (content) => {
    await expect(run(patch('note-1', content))).resolves.toBe(false);
    await expect(run(patch('note-1', content), true)).resolves.toBe(false);
  });

  it('lets the owner edit and vote while notes are hidden', async () => {
    await expect(
      run(
        patch('note-2', {
          text: '<p>mine</p>',
          votes: [{ userId: 'user-2', vote: 1 }],
        }),
      ),
    ).resolves.toMatchObject({ op: 'patch' });
  });

  it('rejects others removing a hidden note, admins included', async () => {
    const remove = (id: string): StateActions => ({
      op: 'remove',
      data: { id, type: 'note' },
    });

    await expect(run(remove('note-1'))).resolves.toBe(false);
    await expect(run(remove('note-1'), true)).resolves.toBe(false);
    await expect(run(remove('note-2'))).resolves.toMatchObject({
      op: 'remove',
    });
  });

  it('only adds notes owned by the sender', async () => {
    const add = (ownerId: string): StateActions => ({
      op: 'add',
      data: { id: 'note-3', type: 'note', content: noteContent(ownerId) },
    });

    await expect(run(add('user-1'))).resolves.toBe(false);
    await expect(run(add('user-1'), true)).resolves.toBe(false);
    await expect(run(add('user-2'))).resolves.toMatchObject({ op: 'add' });
  });

  it('rejects comments on hidden notes of other users', async () => {
    await expect(
      run({
        op: 'add',
        parent: 'note-1',
        data: {
          id: 'comment-2',
          type: 'comment',
          content: { text: 'hi', userId: 'user-2', date: 1 },
        },
      }),
    ).resolves.toBe(false);
    await expect(
      run({
        op: 'patch',
        parent: 'note-1',
        data: { id: 'comment-1', type: 'comment', content: { text: 'x' } },
      }),
    ).resolves.toBe(false);
    await expect(
      run({
        op: 'remove',
        parent: 'note-1',
        data: { id: 'comment-1', type: 'comment' },
      }),
    ).resolves.toBe(false);
    await expect(
      run({
        op: 'add',
        parent: 'note-2',
        data: {
          id: 'comment-3',
          type: 'comment',
          content: { text: 'hi', userId: 'user-2', date: 1 },
        },
      }),
    ).resolves.toMatchObject({ op: 'add' });
  });

  it('allows everything once notes are revealed', async () => {
    const revealed = nodes.map((node) =>
      node.type === 'settings'
        ? { ...node, content: { notesHidden: false } }
        : node,
    );

    await expect(
      run(patch('note-1', { text: '<p>edited</p>' }), false, revealed),
    ).resolves.toMatchObject({ op: 'patch' });
    await expect(
      run(
        { op: 'remove', data: { id: 'note-1', type: 'note' } },
        false,
        revealed,
      ),
    ).resolves.toMatchObject({ op: 'remove' });
    await expect(
      run(
        {
          op: 'patch',
          parent: 'note-1',
          data: { id: 'comment-1', type: 'comment', content: { text: 'x' } },
        },
        false,
        revealed,
      ),
    ).resolves.toMatchObject({ op: 'patch' });
  });
});

// pins what the websocket path does today, so the MCP-only batch validation
// added next to it cannot change it
describe('validation characterization', () => {
  const noteContent = (layer = 0) => ({
    text: '<p>idea</p>',
    position: { x: 0, y: 0 },
    layer,
    ownerId: 'user-1',
    votes: [],
    emojis: [],
    drawing: [],
    width: 300,
    height: 300,
    color: '#fee2e2',
  });
  const addNote = (id: string, layer = 0): StateActions => ({
    op: 'add',
    data: { id, type: 'note', content: noteContent(layer) },
  });
  const addText = (id: string): StateActions => ({
    op: 'add',
    data: {
      id,
      type: 'text',
      content: {
        text: '<p>label</p>',
        position: { x: 0, y: 0 },
        layer: 0,
        width: 200,
        height: 50,
        color: '#000000',
        size: 16,
        rotation: 0,
      },
    },
  });
  const run = (actions: StateActions[], nodes: TuNode[] = [], isAdmin = true) =>
    validation(actions, nodes, 'user-1', isAdmin, 'board-1', 'private-1');

  it('rejects a patch of a note added in the same batch', async () => {
    await expect(
      run([
        addNote('note-1'),
        {
          op: 'patch',
          data: { id: 'note-1', type: 'note', content: { text: 'x' } },
        },
      ]),
    ).resolves.toEqual([]);
  });

  it('rejects a comment on a note added in the same batch', async () => {
    await expect(
      run([
        addNote('note-1'),
        {
          op: 'add',
          parent: 'note-1',
          data: {
            id: 'comment-1',
            type: 'comment',
            content: { text: 'hi', userId: 'user-1', date: 1 },
          },
        },
      ]),
    ).resolves.toEqual([]);
  });

  it('drops a shape-invalid action and applies the rest', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const result = await run([
      { data: { id: 'x', type: 'note' } } as unknown as StateActions,
      addText('text-1'),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ op: 'add', data: { id: 'text-1' } });

    consoleError.mockRestore();
  });

  it('rejects the whole batch for a non-admin layer-1 action', async () => {
    await expect(
      run([addNote('note-1', 1), addText('text-1')], [], false),
    ).resolves.toEqual([]);
  });

  it('returns a duplicate-id add as applied', async () => {
    const existing: TuNode = {
      id: 'note-1',
      type: 'note',
      content: noteContent(),
    };

    await expect(run([addNote('note-1')], [existing])).resolves.toEqual([
      expect.objectContaining({ op: 'add', data: expect.anything() }),
    ]);
  });

  it('returns nothing for input that is not an array', async () => {
    await expect(
      run({} as unknown as StateActions[], [], true),
    ).resolves.toEqual([]);
  });
});

describe('validateActionDetailed', () => {
  const noteContent = (ownerId = 'user-1', layer = 0) => ({
    text: '<p>idea</p>',
    position: { x: 0, y: 0 },
    layer,
    ownerId,
    votes: [],
    emojis: [],
    drawing: [],
    width: 300,
    height: 300,
    color: '#fee2e2',
  });
  const nodes: TuNode[] = [
    { id: 'settings', type: 'settings', content: { notesHidden: true } },
    {
      id: 'note-1',
      type: 'note',
      content: noteContent('user-2'),
      children: [
        {
          id: 'comment-1',
          type: 'comment',
          content: { text: 'theirs', userId: 'user-2', date: 1 },
        },
      ],
    },
    { id: 'note-2', type: 'note', content: noteContent('user-1') },
    {
      id: 'note-3',
      type: 'note',
      content: noteContent('user-1'),
      children: [
        {
          id: 'comment-2',
          type: 'comment',
          content: { text: 'theirs', userId: 'user-2', date: 1 },
        },
        {
          id: 'comment-3',
          type: 'comment',
          content: { text: 'mine', userId: 'user-1', date: 1 },
        },
      ],
    },
    {
      id: 'panel-1',
      type: 'panel',
      content: {
        position: { x: 0, y: 0 },
        width: 100,
        height: 100,
        layer: 1,
        text: '',
      },
    },
    {
      id: 'text-1',
      type: 'text',
      content: { text: '<p>hi</p>', layer: 0 },
    },
  ];

  const detailed = (action: StateActions, isAdmin = false) =>
    validateActionDetailed(
      action,
      nodes,
      'user-1',
      isAdmin,
      'board-1',
      'private-1',
    );

  const cases: [string, StateActions, boolean][] = [
    [
      'layer_admin_only',
      {
        op: 'add',
        data: { id: 'n', type: 'note', content: noteContent('user-1', 1) },
      },
      false,
    ],
    [
      'layer_admin_only',
      { op: 'remove', data: { id: 'panel-1', type: 'panel' } },
      false,
    ],
    [
      'node_not_found',
      { op: 'patch', data: { id: 'missing', type: 'note', content: {} } },
      false,
    ],
    [
      'node_not_found',
      { op: 'remove', data: { id: 'missing', type: 'text' } },
      false,
    ],
    [
      'type_mismatch',
      { op: 'patch', data: { id: 'text-1', type: 'note', content: {} } },
      false,
    ],
    [
      'type_mismatch',
      { op: 'remove', data: { id: 'text-1', type: 'vector' } },
      false,
    ],
    [
      'schema',
      { op: 'add', data: { id: 'n', type: 'note', content: { text: 1 } } },
      false,
    ],
    [
      'schema',
      {
        op: 'patch',
        data: { id: 'text-1', type: 'text', content: { layer: 3 } },
      },
      false,
    ],
    [
      'notes_hidden_owner',
      {
        op: 'add',
        data: { id: 'n', type: 'note', content: noteContent('user-2') },
      },
      false,
    ],
    [
      'masked_note',
      {
        op: 'patch',
        data: { id: 'note-1', type: 'note', content: { text: 'x' } },
      },
      true,
    ],
    [
      'masked_note',
      { op: 'remove', data: { id: 'note-1', type: 'note' } },
      true,
    ],
    [
      'masked_note',
      {
        op: 'add',
        parent: 'note-1',
        data: {
          id: 'c',
          type: 'comment',
          content: { text: 'x', userId: 'user-1', date: 1 },
        },
      },
      false,
    ],
    [
      'parent_invalid',
      {
        op: 'add',
        parent: 'text-1',
        data: {
          id: 'c',
          type: 'comment',
          content: { text: 'x', userId: 'user-1', date: 1 },
        },
      },
      false,
    ],
    [
      'masked_note',
      {
        op: 'patch',
        parent: 'note-1',
        data: { id: 'comment-1', type: 'comment', content: { text: 'x' } },
      },
      false,
    ],
    [
      'masked_note',
      {
        op: 'remove',
        parent: 'note-1',
        data: { id: 'comment-1', type: 'comment' },
      },
      false,
    ],
    [
      'forbidden',
      {
        op: 'patch',
        parent: 'note-3',
        data: { id: 'comment-2', type: 'comment', content: { text: 'x' } },
      },
      false,
    ],
    [
      'forbidden',
      {
        op: 'patch',
        data: { id: 'user-2', type: 'user', content: { name: 'x' } },
      },
      false,
    ],
    [
      'unsupported_type',
      { op: 'add', data: { id: 'n', type: 'banana', content: {} } },
      false,
    ],
  ];

  it.each(cases)('reports %s', async (code, action, isAdmin) => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const result = await detailed(action, isAdmin);

    expect(result).toMatchObject({ ok: false, code });
    expect(result.ok || result.message).toBeTruthy();

    consoleError.mockRestore();
  });

  it('lets the author edit their comment while notes are hidden', async () => {
    const result = await detailed({
      op: 'patch',
      parent: 'note-3',
      data: { id: 'comment-3', type: 'comment', content: { text: 'edited' } },
    });

    expect(result).toMatchObject({
      ok: true,
      action: { data: { content: { text: 'edited' } } },
    });
  });

  it('lists the failing fields of a schema rejection', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const result = await detailed({
      op: 'add',
      data: {
        id: 'n',
        type: 'text',
        content: { text: '<p>x</p>' },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'schema',
      issues: expect.arrayContaining([
        expect.objectContaining({ path: ['position'] }),
      ]),
    });

    consoleError.mockRestore();
  });

  // validateAction wraps validateActionDetailed, so this only guards the
  // wrapper; 'validation characterization' guards the websocket behaviour
  it('matches validateAction for every case', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const accepted: StateActions[] = [
      {
        op: 'add',
        data: { id: 'n', type: 'note', content: noteContent('user-1') },
      },
      {
        op: 'patch',
        data: { id: 'note-2', type: 'note', content: { text: '<p>x</p>' } },
      },
      { op: 'remove', data: { id: 'text-1', type: 'text' } },
      {
        op: 'patch',
        data: { id: 'note-1', type: 'note', content: { width: 200 } },
      },
    ];

    for (const [action, isAdmin] of [
      ...cases.map(([, action, isAdmin]) => [action, isAdmin] as const),
      ...accepted.flatMap((action) => [
        [action, false] as const,
        [action, true] as const,
      ]),
    ]) {
      const result = await detailed(action, isAdmin);
      const plain = await validateAction(
        action,
        nodes,
        'user-1',
        isAdmin,
        'board-1',
        'private-1',
      );

      expect(plain).toEqual(result.ok ? result.action : false);
    }

    consoleError.mockRestore();
  });
});

describe('validateBatch', () => {
  const noteContent = (layer = 0) => ({
    text: '<p>idea</p>',
    position: { x: 0, y: 0 },
    layer,
    ownerId: 'user-1',
    votes: [],
    emojis: [],
    drawing: [],
    width: 300,
    height: 300,
    color: '#fee2e2',
  });
  const addNote = (id: string, layer = 0): StateActions => ({
    op: 'add',
    data: { id, type: 'note', content: noteContent(layer) },
  });
  const addComment = (id: string, parent: string): StateActions => ({
    op: 'add',
    parent,
    data: {
      id,
      type: 'comment',
      content: { text: 'hi', userId: 'user-1', date: 1 },
    },
  });
  const patchNote = (id: string, content: object): StateActions => ({
    op: 'patch',
    data: { id, type: 'note', content },
  });
  const sequential = (
    actions: StateActions[],
    nodes: TuNode[] = [],
    isAdmin = true,
  ) =>
    validateBatch(actions, nodes, 'user-1', isAdmin, 'board-1', 'private-1', {
      sequential: true,
      rejectDuplicateIds: true,
    });

  it('lets later actions patch a node added earlier in the batch', async () => {
    const result = await sequential([
      addNote('note-1'),
      patchNote('note-1', { text: '<p>edited</p>' }),
    ]);

    expect(result.rejected).toEqual([]);
    expect(result.indices).toEqual([0, 1]);
    expect(result.actions).toHaveLength(2);
    expect(result.actions[1]).toMatchObject({
      op: 'patch',
      data: { content: { text: '<p>edited</p>' } },
    });
  });

  it('lets later actions remove a node added earlier in the batch', async () => {
    const result = await sequential([
      addNote('note-1'),
      { op: 'remove', data: { id: 'note-1', type: 'note' } },
    ]);

    expect(result.rejected).toEqual([]);
    expect(result.actions.map((it) => it.op)).toEqual(['add', 'remove']);
  });

  it('lets later actions comment on a note added earlier in the batch', async () => {
    const result = await sequential([
      addNote('note-1'),
      addComment('comment-1', 'note-1'),
    ]);

    expect(result.rejected).toEqual([]);
    expect(result.actions[1]).toMatchObject({
      op: 'add',
      parent: 'note-1',
      data: { id: 'comment-1', type: 'comment' },
    });
  });

  it('rejects an add whose id exists, and aborts the rest', async () => {
    const result = await sequential(
      [addNote('note-2'), addNote('note-1')],
      [{ id: 'note-1', type: 'note', content: noteContent() }],
    );

    expect(result.actions).toEqual([]);
    expect(result.rejected).toEqual([
      expect.objectContaining({ index: 0, code: 'batch_aborted' }),
      expect.objectContaining({
        index: 1,
        op: 'add',
        id: 'note-1',
        type: 'note',
        code: 'duplicate_id',
        hint: expect.any(String),
      }),
    ]);
  });

  it('rejects an add whose id was added earlier in the batch', async () => {
    const result = await sequential([addNote('note-1'), addNote('note-1')]);

    expect(result.rejected.map((it) => it.code)).toEqual([
      'batch_aborted',
      'duplicate_id',
    ]);
  });

  it('reports actions on a rejected add as depending on it', async () => {
    const result = await sequential(
      [
        addNote('note-1', 1),
        patchNote('note-1', { text: 'x' }),
        addComment('comment-1', 'note-1'),
        addNote('note-2'),
      ],
      [],
      false,
    );

    expect(result.actions).toEqual([]);
    expect(result.rejected).toEqual([
      expect.objectContaining({ index: 0, code: 'layer_admin_only' }),
      expect.objectContaining({
        index: 1,
        code: 'depends_on_rejected',
        dependsOn: 0,
      }),
      expect.objectContaining({
        index: 2,
        code: 'depends_on_rejected',
        dependsOn: 0,
      }),
      expect.objectContaining({ index: 3, code: 'batch_aborted' }),
    ]);
  });

  it('names the rejected parent a patch depends on', async () => {
    const result = await sequential(
      [
        addNote('note-1', 1),
        {
          op: 'patch',
          parent: 'note-1',
          data: { id: 'comment-1', type: 'comment', content: { text: 'x' } },
        },
      ],
      [],
      false,
    );

    expect(result.rejected[1]).toMatchObject({
      code: 'depends_on_rejected',
      dependsOn: 0,
      message: 'action 0 that adds note-1 was rejected',
    });
  });

  it('forgets a rejected add once the same id is added', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const result = await sequential([
      {
        op: 'add',
        data: { id: 'note-1', type: 'note', content: { text: 1 } },
      },
      addNote('note-1'),
      patchNote('note-1', { text: '<p>edited</p>' }),
    ]);

    expect(result.rejected.map((it) => it.code)).toEqual([
      'schema',
      'batch_aborted',
      'batch_aborted',
    ]);

    consoleError.mockRestore();
  });

  it('rejects an add under a parent that does not exist', async () => {
    const result = await sequential([
      { ...addNote('note-1'), parent: 'missing' },
    ]);

    expect(result.actions).toEqual([]);
    expect(result.rejected).toEqual([
      expect.objectContaining({ index: 0, code: 'parent_invalid' }),
    ]);
  });

  describe('keeps the per-action checks for non-admins', () => {
    const hiddenBoard: TuNode[] = [
      { id: 'settings', type: 'settings', content: { notesHidden: true } },
      {
        id: 'theirs',
        type: 'note',
        content: { ...noteContent(), ownerId: 'user-2' },
      },
    ];
    const cases: [string, StateActions[], TuNode[], string[]][] = [
      [
        'a node added in the batch and moved to layer 1',
        [addNote('note-1'), patchNote('note-1', { layer: 1 })],
        [],
        ['batch_aborted', 'layer_admin_only'],
      ],
      [
        "the text of another user's hidden note",
        [addNote('note-1'), patchNote('theirs', { text: '<p>x</p>' })],
        hiddenBoard,
        ['batch_aborted', 'masked_note'],
      ],
      [
        "a comment on another user's hidden note",
        [addNote('note-1'), addComment('comment-1', 'theirs')],
        hiddenBoard,
        ['batch_aborted', 'masked_note'],
      ],
      [
        'a note owned by another user while notes are hidden',
        [
          addNote('note-1'),
          {
            op: 'add',
            data: {
              id: 'note-2',
              type: 'note',
              content: { ...noteContent(), ownerId: 'user-2' },
            },
          },
        ],
        hiddenBoard,
        ['batch_aborted', 'notes_hidden_owner'],
      ],
    ];

    it.each(cases)('rejects %s', async (_, actions, nodes, codes) => {
      const result = await sequential(actions, nodes, false);

      expect(result.actions).toEqual([]);
      expect(result.rejected.map((it) => it.code)).toEqual(codes);
    });
  });

  it('rejects the whole batch for a malformed action', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const result = await sequential([
      { data: { id: 'x', type: 'note' } } as unknown as StateActions,
      addNote('note-1'),
    ]);

    expect(result.actions).toEqual([]);
    expect(result.rejected.map((it) => it.code)).toEqual([
      'invalid_shape',
      'batch_aborted',
    ]);

    consoleError.mockRestore();
  });

  it('normalizes votes against the board before the batch', async () => {
    const settings: TuNode = {
      id: 'settings',
      type: 'settings',
      content: { votesPerUser: 1 },
    };
    const vote = (vote: number) => [{ userId: 'user-1', vote }];
    const actions = [
      addNote('note-1'),
      patchNote('note-1', { votes: vote(3) }),
    ];

    const batch = await sequential(actions, [settings]);

    expect(batch.rejected).toEqual([]);
    expect(batch.actions[1]).toMatchObject({
      data: { content: { votes: vote(1) } },
    });
  });

  it('keeps validation() semantics when not sequential', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const run = (actions: StateActions[], nodes: TuNode[] = []) =>
      Promise.all([
        validation(actions, nodes, 'user-1', true, 'board-1', 'private-1'),
        validateBatch(actions, nodes, 'user-1', true, 'board-1', 'private-1'),
      ]);

    const [samePatch, samePatchBatch] = await run([
      addNote('note-1'),
      patchNote('note-1', { text: 'x' }),
    ]);

    expect(samePatch).toEqual([]);
    expect(samePatchBatch.actions).toEqual([]);
    expect(samePatchBatch.rejected.map((it) => it.code)).toEqual([
      'batch_aborted',
      'node_not_found',
    ]);

    const [shape, shapeBatch] = await run([
      { data: { id: 'x', type: 'note' } } as unknown as StateActions,
      addNote('note-1'),
    ]);

    expect(shapeBatch.actions).toEqual(shape);
    expect(shapeBatch.indices).toEqual([1]);
    expect(shapeBatch.rejected.map((it) => it.code)).toEqual(['invalid_shape']);

    const existing: TuNode = {
      id: 'note-1',
      type: 'note',
      content: noteContent(),
    };
    const [duplicate, duplicateBatch] = await run(
      [addNote('note-1')],
      [existing],
    );

    expect(duplicateBatch.actions).toEqual(duplicate);
    expect(duplicateBatch.actions).toHaveLength(1);

    consoleError.mockRestore();
  });

  it('returns nothing for input that is not an array', async () => {
    await expect(
      validateBatch(
        {} as unknown as StateActions[],
        [],
        'user-1',
        true,
        'board-1',
        'private-1',
        { sequential: true },
      ),
    ).resolves.toEqual({ actions: [], indices: [], rejected: [] });
  });
});
