import type { TuNode } from '../models/node.model.js';
import { expandLayout, type ExpandedLayout } from './expand.js';
import { rectContains } from './geometry.js';
import type { LayoutSpecInput } from './layout-spec.js';
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
