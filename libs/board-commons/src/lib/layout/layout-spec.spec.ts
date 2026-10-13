import { layoutSpecSchema } from './layout-spec.js';

const cells = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ title: `Cell ${i}` }));

const messages = (spec: unknown) => {
  const result = layoutSpecSchema.safeParse(spec);

  return result.success ? [] : result.error.issues.map((it) => it.message);
};

describe('layoutSpecSchema', () => {
  it('fills in an empty note list', () => {
    const spec = layoutSpecSchema.parse({ kind: 'columns', cells: cells(2) });

    expect(spec.cells[0].notes).toEqual([]);
  });

  it('allows at most 12 columns', () => {
    expect(messages({ kind: 'columns', cells: cells(12) })).toEqual([]);
    expect(messages({ kind: 'columns', cells: cells(13) })).toEqual([
      'columns takes at most 12 cells; use grid for more',
    ]);
    expect(messages({ kind: 'grid', cells: cells(13) })).toEqual([]);
  });

  it('needs exactly 4 quadrants', () => {
    expect(messages({ kind: 'quadrants', cells: cells(4) })).toEqual([]);
    expect(messages({ kind: 'quadrants', cells: cells(3) })).toHaveLength(1);
  });

  it('only takes axes for quadrants', () => {
    const axes = { x: ['Low effort', 'High effort'] };

    expect(messages({ kind: 'quadrants', cells: cells(4), axes })).toEqual([]);
    expect(messages({ kind: 'grid', cells: cells(4), axes })).toEqual([
      'axes only apply to quadrants',
    ]);
  });

  it('rejects colours that are not #rrggbb', () => {
    expect(
      messages({ kind: 'columns', cells: cells(1), noteColor: 'red' }),
    ).toEqual(['Use a #rrggbb colour']);
    expect(
      messages({
        kind: 'columns',
        cells: [{ title: 'A', backgroundColor: '#abc' }],
      }),
    ).toEqual(['Use a #rrggbb colour']);
  });

  it('bounds the input', () => {
    expect(messages({ kind: 'grid', cells: [] })).toHaveLength(1);
    expect(messages({ kind: 'grid', cells: cells(25) })).toHaveLength(1);
    expect(messages({ kind: 'columns', cells: [{ title: '' }] })).toHaveLength(
      1,
    );
    expect(
      messages({ kind: 'columns', cells: cells(1), noteColumns: 5 }),
    ).toHaveLength(1);
    expect(
      messages({
        kind: 'columns',
        cells: [{ title: 'A', notes: Array(31).fill('x') }],
      }),
    ).toHaveLength(1);
  });
});
