import { TEMPLATE_PREVIEW_MAX_RECTS, templatePreview } from './preview.js';

const node = (
  ref: string,
  type: string,
  x: number,
  y: number,
  size: number,
  extra: Record<string, unknown> = {},
) => ({
  ref,
  type,
  content: {
    position: { x, y },
    width: size,
    height: size,
    layer: 0,
    ...extra,
  },
});

describe('templatePreview', () => {
  it('outlines each node in template coordinates, in order', () => {
    const preview = templatePreview({
      version: 1,
      size: { width: 1000, height: 1000 },
      nodes: [
        node('panel', 'panel', 0, 0, 1000),
        node('a', 'note', 100.4, 200.6, 300, { color: '#fdab61' }),
        node('b', 'note', 500, 200, 300, { color: '' }),
        {
          ref: 'arrow',
          type: 'arrow',
          content: {
            position: { x: 0, y: 0 },
            width: 10,
            height: 10,
            layer: 0,
            start: { x: 0, y: 0 },
            end: { x: 10, y: 10 },
            startAttachment: { nodeId: 'b', offset: { x: 0, y: 0 } },
            endAttachment: { nodeId: 'a', offset: { x: 300, y: 300 } },
          },
        },
      ],
    });

    expect(preview).toEqual([
      { type: 'panel', x: 0, y: 0, width: 1000, height: 1000 },
      {
        type: 'note',
        x: 100,
        y: 201,
        width: 300,
        height: 300,
        fill: '#fdab61',
      },
      { type: 'note', x: 500, y: 200, width: 300, height: 300 },
      // from b's top-left to a's bottom-right
      { type: 'arrow', x: 500, y: 200, width: -100, height: 301 },
    ]);
  });

  it('keeps the largest shapes over the cap, in order', () => {
    const nodes = [
      ...Array.from({ length: TEMPLATE_PREVIEW_MAX_RECTS + 50 }, (_, i) =>
        node(`small-${i}`, 'note', i * 10, 0, 5),
      ),
      node('big', 'panel', 0, 0, 5000),
    ];
    const preview = templatePreview({ version: 1, nodes });

    expect(preview).toHaveLength(TEMPLATE_PREVIEW_MAX_RECTS);
    expect(preview?.at(-1)).toMatchObject({ type: 'panel', width: 5000 });
  });

  it('returns null for unreadable data and skips broken nodes', () => {
    expect(templatePreview(null)).toBeNull();
    expect(templatePreview({ version: 1, nodes: 'x' })).toBeNull();
    expect(templatePreview({ version: 2, nodes: [] })).toBeNull();
    expect(
      templatePreview({
        version: 1,
        nodes: [null, { ref: 'x', type: 'note' }, node('ok', 'text', 0, 0, 10)],
      }),
    ).toEqual([{ type: 'text', x: 0, y: 0, width: 10, height: 10 }]);
  });
});
