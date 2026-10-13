import type { TuNode } from '../models/node.model.js';
import { lintNodes, type LintCode } from './lint.js';
import { presetHtml } from './text-presets.js';

const panel = (id: string, content: Record<string, unknown> = {}): TuNode => ({
  id,
  type: 'panel',
  content: {
    position: { x: 0, y: 0 },
    width: 720,
    height: 1200,
    layer: 1,
    text: presetHtml({ preset: 'heading', text: 'Lane' }),
    ...content,
  },
});

const note = (
  id: string,
  x: number,
  y: number,
  content: Record<string, unknown> = {},
): TuNode => ({
  id,
  type: 'note',
  content: {
    position: { x, y },
    width: 300,
    height: 300,
    layer: 0,
    text: '<p>Idea</p>',
    ...content,
  },
});

const text = (id: string, html: string, height: number): TuNode => ({
  id,
  type: 'text',
  content: {
    position: { x: 0, y: 2000 },
    width: 400,
    height,
    layer: 1,
    text: html,
  },
});

const codes = (nodes: TuNode[], options?: Parameters<typeof lintNodes>[1]) =>
  lintNodes(nodes, options).map((issue) => issue.code);

describe('lintNodes', () => {
  it('reports nothing for a tidy lane', () => {
    expect(
      codes([panel('p'), note('a', 40, 160), note('b', 380, 160)], {
        isAdmin: true,
      }),
    ).toEqual([]);
  });

  it('flags layer 1 nodes for non-admins only', () => {
    expect(codes([panel('p')], { isAdmin: false })).toEqual([
      'layer_admin_only',
    ]);
    expect(codes([panel('p')])).toEqual([]);
  });

  it('does not flag layer 1 nodes that were already on the board', () => {
    const nodes = [panel('old'), panel('new', { position: { x: 2000, y: 0 } })];

    expect(
      lintNodes(nodes, { isAdmin: false, existingIds: ['old'] }),
    ).toMatchObject([{ code: 'layer_admin_only', nodeIds: ['new'] }]);
  });

  it('flags nonpositive sizes as errors', () => {
    const issues = lintNodes([note('a', 0, 0, { width: 0 })]);

    expect(issues).toMatchObject([
      { level: 'error', code: 'nonpositive_size', nodeIds: ['a'] },
    ]);
  });

  it('flags text that overflows its node', () => {
    const long = presetHtml({ preset: 'body', text: 'word '.repeat(200) });

    expect(codes([text('t', long, 100)])).toEqual(['text_overflow']);
    expect(codes([text('t', '<p>short</p>', 100)])).toEqual([]);
    expect(
      codes([
        panel('p', {
          height: 60,
          text: presetHtml({ preset: 'display', text: 'Huge title here' }),
        }),
      ]),
    ).toContain('text_overflow');
  });

  it('flags raw headings with their rendered size', () => {
    const [issue] = lintNodes([text('t', '<h2>Big</h2>', 400)]);

    expect(issue.code).toBe('raw_heading');
    expect(issue.message).toContain('160px');
  });

  it('flags notes whose text shrinks too far', () => {
    expect(
      codes([
        note('a', 0, 0, { text: `<p>${'many words here '.repeat(40)}</p>` }),
      ]),
    ).toEqual(['note_text_too_long']);
  });

  it('flags overlapping notes but tolerates a small overlap', () => {
    expect(codes([note('a', 0, 0), note('b', 100, 0)])).toEqual([
      'note_overlap',
    ]);
    expect(codes([note('a', 0, 0), note('b', 280, 0)])).toEqual([]);
  });

  it('skips rotated notes for geometric checks', () => {
    expect(
      codes([note('a', 0, 0), note('b', 100, 0, { rotation: 10 })]),
    ).toEqual([]);
  });

  it("flags notes covering a panel's title", () => {
    const issues = lintNodes([panel('p'), note('a', 40, 10)]);

    expect(issues.map((it) => it.code)).toEqual(['note_in_header']);
    expect(issues[0].nodeIds).toEqual(['a', 'p']);
  });

  it('flags a panel color that recolours its notes', () => {
    const issues = lintNodes([
      panel('p', { color: '#ff0000' }),
      note('a', 40, 160),
    ]);

    expect(issues.map((it) => it.code)).toEqual(['panel_color_recolors_notes']);
    expect(issues[0].nodeIds).toEqual(['p', 'a']);
    expect(
      codes([panel('p', { backgroundColor: '#ff0000' }), note('a', 40, 160)]),
    ).toEqual([]);
  });

  it('flags new nodes that overlap existing content', () => {
    const nodes = [
      note('old', 0, 0),
      note('new', 200, 200),
      note('far', 5000, 0),
    ];

    expect(
      lintNodes(nodes, { existingIds: ['old'], scopeIds: ['new', 'far'] }),
    ).toMatchObject([{ code: 'overlaps_existing', nodeIds: ['new'] }]);
  });

  it('does not treat a frame around a new node as an obstacle', () => {
    const options = { existingIds: ['p'], scopeIds: ['new'] };

    expect(codes([panel('p'), note('new', 40, 160)], options)).toEqual([]);
    const group: TuNode = {
      id: 'g',
      type: 'group',
      content: { position: { x: 0, y: 0 }, width: 720, height: 1200, layer: 0 },
    };

    expect(
      codes([group, note('new', 40, 160)], {
        existingIds: ['g'],
        scopeIds: ['new'],
      }),
    ).toEqual([]);
    // straddling the edge of the panel
    expect(codes([panel('p'), note('new', 600, 160)], options)).toEqual([
      'overlaps_existing',
    ]);
    // a note already in the panel is still in the way
    expect(
      codes([panel('p'), note('old', 40, 160), note('new', 100, 200)], {
        existingIds: ['p', 'old'],
        scopeIds: ['new'],
      }),
    ).toEqual(['note_overlap', 'overlaps_existing']);
  });

  it('flags attachments to missing nodes', () => {
    const arrow: TuNode = {
      id: 'arrow',
      type: 'arrow',
      content: {
        position: { x: 0, y: 3000 },
        width: 100,
        height: 20,
        layer: 0,
        startAttachment: { nodeId: 'a', offset: { x: 0, y: 0 } },
        endAttachment: { nodeId: 'gone', offset: { x: 0, y: 0 } },
      },
    };

    const issues = lintNodes([note('a', 0, 0), arrow]);

    expect(issues.map((it) => it.code)).toEqual(['dangling_attachment']);
    expect(issues[0].message).toBe('Attached to missing node gone');
    expect(
      lintNodes([
        note('a', 0, 0),
        note('b', 1000, 0),
        {
          ...arrow,
          content: {
            ...arrow.content,
            endAttachment: { nodeId: 'b', offset: { x: 0, y: 0 } },
          },
        },
      ]),
    ).toEqual([]);
  });

  it('only reports issues that touch the scope', () => {
    const nodes = [
      note('a', 0, 0),
      note('b', 100, 0),
      text('t', '<h1>Old</h1>', 1000),
      note('c', 2000, 0),
    ];
    const all: LintCode[] = ['note_overlap', 'raw_heading'];

    expect(codes(nodes).sort()).toEqual([...all].sort());
    expect(codes(nodes, { scopeIds: ['c'] })).toEqual([]);
    expect(codes(nodes, { scopeIds: ['b'] })).toEqual(['note_overlap']);
  });

  it('ignores runtime nodes', () => {
    expect(
      codes([
        { id: 'u', type: 'user', content: { position: { x: 0, y: 0 } } },
        { id: 's', type: 'settings', content: {} },
        note('a', 0, 0),
      ]),
    ).toEqual([]);
  });
});
