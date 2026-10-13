import type { TuNode } from '../models/node.model.js';
import { parseBoardTemplate } from './template-format.js';
import { templateFromNodes } from './to-template.js';

const panel: TuNode = {
  id: 'panel-1',
  type: 'panel',
  content: {
    position: { x: 100, y: 200 },
    width: 800,
    height: 1000,
    layer: 1,
    text: '<p>Lane</p>',
    rotation: 0,
    drawing: [],
    unLocked: true,
  },
  children: [{ id: 'c', type: 'comment', content: {} }],
};

const note = (id: string, x: number, ownerId = 'owner'): TuNode => ({
  id,
  type: 'note',
  content: {
    position: { x, y: 400 },
    width: 300,
    height: 300,
    layer: 0,
    text: `<p>${id}</p>`,
    votes: [{ userId: 'u', vote: 2 }],
    emojis: [{ unicode: '🎉', position: { x: 1, y: 1 } }],
    drawing: [{ color: '#000000', size: 2, points: [{ x: 0, y: 0 }] }],
    ownerId,
    textHidden: true,
  },
  children: [{ id: 'comment', type: 'comment', content: {} }],
});

const arrow = (id: string, start?: string, end?: string): TuNode => ({
  id,
  type: 'arrow',
  content: {
    position: { x: 150, y: 450 },
    width: 400,
    height: 40,
    layer: 0,
    start: { x: 10, y: 20 },
    end: { x: 390, y: 20 },
    strokeStyle: 'solid',
    arrowType: 'sharp',
    ...(start
      ? { startAttachment: { nodeId: start, offset: { x: 300, y: 150 } } }
      : {}),
    ...(end
      ? { endAttachment: { nodeId: end, offset: { x: 0, y: 150 } } }
      : {}),
  },
});

const asset = (id: string, type: string, url: string): TuNode => ({
  id,
  type,
  content: {
    position: { x: 100, y: 200 },
    width: 50,
    height: 50,
    layer: 1,
    rotation: 0,
    url,
  },
});

describe('templateFromNodes', () => {
  it('normalises to the bounding box and keeps the board order', () => {
    const a = note('a', 200);
    const b = note('b', 600);
    const { data } = templateFromNodes([b, a, panel], {
      boardNodes: [{ id: 'user', type: 'user', content: {} }, panel, a, b],
    });

    expect(data.nodes.map((it) => it.ref)).toEqual(['panel-1', 'a', 'b']);
    expect(data.size).toEqual({ width: 800, height: 1000 });
    expect(data.nodes[0].content.position).toEqual({ x: 0, y: 0 });
    expect(data.nodes[1].content.position).toEqual({ x: 100, y: 200 });
    expect(parseBoardTemplate(data).ok).toBe(true);
  });

  it('strips board state and children but keeps note drawings', () => {
    const { data } = templateFromNodes([panel, note('a', 200)]);
    const [savedPanel, savedNote] = data.nodes;

    expect(savedPanel).not.toHaveProperty('children');
    expect(savedPanel.content).not.toHaveProperty('unLocked');
    expect(savedNote).not.toHaveProperty('children');
    expect(savedNote.content).toMatchObject({
      votes: [],
      emojis: [],
      ownerId: '',
      drawing: [{ color: '#000000', size: 2, points: [{ x: 0, y: 0 }] }],
    });
    expect(savedNote.content).not.toHaveProperty('textHidden');
  });

  it('strips group votes', () => {
    const group: TuNode = {
      id: 'g',
      type: 'group',
      content: {
        position: { x: 0, y: 0 },
        width: 10,
        height: 10,
        layer: 0,
        title: 'G',
        votes: [{ userId: 'u', vote: 1 }],
      },
    };

    expect(templateFromNodes([group]).data.nodes[0].content).not.toHaveProperty(
      'votes',
    );
  });

  it('defaults a missing layer to 0', () => {
    const legacy: TuNode = {
      id: 'legacy',
      type: 'panel',
      content: { position: { x: 0, y: 0 }, width: 10, height: 10 },
    };
    const { data } = templateFromNodes([legacy]);

    expect(data.nodes[0].content.layer).toBe(0);
    expect(parseBoardTemplate(data).ok).toBe(true);
  });

  it('drops disallowed types, masked notes and board-scoped assets, and skips runtime nodes', () => {
    const { data, dropped } = templateFromNodes(
      [
        panel,
        note('mine', 200, 'me'),
        note('theirs', 600, 'them'),
        { id: 'poll', type: 'poll', content: { position: { x: 0, y: 0 } } },
        { id: 'u', type: 'user', content: {} },
        { id: 's', type: 'settings', content: {} },
        { id: 't', type: 'timer', content: {} },
        asset('upload', 'image', 'a1b2c3.png'),
        asset('data-vector', 'vector', 'data:image/svg+xml;base64,PHN2Zz4='),
        asset('relative-vector', 'vector', 'assets/x.svg'),
        asset('web-image', 'image', 'https://example.com/x.png'),
        asset('web-vector', 'vector', 'http://example.com/x.svg'),
      ],
      {
        isMasked: (node) =>
          (node.content as { ownerId?: string }).ownerId !== 'me',
      },
    );

    expect(data.nodes.map((it) => it.ref)).toEqual([
      'panel-1',
      'mine',
      'web-image',
      'web-vector',
    ]);
    expect(dropped).toEqual([
      { id: 'theirs', type: 'note', reason: 'masked_note' },
      { id: 'poll', type: 'poll', reason: 'type_not_allowed' },
      { id: 'upload', type: 'image', reason: 'board_scoped_asset' },
      { id: 'data-vector', type: 'vector', reason: 'board_scoped_asset' },
      { id: 'relative-vector', type: 'vector', reason: 'board_scoped_asset' },
    ]);
    expect(parseBoardTemplate(data).ok).toBe(true);
  });

  it('uses ids as refs only when they match the pattern', () => {
    const odd = note('has space', 200);
    const clash = note('n1', 600);
    const { data } = templateFromNodes([odd, clash, arrow('x', 'has space')]);

    expect(data.nodes.map((it) => it.ref)).toEqual(['n0', 'n1', 'x']);
    expect(data.nodes[2].content['startAttachment']).toEqual({
      nodeId: 'n0',
      offset: { x: 300, y: 150 },
    });

    const second = templateFromNodes([clash, odd]);

    expect(second.data.nodes.map((it) => it.ref)).toEqual(['n1', 'n1_1']);
    expect(parseBoardTemplate(second.data).ok).toBe(true);
  });

  it('remaps attachments inside the selection to refs', () => {
    const { data, detachedArrows } = templateFromNodes([
      note('a', 200),
      note('b', 600),
      arrow('arrow', 'a', 'b'),
    ]);

    expect(detachedArrows).toEqual([]);
    expect(data.nodes[2].content).toMatchObject({
      startAttachment: { nodeId: 'a' },
      endAttachment: { nodeId: 'b' },
    });
    expect(parseBoardTemplate(data).ok).toBe(true);
  });

  it('bounds attached arrows where they render, not where they were stored', () => {
    const { data } = templateFromNodes([
      note('n1', 5000),
      note('n2', 5600),
      arrow('link', 'n1', 'n2'),
    ]);

    expect(data.size).toEqual({ width: 900, height: 300 });
    expect(data.nodes.map((it) => it.content.position)).toEqual([
      { x: 0, y: 0 },
      { x: 600, y: 0 },
      { x: 290, y: 140 },
    ]);
    expect(data.nodes[2].content).toMatchObject({
      width: 320,
      height: 20,
      start: { x: 10, y: 10 },
      end: { x: 310, y: 10 },
    });
    expect(parseBoardTemplate(data).ok).toBe(true);
  });

  it('detaches arrows from nodes outside the template and keeps where they render', () => {
    const { data, detachedArrows } = templateFromNodes(
      [
        note('a', 200),
        note('masked', 600, 'them'),
        arrow('to-outside', 'a', 'elsewhere'),
        arrow('to-masked', 'masked'),
      ],
      { isMasked: (node) => node.id === 'masked' },
    );
    const [, toOutside, toMasked] = data.nodes;

    expect(detachedArrows).toEqual(['to-outside', 'to-masked']);
    expect(toOutside.content['startAttachment']).toEqual({
      nodeId: 'a',
      offset: { x: 300, y: 150 },
    });
    expect(toOutside.content).not.toHaveProperty('endAttachment');
    expect(toMasked.content).not.toHaveProperty('startAttachment');
    // the start was drawn at the masked note's right edge
    expect(toMasked.content).toMatchObject({
      width: 380,
      height: 100,
      start: { x: 370, y: 90 },
      end: { x: 10, y: 10 },
    });
    expect(parseBoardTemplate(data).ok).toBe(true);
  });

  it('resolves arrows against board nodes outside the selection', () => {
    const target = note('target', 1000);
    const { data, detachedArrows } = templateFromNodes(
      [arrow('to-outside', undefined, 'target')],
      { boardNodes: [target] },
    );

    expect(detachedArrows).toEqual(['to-outside']);
    expect(data.nodes[0].content).not.toHaveProperty('endAttachment');
    // stored start (160, 470) to the target's left edge (1000, 550)
    expect(data.size).toEqual({ width: 860, height: 100 });
  });

  it('never uses reserved names as refs', () => {
    const { data } = templateFromNodes([
      note('__proto__', 0),
      note('constructor', 400),
    ]);

    expect(data.nodes.map((it) => it.ref)).toEqual(['n0', 'n1']);
    expect(parseBoardTemplate(data).ok).toBe(true);
  });

  it('does not change the board nodes', () => {
    const a = note('a', 200);
    const copy = structuredClone(a);

    templateFromNodes([a]);

    expect(a).toEqual(copy);
  });
});
