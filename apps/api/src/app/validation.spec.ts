import { describe, expect, it, vi } from 'vitest';
import { StateActions, TuNode } from '@tapiz/board-commons';
import { validateAction, validation } from './validation';

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
      validateAction(action, [], 'user-1', false, 'board-1', 'private-1'),
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
      validateAction(action, [], 'user-1', false, 'board-1', 'private-1'),
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
});
