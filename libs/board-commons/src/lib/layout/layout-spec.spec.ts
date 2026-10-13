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

  it('takes 2 to 8 radial cells', () => {
    expect(messages({ kind: 'radial', cells: cells(2) })).toEqual([]);
    expect(messages({ kind: 'radial', cells: cells(8) })).toEqual([]);
    expect(messages({ kind: 'radial', cells: cells(1) })).toEqual([
      'radial takes 2 to 8 cells',
    ]);
    expect(messages({ kind: 'radial', cells: cells(9) })).toEqual([
      'radial takes 2 to 8 cells',
    ]);
  });

  it('validates cell styles', () => {
    const styled = (style: unknown) =>
      messages({ kind: 'columns', cells: [{ title: 'A', style }] });

    expect(
      styled({
        shape: 'pill',
        backgroundColor: '#ffffff',
        borderColor: '#000000',
        borderWidth: 4,
        frameless: false,
      }),
    ).toEqual([]);
    expect(styled({ shape: 'circle' })).toHaveLength(1);
    expect(styled({ borderWidth: 21 })).toHaveLength(1);
    expect(styled({ borderWidth: 1.5 })).toHaveLength(1);
    expect(styled({ borderColor: 'red' })).toEqual(['Use a #rrggbb colour']);
  });

  describe('decorations', () => {
    const decorated = (decoration: Record<string, unknown>) =>
      messages({
        kind: 'grid',
        cells: cells(2),
        decorations: [
          {
            url: 'https://cocomaterial.com/media/food_popcorn.svg',
            anchor: 'center',
            width: 200,
            height: 200,
            ...decoration,
          },
        ],
      });

    it('accepts Cocomaterial https urls only', () => {
      expect(decorated({})).toEqual([]);
      expect(
        decorated({ url: 'https://cocomaterial.com/media/photo.png' }),
      ).toEqual([]);

      [
        'http://cocomaterial.com/media/food_popcorn.svg',
        'https://evil.com/food_popcorn.svg',
        'https://cocomaterial.com.evil.com/a.svg',
        'https://cdn.cocomaterial.com/a.svg',
        'https://cocomaterial.com@evil.com/a.svg',
        'https://user:pass@cocomaterial.com/a.svg',
        'https://cocomaterial.com:8443/a.svg',
        'https://evil.com/?u=https://cocomaterial.com/a.svg',
        'javascript:alert(1)//cocomaterial.com/a.svg',
        'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
        'cocomaterial.com/a.svg',
        'not a url',
      ].forEach((url) => {
        expect(decorated({ url })).toEqual([
          'Only https://cocomaterial.com urls',
        ]);
      });
    });

    it('caps the url length', () => {
      const url = `https://cocomaterial.com/${'a'.repeat(1000)}.svg`;

      expect(decorated({ url })).toHaveLength(1);
    });

    it('takes named and cell anchors', () => {
      [
        'center',
        'behind',
        'top-left',
        'top-right',
        'bottom-left',
        'bottom-right',
        { cell: 1, corner: 'center' },
        { cell: 0, corner: 'bottom-right' },
      ].forEach((anchor) => {
        expect(decorated({ anchor })).toEqual([]);
      });
      expect(decorated({ anchor: 'middle' })).toHaveLength(1);
      expect(decorated({ anchor: { cell: 0, corner: 'top' } })).toHaveLength(1);
    });

    it('rejects anchors on missing cells', () => {
      const result = layoutSpecSchema.safeParse({
        kind: 'grid',
        cells: cells(2),
        decorations: [
          {
            url: 'https://cocomaterial.com/media/food_popcorn.svg',
            anchor: { cell: 2, corner: 'top-left' },
            width: 100,
            height: 100,
          },
        ],
      });

      expect(result.error?.issues).toMatchObject([
        { path: ['decorations', 0, 'anchor', 'cell'] },
      ]);
    });

    it('bounds sizes, offsets and the count', () => {
      expect(decorated({ width: 0 })).toHaveLength(1);
      expect(decorated({ height: -10 })).toHaveLength(1);
      expect(decorated({ width: 20_001 })).toHaveLength(1);
      expect(decorated({ offset: { x: 5001, y: 0 } })).toHaveLength(1);
      expect(decorated({ rotation: 400 })).toHaveLength(1);
      expect(
        messages({
          kind: 'grid',
          cells: cells(1),
          decorations: Array(21).fill({
            url: 'https://cocomaterial.com/a.svg',
            anchor: 'top-left',
            width: 10,
            height: 10,
          }),
        }),
      ).toHaveLength(1);
    });
  });
});
