import { z } from 'zod';

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a #rrggbb colour');

const axisLabels = z.tuple([z.string().max(60), z.string().max(60)]);

export const layoutCellSchema = z.object({
  title: z.string().min(1).max(200),
  subtitle: z.string().max(500).optional(),
  // the panel's own background; panel `color` is never set (it recolours notes)
  backgroundColor: hexColor.optional(),
  notes: z.array(z.string().max(2000)).max(30).default([]),
  // note slots in the cell; there is always at least one empty row
  capacity: z.number().int().min(1).max(30).optional(),
});

export const layoutSpecSchema = z
  .object({
    kind: z.enum(['columns', 'grid', 'quadrants']),
    title: z.string().max(200).optional(),
    description: z.string().max(1000).optional(),
    cells: z.array(layoutCellSchema).min(1).max(24),
    gridColumns: z.number().int().min(1).max(6).optional(),
    noteColumns: z.number().int().min(1).max(4).optional(),
    // quadrants only: [low, high] captions along each axis
    axes: z
      .object({ x: axisLabels.optional(), y: axisLabels.optional() })
      .optional(),
    noteColor: hexColor.optional(),
  })
  .superRefine((spec, ctx) => {
    if (spec.kind === 'columns' && spec.cells.length > 12) {
      ctx.addIssue({
        code: 'custom',
        path: ['cells'],
        message: 'columns takes at most 12 cells; use grid for more',
      });
    }

    if (spec.kind === 'quadrants' && spec.cells.length !== 4) {
      ctx.addIssue({
        code: 'custom',
        path: ['cells'],
        message:
          'quadrants takes exactly 4 cells: top-left, top-right, bottom-left, bottom-right',
      });
    }

    if (spec.axes && spec.kind !== 'quadrants') {
      ctx.addIssue({
        code: 'custom',
        path: ['axes'],
        message: 'axes only apply to quadrants',
      });
    }
  });

export type LayoutCell = z.infer<typeof layoutCellSchema>;
export type LayoutSpec = z.infer<typeof layoutSpecSchema>;
export type LayoutSpecInput = z.input<typeof layoutSpecSchema>;
