import { instantiateTemplate, type InstantiateResult } from './instantiate.js';
import type { BoardTemplateData } from './template-format.js';

const template: BoardTemplateData = {
  version: 1,
  size: { width: 800, height: 1000 },
  nodes: [
    {
      ref: 'lane',
      type: 'panel',
      content: {
        position: { x: 0, y: 0 },
        width: 800,
        height: 1000,
        layer: 1,
        text: '<p>Lane</p>',
      },
    },
    {
      ref: 'a',
      type: 'note',
      content: {
        position: { x: 40, y: 160 },
        width: 300,
        height: 300,
        layer: 0,
        text: '<p>A</p>',
        votes: [{ userId: 'x', vote: 1 }],
        emojis: [],
        drawing: [{ color: '#000000', size: 2, points: [] }],
        ownerId: '',
        textHidden: true,
      },
    },
    {
      ref: 'b',
      type: 'note',
      content: {
        position: { x: 400, y: 160 },
        width: 300,
        height: 300,
        layer: 0,
        text: '<p>B</p>',
        votes: [],
        emojis: [],
        drawing: [],
        ownerId: '',
      },
    },
    {
      ref: 'link',
      type: 'arrow',
      content: {
        position: { x: 300, y: 300 },
        width: 120,
        height: 20,
        layer: 0,
        start: { x: 10, y: 10 },
        end: { x: 110, y: 10 },
        strokeStyle: 'solid',
        arrowType: 'sharp',
        startAttachment: { nodeId: 'a', offset: { x: 300, y: 150 } },
        endAttachment: { nodeId: 'b', offset: { x: 0, y: 150 } },
      },
    },
  ],
};

const counter = () => {
  let i = 0;

  return () => `id-${++i}`;
};

const run = (
  options: Partial<Parameters<typeof instantiateTemplate>[1]> = {},
) =>
  instantiateTemplate(template, {
    origin: { x: 1000, y: -500 },
    newId: counter(),
    ownerId: 'me',
    isAdmin: true,
    ...options,
  }) as InstantiateResult;

const contentOf = (result: InstantiateResult, index: number) =>
  result.actions[index].data.content as Record<string, unknown>;

describe('instantiateTemplate', () => {
  it('gives every node a fresh id and maps refs to them', () => {
    const result = run();

    expect(result.actions.map((it) => it.data.id)).toEqual([
      'id-1',
      'id-2',
      'id-3',
      'id-4',
    ]);
    expect(result.refToId).toEqual({
      lane: 'id-1',
      a: 'id-2',
      b: 'id-3',
      link: 'id-4',
    });
    expect(result.actions.every((it) => it.op === 'add')).toBe(true);
    expect(result.actions.every((it) => it.position === undefined)).toBe(true);
  });

  it('remaps arrow attachments to the new ids', () => {
    expect(contentOf(run(), 3)).toMatchObject({
      startAttachment: { nodeId: 'id-2', offset: { x: 300, y: 150 } },
      endAttachment: { nodeId: 'id-3', offset: { x: 0, y: 150 } },
      start: { x: 10, y: 10 },
    });
  });

  it('translates positions by the origin and reports the bounds', () => {
    const result = run();

    expect(contentOf(result, 0)['position']).toEqual({ x: 1000, y: -500 });
    expect(contentOf(result, 1)['position']).toEqual({ x: 1040, y: -340 });
    expect(result.bounds).toEqual({
      x: 1000,
      y: -500,
      width: 800,
      height: 1000,
    });
  });

  it('reports the bounds of the nodes, not the declared size', () => {
    const result = instantiateTemplate(
      { ...template, size: { width: 0, height: 0 } },
      {
        origin: { x: 0, y: 0 },
        newId: counter(),
        ownerId: 'me',
        isAdmin: true,
      },
    ) as InstantiateResult;

    expect(result.bounds).toEqual({ x: 0, y: 0, width: 800, height: 1000 });
  });

  it('clears group votes and the unlock flag', () => {
    const group: BoardTemplateData = {
      version: 1,
      size: { width: 100, height: 100 },
      nodes: [
        {
          ref: 'g',
          type: 'group',
          content: {
            position: { x: 0, y: 0 },
            width: 100,
            height: 100,
            layer: 0,
            title: 'Vote',
            votes: [{ userId: 'someone', vote: 5 }],
            unLocked: true,
          },
        },
      ],
    };
    const result = instantiateTemplate(group, {
      origin: { x: 0, y: 0 },
      newId: counter(),
      ownerId: 'me',
      isAdmin: true,
    }) as InstantiateResult;

    expect(contentOf(result, 0)['votes']).toEqual([]);
    expect(contentOf(result, 0)).not.toHaveProperty('unLocked');
  });

  it('maps prototype names like any other ref', () => {
    const link = { ...template.nodes[3].content };

    delete link['endAttachment'];

    const odd: BoardTemplateData = {
      ...template,
      nodes: [
        { ...template.nodes[1], ref: '__proto__' },
        {
          ...template.nodes[3],
          content: {
            ...link,
            startAttachment: { nodeId: '__proto__', offset: { x: 0, y: 0 } },
          },
        },
      ],
    };
    const result = instantiateTemplate(odd, {
      origin: { x: 0, y: 0 },
      newId: counter(),
      ownerId: 'me',
      isAdmin: true,
    }) as InstantiateResult;

    expect(result.actions[0].data.id).toBe('id-1');
    expect(contentOf(result, 1)['startAttachment']).toMatchObject({
      nodeId: 'id-1',
    });
    expect(Object.keys(result.refToId)).toEqual(['__proto__', 'link']);
  });

  it('makes the inserting user the owner of every note', () => {
    const note = contentOf(run(), 1);

    expect(note).toMatchObject({ ownerId: 'me', votes: [], emojis: [] });
    expect(note['drawing']).toHaveLength(1);
    expect(note).not.toHaveProperty('textHidden');
  });

  it('does not share content with the template', () => {
    const note = contentOf(run(), 1);

    (note['drawing'] as unknown[]).push('x');

    expect(template.nodes[1].content['drawing']).toHaveLength(1);
    expect(template.nodes[1].content.position).toEqual({ x: 40, y: 160 });
  });

  it('keeps stored layers for admins', () => {
    for (const layer of ['auto', 'asStored'] as const) {
      const result = run({ layer });

      expect(
        result.actions.map((_, i) => contentOf(result, i)['layer']),
      ).toEqual([1, 0, 0, 0]);
      expect(result.layerCoerced).toBe(false);
    }
  });

  it('moves everything to layer 0 for non-admins with auto', () => {
    const result = run({ isAdmin: false });

    expect(result.actions.map((_, i) => contentOf(result, i)['layer'])).toEqual(
      [0, 0, 0, 0],
    );
    expect(result.layerCoerced).toBe(true);
  });

  it('refuses asStored for non-admins when a node is on layer 1', () => {
    expect(
      instantiateTemplate(template, {
        origin: { x: 0, y: 0 },
        newId: counter(),
        ownerId: 'me',
        isAdmin: false,
        layer: 'asStored',
      }),
    ).toEqual({ error: 'layer_admin_only' });
  });

  it('lets non-admins insert layer 0 templates as stored', () => {
    const notesOnly = { ...template, nodes: template.nodes.slice(1, 3) };
    const result = instantiateTemplate(notesOnly, {
      origin: { x: 0, y: 0 },
      newId: counter(),
      ownerId: 'me',
      isAdmin: false,
      layer: 'asStored',
    }) as InstantiateResult;

    expect(result.actions).toHaveLength(2);
    expect(result.layerCoerced).toBe(false);
  });
});
