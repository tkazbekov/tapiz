import type { TuNode } from '../models/node.model.js';
import {
  expandLayout,
  LAYOUT_EXAMPLES,
  LAYOUT_SIZES,
  type ExpandedLayout,
} from './expand.js';
import {
  boundsOfNodes,
  nodeBounds,
  rectContains,
  type Rect,
} from './geometry.js';
import type { LayoutDecoration, LayoutSpecInput } from './layout-spec.js';
import { lintNodes } from './lint.js';
import { boardTemplateDataSchema } from './template-format.js';
import { estimatePanelTextBottom } from './text-estimate.js';
import { presetHtml } from './text-presets.js';

const NOTE_COLOR = '#fdab61';

const retro: LayoutSpecInput = {
  kind: 'columns',
  title: 'Sprint 42 retro',
  description: 'What should we keep, drop and try next sprint?',
  cells: [
    {
      title: 'Went well',
      subtitle: 'Wins worth repeating',
      backgroundColor: '#e6f4ea',
      notes: ['Fast reviews', 'Pairing on the parser', 'Demo went smoothly'],
    },
    { title: 'To improve', notes: ['Flaky CI'] },
    { title: 'Actions' },
  ],
};

const quadrants: LayoutSpecInput = {
  kind: 'quadrants',
  title: 'Prioritisation',
  cells: [
    { title: 'Quick wins', notes: ['Fix typo'] },
    { title: 'Big bets' },
    { title: 'Fill-ins' },
    { title: 'Money pits' },
  ],
  axes: { x: ['Low effort', 'High effort'], y: ['Low value', 'High value'] },
};

const grid: LayoutSpecInput = {
  kind: 'grid',
  cells: Array.from({ length: 5 }, (_, i) => ({
    title: `Team ${i + 1}`,
    notes: i === 0 ? ['a', 'b', 'c', 'd', 'e'] : [],
  })),
  noteColumns: 3,
};

const asBoardNodes = ({ template }: ExpandedLayout): TuNode[] =>
  template.nodes.map((node) => ({
    id: node.ref,
    type: node.type,
    content: node.content,
  }));

const expand = (spec: LayoutSpecInput) =>
  expandLayout(spec, { noteColor: NOTE_COLOR });

describe('expandLayout', () => {
  it('sizes columns from the note grid', () => {
    const { template, cells } = expand(retro);
    const panels = template.nodes.filter((node) => node.type === 'panel');

    expect(panels).toHaveLength(3);
    panels.forEach((panel) => {
      expect(panel.content['width']).toBe(720);
      expect(panel.content['height']).toBe(panels[0].content['height']);
    });
    expect(cells.map((cell) => cell.bounds.x)).toEqual([0, 780, 1560]);
    expect(template.size.width).toBe(3 * 720 + 2 * 60);
  });

  it('puts panels first, then texts, then notes', () => {
    const { template } = expand(retro);

    expect(template.nodes.map((node) => node.ref)).toEqual([
      'cell-0',
      'cell-1',
      'cell-2',
      'title',
      'description',
      'cell-0-note-0',
      'cell-0-note-1',
      'cell-0-note-2',
      'cell-1-note-0',
    ]);
  });

  it('places notes in 300px slots with an empty row to spare', () => {
    const { template, cells } = expand(retro);
    const [first] = cells;
    const notes = template.nodes.filter((node) => node.type === 'note');

    // capacity 6 with 2 note columns: 3 rows
    expect(first.noteRefs).toHaveLength(3);
    expect(first.freeSlots).toHaveLength(3);
    expect(cells[2].freeSlots).toHaveLength(6);
    expect(notes[1].content.position.x - notes[0].content.position.x).toBe(340);
    expect(notes[2].content.position.y - notes[0].content.position.y).toBe(340);
    expect(first.freeSlots[0]).toEqual({
      x: notes[1].content.position.x,
      y: notes[2].content.position.y,
    });
    notes.forEach((note) => {
      expect(note.content).toMatchObject({
        width: 300,
        height: 300,
        layer: 0,
        color: NOTE_COLOR,
        ownerId: '',
      });
    });
  });

  it('keeps every note and free slot inside its cell', () => {
    [retro, quadrants, grid].forEach((spec) => {
      const { template, cells } = expand(spec);
      const byRef = new Map(template.nodes.map((node) => [node.ref, node]));

      cells.forEach((cell) => {
        const panel = byRef.get(cell.ref);

        expect(panel?.content.position).toEqual({
          x: cell.bounds.x,
          y: cell.bounds.y,
        });

        const slots = [
          ...cell.noteRefs.map((ref) => byRef.get(ref)?.content.position),
          ...cell.freeSlots,
        ];

        slots.forEach((slot) => {
          expect(
            rectContains(cell.bounds, {
              x: slot?.x ?? NaN,
              y: slot?.y ?? NaN,
              width: 300,
              height: 300,
            }),
          ).toBe(true);
        });
      });
    });
  });

  it('adds rows when the seeded notes need them', () => {
    const small = expand({
      kind: 'columns',
      cells: [{ title: 'A', notes: ['1', '2', '3', '4', '5'] }],
    });
    const large = expand({
      kind: 'columns',
      cells: [{ title: 'A', notes: Array(9).fill('x') }],
    });

    // 5 notes: 3 full rows + 1 spare row
    expect(small.cells[0].freeSlots).toHaveLength(3);
    expect(large.cells[0].freeSlots).toHaveLength(3);
    expect(large.cells[0].bounds.height).toBeGreaterThan(
      small.cells[0].bounds.height,
    );
  });

  it('honours capacity and note columns', () => {
    const { cells } = expand({
      kind: 'columns',
      cells: [{ title: 'A', capacity: 12 }],
      noteColumns: 4,
    });

    expect(cells[0].bounds.width).toBe(80 + 4 * 300 + 3 * 40);
    expect(cells[0].freeSlots).toHaveLength(12);
  });

  it('arranges grids and quadrants in rows', () => {
    const gridCells = expand(grid).cells;

    // 5 cells: ceil(sqrt(5)) = 3 per row
    expect(gridCells[3].bounds.x).toBe(gridCells[0].bounds.x);
    expect(gridCells[3].bounds.y).toBeGreaterThan(gridCells[0].bounds.y);
    expect(
      expand({ ...grid, gridColumns: 5 }).cells.every(
        (cell) => cell.bounds.y === gridCells[0].bounds.y,
      ),
    ).toBe(true);

    const quad = expand(quadrants);

    expect(quad.cells[1].bounds.y).toBe(quad.cells[0].bounds.y);
    expect(quad.cells[2].bounds.x).toBe(quad.cells[0].bounds.x);
    expect(quad.cells[2].bounds.y).toBeGreaterThan(quad.cells[0].bounds.y);
  });

  it('labels quadrant axes and starts the layout at the origin', () => {
    const { template, cells } = expand(quadrants);
    const refs = template.nodes.map((node) => node.ref);

    expect(refs).toEqual(
      expect.arrayContaining(['axis-x-0', 'axis-x-1', 'axis-y-0', 'axis-y-1']),
    );
    expect(cells[0].bounds.x).toBe(320);
    expect(
      Math.min(...template.nodes.map((node) => node.content.position.x)),
    ).toBe(0);
    expect(
      Math.min(...template.nodes.map((node) => node.content.position.y)),
    ).toBe(0);
  });

  it('places axis captions in reading order', () => {
    const { template } = expand(quadrants);
    const at = (text: string) =>
      template.nodes.find((node) => String(node.content['text']).includes(text))
        ?.content.position;

    expect(at('Low value')!.y).toBeLessThan(at('High value')!.y);
    expect(at('Low effort')!.x).toBeLessThan(at('High effort')!.x);
  });

  it('never sets the panel color and never emits raw headings', () => {
    [retro, quadrants, grid].forEach((spec) => {
      expand(spec).template.nodes.forEach((node) => {
        if (node.type === 'panel') {
          expect(node.content).not.toHaveProperty('color');
          expect(node.content['layer']).toBe(1);
        }

        expect(String(node.content['text'] ?? '')).not.toMatch(/<h[1-3]/);
      });
    });
  });

  it('is deterministic', () => {
    expect(expand(retro)).toEqual(expand(retro));
    expect(expand(quadrants)).toEqual(expand(quadrants));
  });

  it('prefers the spec note colour', () => {
    const { template } = expand({ ...retro, noteColor: '#aabbcc' });

    expect(
      template.nodes.find((node) => node.type === 'note')?.content['color'],
    ).toBe('#aabbcc');
  });

  it('grows the header band with the title, from a 120px floor', () => {
    const band = (title: string, subtitle?: string) => {
      const [cell] = expand({
        kind: 'columns',
        cells: [{ title, subtitle }],
      }).cells;

      return cell.freeSlots[0].y - cell.bounds.y;
    };
    const title = 'a rather long heading '.repeat(8).trim();
    const subtitle = 'with a long caption under it '.repeat(16).trim();
    const header = presetHtml([
      { preset: 'title', text: title },
      { preset: 'caption', text: subtitle },
    ]);
    const short = presetHtml({ preset: 'title', text: 'Short' });
    const long = band(title, subtitle);

    expect(band('Short')).toBe(
      Math.max(120, estimatePanelTextBottom(short, 720) + 28),
    );
    expect(long).toBe(estimatePanelTextBottom(header, 720) + 28);
    expect(long).toBeGreaterThan(400);
  });

  it('produces valid, lint-clean templates', () => {
    [retro, quadrants, grid].forEach((spec) => {
      const layout = expand(spec);

      expect(boardTemplateDataSchema.safeParse(layout.template).success).toBe(
        true,
      );
      expect(lintNodes(asBoardNodes(layout), { isAdmin: true })).toEqual([]);
    });
  });

  it('rejects invalid specs and layouts that are too large', () => {
    expect(() =>
      expand({ kind: 'quadrants', cells: [{ title: 'A' }] }),
    ).toThrow();
    expect(() =>
      expand({
        kind: 'grid',
        cells: Array.from({ length: 12 }, () => ({
          title: 'A',
          notes: Array(30).fill('x'),
        })),
      }),
    ).toThrow(/layout_too_large/);
  });
});

const STAR = 'https://cocomaterial.com/media/sea_starfish_1.svg';
const PNG = 'https://cocomaterial.com/media/photo.png';

const deco = (
  anchor: LayoutDecoration['anchor'],
  extra: Partial<LayoutDecoration> = {},
): LayoutDecoration => ({
  url: STAR,
  anchor,
  width: 200,
  height: 100,
  ...extra,
});

const radial = (
  count: number,
  extra: Partial<LayoutSpecInput> = {},
): LayoutSpecInput => ({
  kind: 'radial',
  cells: Array.from({ length: count }, (_, i) => ({ title: `Arm ${i}` })),
  ...extra,
});

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`missing ${what}`);
  }

  return value;
}

const layoutBounds = (layout: ExpandedLayout) =>
  must(boundsOfNodes(asBoardNodes(layout)), 'bounds');

const rectOfRef = (layout: ExpandedLayout, ref: string): Rect => {
  const node = layout.template.nodes.find((it) => it.ref === ref);

  if (!node) {
    throw new Error(`no node ${ref}`);
  }

  return must(
    nodeBounds({ id: ref, type: node.type, content: node.content }),
    `bounds of ${ref}`,
  );
};

const centre = (rect: Rect) => ({
  x: rect.x + rect.width / 2,
  y: rect.y + rect.height / 2,
});

const gap = (a: Rect, b: Rect) =>
  Math.max(
    b.x - (a.x + a.width),
    a.x - (b.x + b.width),
    b.y - (a.y + a.height),
    a.y - (b.y + b.height),
  );

describe('expandLayout radial', () => {
  const holes = [
    undefined,
    deco('center', { width: 600, height: 616 }),
    deco('center', { width: 1500, height: 300, rotation: 30 }),
  ];
  // default cells, wide flat cells and narrow tall cells
  const shapes: Partial<LayoutSpecInput>[] = [
    {},
    { noteColumns: 4 },
    { noteColumns: 1 },
  ];

  it('keeps cells apart and clear of the centre art for 2 to 8 cells', () => {
    holes.forEach((hole) => {
      shapes.forEach((shape) => {
        for (let count = 2; count <= 8; count++) {
          const base = radial(count, shape);
          const layout = expand({
            ...base,
            cells: base.cells.map((cell) => ({
              ...cell,
              capacity: shape.noteColumns === 4 ? 1 : undefined,
            })),
            ...(hole ? { decorations: [hole] } : {}),
          });
          const rects = layout.cells.map((cell) => cell.bounds);

          rects.forEach((a, i) => {
            rects.slice(i + 1).forEach((b) => {
              expect(gap(a, b)).toBeGreaterThanOrEqual(LAYOUT_SIZES.CELL_GAP);
            });

            if (hole) {
              expect(
                gap(a, rectOfRef(layout, 'decoration-0')),
              ).toBeGreaterThanOrEqual(LAYOUT_SIZES.CELL_GAP);
            }
          });
        }
      });
    });
  });

  it('places the centre art in the middle of the ring', () => {
    const layout = expand(radial(6, { decorations: [deco('center')] }));
    const art = centre(rectOfRef(layout, 'decoration-0'));
    const cells = layout.cells.map((cell) => centre(cell.bounds));
    const mean = {
      x: cells.reduce((sum, it) => sum + it.x, 0) / cells.length,
      y: cells.reduce((sum, it) => sum + it.y, 0) / cells.length,
    };

    expect(Math.abs(art.x - mean.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(art.y - mean.y)).toBeLessThanOrEqual(1);

    const radii = cells.map((it) => Math.hypot(it.x - art.x, it.y - art.y));

    radii.forEach((radius) => {
      expect(Math.abs(radius - radii[0])).toBeLessThanOrEqual(2);
    });
  });

  it('grows the ring around bigger centre art', () => {
    const radius = (layout: ExpandedLayout) =>
      centre(layout.cells[0].bounds).y - centre(layout.cells[2].bounds).y;
    const small = expand(radial(4, { decorations: [deco('center')] }));
    const big = expand(
      radial(4, {
        decorations: [deco('center', { width: 3000, height: 3000 })],
      }),
    );

    expect(Math.abs(radius(big))).toBeGreaterThan(Math.abs(radius(small)));
  });

  it('starts at the top and goes clockwise', () => {
    [3, 4, 5, 8].forEach((count) => {
      const layout = expand(radial(count, { decorations: [deco('center')] }));
      const middle = centre(rectOfRef(layout, 'decoration-0'));
      const angles = layout.cells.map((cell) => {
        const at = centre(cell.bounds);

        // clockwise on screen from 12 o'clock, in [0, 360)
        return (
          ((Math.atan2(at.x - middle.x, -(at.y - middle.y)) * 180) / Math.PI +
            360) %
          360
        );
      });

      expect(angles[0]).toBeLessThan(1);
      angles.slice(1).forEach((angle, i) => {
        expect(angle).toBeGreaterThan(angles[i]);
        expect(angle - angles[i]).toBeCloseTo(360 / count, 0);
      });
    });
  });

  it('puts the title above the ring and starts at the origin', () => {
    const layout = expand(
      radial(5, { title: 'Starfish', decorations: [deco('center')] }),
    );
    const title = rectOfRef(layout, 'title');

    layout.cells.forEach((cell) => {
      expect(cell.bounds.y).toBeGreaterThanOrEqual(
        title.y + title.height + LAYOUT_SIZES.TITLE_GAP,
      );
    });
    expect(boundsOfNodes(asBoardNodes(layout))).toMatchObject({ x: 0, y: 0 });
  });

  it('defaults radial cells to two rows of notes', () => {
    const [cell] = expand(radial(3)).cells;

    expect(cell.freeSlots).toHaveLength(4);
  });
});

describe('expandLayout cell styles', () => {
  const panelOf = (style: Record<string, unknown>, extra = {}) =>
    expand({
      kind: 'columns',
      cells: [{ title: 'A', style, ...extra }],
    }).template.nodes.find((node) => node.type === 'panel')?.content ?? {};

  it('maps shapes to border radii', () => {
    expect(panelOf({}).borderRadius).toBe(12);
    expect(panelOf({ shape: 'rect' }).borderRadius).toBe(0);
    expect(panelOf({ shape: 'rounded' }).borderRadius).toBe(24);
    expect(panelOf({ shape: 'pill' }).borderRadius).toBe(150);

    const pill = expand({
      kind: 'columns',
      noteColumns: 1,
      cells: [{ title: 'A', style: { shape: 'pill' } }],
    }).template.nodes[0].content;

    expect(pill['borderRadius']).toBe(
      Math.min(
        150,
        Math.floor(
          Math.min(pill['width'] as number, pill['height'] as number) / 2,
        ),
      ),
    );
    expect(Number.isInteger(pill['borderRadius'])).toBe(true);
  });

  it('sets colours and borders, never the panel color', () => {
    const content = panelOf(
      { backgroundColor: '#112233', borderColor: '#445566', borderWidth: 6 },
      { backgroundColor: '#ffffff' },
    );

    expect(content).toMatchObject({
      backgroundColor: '#112233',
      borderColor: '#445566',
      borderWidth: 6,
    });
    expect(content).not.toHaveProperty('color');
    expect(panelOf({}, { backgroundColor: '#e6f4ea' }).backgroundColor).toBe(
      '#e6f4ea',
    );
  });

  it('makes frameless cells transparent without a border', () => {
    const content = panelOf(
      { frameless: true, backgroundColor: '#112233', borderWidth: 4 },
      { backgroundColor: '#ffffff' },
    );

    expect(content).toMatchObject({
      backgroundColor: 'transparent',
      borderWidth: 0,
    });
    expect(content).not.toHaveProperty('color');
  });
});

describe('expandLayout decorations', () => {
  const base: LayoutSpecInput = {
    kind: 'grid',
    title: 'Board',
    gridColumns: 2,
    cells: [{ title: 'A', notes: ['x'] }, { title: 'B' }, { title: 'C' }],
  };
  const withDecorations = (...decorations: LayoutDecoration[]) =>
    expand({ ...base, decorations });
  const cellsRect = (layout: ExpandedLayout) =>
    layout.cells
      .map((cell) => cell.bounds)
      .reduce((a, b) => {
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);

        return {
          x,
          y,
          width: Math.max(a.x + a.width, b.x + b.width) - x,
          height: Math.max(a.y + a.height, b.y + b.height) - y,
        };
      });

  it('emits vectors for svg and images otherwise, on layer 1', () => {
    const layout = withDecorations(
      deco('center'),
      deco('top-left', { url: PNG }),
    );

    expect(
      layout.template.nodes.find((n) => n.ref === 'decoration-0'),
    ).toMatchObject({
      type: 'vector',
      content: { url: STAR, layer: 1, rotation: 0, width: 200, height: 100 },
    });
    expect(
      layout.template.nodes.find((n) => n.ref === 'decoration-1'),
    ).toMatchObject({ type: 'image', content: { url: PNG, layer: 1 } });
  });

  it('orders behind art first, then panels, stickers, texts and notes', () => {
    const layout = withDecorations(
      deco('top-right'),
      deco('behind', { width: 2000, height: 2000 }),
      deco({ cell: 0, corner: 'top-left' }),
    );
    const refs = layout.template.nodes.map((node) => node.ref);

    expect(refs).toEqual([
      'decoration-1',
      'cell-0',
      'cell-1',
      'cell-2',
      'decoration-0',
      'decoration-2',
      'title',
      'cell-0-note-0',
    ]);
  });

  it('centres center and behind art on the cells', () => {
    const layout = withDecorations(deco('center'), deco('behind'));
    const middle = centre(cellsRect(layout));

    ['decoration-0', 'decoration-1'].forEach((ref) => {
      const at = centre(rectOfRef(layout, ref));

      expect(Math.abs(at.x - middle.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(at.y - middle.y)).toBeLessThanOrEqual(1);
    });
  });

  it('puts corner stickers half outside the whole layout', () => {
    const layout = withDecorations(
      deco('top-left'),
      deco('top-right'),
      deco('bottom-left'),
      deco('bottom-right'),
    );
    const title = rectOfRef(layout, 'title');
    const grid = cellsRect(layout);
    const corners = [
      { x: grid.x, y: title.y },
      { x: grid.x + grid.width, y: title.y },
      { x: grid.x, y: grid.y + grid.height },
      { x: grid.x + grid.width, y: grid.y + grid.height },
    ];

    corners.forEach((corner, index) => {
      const at = centre(rectOfRef(layout, `decoration-${index}`));

      expect(Math.abs(at.x - corner.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(at.y - corner.y)).toBeLessThanOrEqual(1);
    });
  });

  it('anchors stickers to a cell corner or centre, plus the offset', () => {
    const layout = withDecorations(
      deco({ cell: 1, corner: 'bottom-right' }),
      deco({ cell: 2, corner: 'center' }, { offset: { x: 30, y: -20 } }),
    );
    const one = layout.cells[1].bounds;
    const two = centre(layout.cells[2].bounds);

    expect(centre(rectOfRef(layout, 'decoration-0'))).toEqual({
      x: one.x + one.width,
      y: one.y + one.height,
    });
    const art = centre(rectOfRef(layout, 'decoration-1'));

    // positions are whole pixels
    expect(Math.abs(art.x - (two.x + 30))).toBeLessThanOrEqual(0.5);
    expect(Math.abs(art.y - (two.y - 20))).toBeLessThanOrEqual(0.5);
  });

  it('keeps the visual centre of rotated art on its anchor', () => {
    const plain = withDecorations(deco({ cell: 0, corner: 'center' }));
    const rotated = withDecorations(
      deco({ cell: 0, corner: 'center' }, { rotation: 45 }),
    );
    const at = (layout: ExpandedLayout) =>
      centre(rectOfRef(layout, 'decoration-0'));

    expect(Math.abs(at(rotated).x - at(plain).x)).toBeLessThanOrEqual(1);
    expect(Math.abs(at(rotated).y - at(plain).y)).toBeLessThanOrEqual(1);
  });

  it('includes decorations in the bounds and normalises to the origin', () => {
    const layout = withDecorations(
      deco('top-left', { width: 800, height: 800 }),
      deco('bottom-right', { width: 800, height: 800, rotation: 30 }),
    );
    const bounds = layoutBounds(layout);

    expect(bounds).toMatchObject({ x: 0, y: 0 });
    expect(rectOfRef(layout, 'decoration-0')).toMatchObject({ x: 0, y: 0 });
    expect(layout.cells[0].bounds.x).toBeGreaterThan(0);
    // the rotated sticker sets the far corner; the size rounds up
    expect(layout.template.size).toEqual({
      width: Math.ceil(bounds.width),
      height: Math.ceil(bounds.height),
    });
    const sticker = rectOfRef(layout, 'decoration-1');

    expect(sticker.x + sticker.width).toBeCloseTo(bounds.width, 6);
    expect(sticker.y + sticker.height).toBeCloseTo(bounds.height, 6);
  });

  it('keeps whole-pixel positions when rotated art sets the bounds', () => {
    const layout = withDecorations(
      deco('top-left', { width: 333, height: 211, rotation: 17 }),
    );
    const bounds = layoutBounds(layout);

    layout.template.nodes.forEach((node) => {
      expect(Number.isInteger(node.content.position.x)).toBe(true);
      expect(Number.isInteger(node.content.position.y)).toBe(true);
    });
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x).toBeLessThan(1);
    expect(layout.template.size.width).toBeGreaterThanOrEqual(
      bounds.x + bounds.width,
    );
  });
});

describe('expandLayout radial whole pixels', () => {
  it.each([
    [{ width: 1501, height: 333, rotation: 33, offset: { x: 37, y: -11 } }],
    [{ width: 2001, height: 2001, rotation: 45 }],
    [{ width: 999, height: 999, rotation: 17 }],
  ])('keeps 2 cells around wide odd centre art on whole pixels: %o', (art) => {
    const layout = expand(radial(2, { decorations: [deco('center', art)] }));

    layout.cells.forEach((cell) => {
      expect(Number.isInteger(cell.bounds.x)).toBe(true);
      expect(Number.isInteger(cell.bounds.y)).toBe(true);
      cell.freeSlots.forEach((slot) => {
        expect(Number.isInteger(slot.x)).toBe(true);
        expect(Number.isInteger(slot.y)).toBe(true);
      });
    });
    layout.template.nodes
      .filter((node) => node.type !== 'vector')
      .forEach((node) => {
        expect(Number.isInteger(node.content.position.x)).toBe(true);
        expect(Number.isInteger(node.content.position.y)).toBe(true);
      });
  });
});

describe('expandLayout with decorations stays valid and lint-clean', () => {
  const everyAnchor: LayoutDecoration[] = [
    deco('behind', { width: 1200, height: 900 }),
    deco('center', { width: 300, height: 300, rotation: 15 }),
    deco('top-left'),
    deco('top-right', { rotation: -20 }),
    deco('bottom-left', { url: PNG }),
    deco('bottom-right', { offset: { x: -40, y: 40 } }),
    deco({ cell: 0, corner: 'top-left' }),
    deco({ cell: 1, corner: 'top-right' }),
    deco({ cell: 0, corner: 'bottom-left' }),
    deco({ cell: 1, corner: 'bottom-right', rotation: 90 }),
    deco({ cell: 1, corner: 'center' }),
  ];
  const specs: [string, LayoutSpecInput][] = [
    ['columns', { ...retro, decorations: everyAnchor }],
    ['grid', { ...grid, decorations: everyAnchor }],
    ['quadrants', { ...quadrants, decorations: everyAnchor }],
    [
      'radial',
      {
        ...radial(5, { title: 'Starfish', description: 'Five arms' }),
        cells: radial(5).cells.map((cell, i) => ({
          ...cell,
          notes: i === 0 ? ['a', 'b'] : [],
          style: i % 2 ? { frameless: true } : { shape: 'pill' },
        })),
        decorations: everyAnchor,
      },
    ],
    ['starfish example', LAYOUT_EXAMPLES.starfish],
    ['movie example', LAYOUT_EXAMPLES.movieRetro],
  ];

  it.each(specs)('%s', (_, spec) => {
    const layout = expand(spec);

    expect(boardTemplateDataSchema.safeParse(layout.template).success).toBe(
      true,
    );
    expect(lintNodes(asBoardNodes(layout), { isAdmin: true })).toEqual([]);
    layout.template.nodes.forEach((node) => {
      if (node.type === 'panel') {
        expect(node.content).not.toHaveProperty('color');
      }
    });
    // decorations sit below every note
    const types = layout.template.nodes.map((node) => node.type);
    const firstNote = types.indexOf('note');

    if (firstNote >= 0) {
      expect(
        types
          .slice(firstNote)
          .some((type) => type === 'vector' || type === 'image'),
      ).toBe(false);
    }

    expect(expand(spec)).toEqual(layout);
  });

  it('keeps notes inside their radial cells', () => {
    const layout = expand(specs[3][1]);
    const byRef = new Map(layout.template.nodes.map((n) => [n.ref, n]));

    layout.cells.forEach((cell) => {
      cell.noteRefs.forEach((ref) => {
        const note = must(byRef.get(ref), ref);

        expect(
          rectContains(cell.bounds, {
            ...note.content.position,
            width: 300,
            height: 300,
          }),
        ).toBe(true);
      });
    });
  });
});
