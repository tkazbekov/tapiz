import { z } from 'zod';

import { TEMPLATE_LIMITS } from './template-format.js';

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a #rrggbb colour');

const axisLabels = z.tuple([z.string().max(60), z.string().max(60)]);

export const LAYOUT_KINDS = ['columns', 'grid', 'quadrants', 'radial'] as const;

export const RADIAL_CELLS = { min: 2, max: 8 } as const;

export const MAX_LAYOUT_DECORATIONS = 20;

const COCOMATERIAL_HOST = 'cocomaterial.com';
// the template format caps vector urls at 1000 characters
const DECORATION_URL_MAX = 1000;
const MAX_OFFSET = 5000;

/**
 * Decorations only load art from Cocomaterial over https, so a layout can't
 * point the board (or a server-side preview) at an arbitrary host.
 */
export function isCocomaterialUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return (
      url.protocol === 'https:' &&
      url.hostname === COCOMATERIAL_HOST &&
      !url.port &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function isSvgUrl(value: string): boolean {
  try {
    return new URL(value).pathname.toLowerCase().endsWith('.svg');
  } catch {
    return false;
  }
}

export const layoutCellStyleSchema = z
  .object({
    shape: z
      .enum(['rect', 'rounded', 'pill'])
      .optional()
      .describe(
        'Corners: rect (square), rounded (24px) or pill (half the shorter side, at most 150px); default 12px',
      ),
    backgroundColor: hexColor.optional(),
    borderColor: hexColor.optional(),
    borderWidth: z.number().int().min(0).max(20).optional(),
    frameless: z
      .boolean()
      .optional()
      .describe(
        'A transparent zone without a border, e.g. a lane over decoration art; overrides backgroundColor and borderWidth',
      ),
  })
  .describe("The cell panel's look; panel color is never set");

export const layoutCellSchema = z.object({
  title: z.string().min(1).max(200),
  subtitle: z.string().max(500).optional(),
  // the panel's own background; panel `color` is never set (it recolours notes)
  backgroundColor: hexColor.optional(),
  style: layoutCellStyleSchema.optional(),
  notes: z.array(z.string().max(2000)).max(30).default([]),
  // note slots in the cell; there is always at least one empty row
  capacity: z.number().int().min(1).max(30).optional(),
});

export const DECORATION_CORNERS = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
] as const;

const decorationSize = z.number().positive().max(TEMPLATE_LIMITS.maxNodeSize);
const offsetAxis = z.number().min(-MAX_OFFSET).max(MAX_OFFSET);

export const layoutDecorationSchema = z.object({
  url: z
    .string()
    .max(DECORATION_URL_MAX)
    .refine(isCocomaterialUrl, 'Only https://cocomaterial.com urls')
    .describe(
      'Cocomaterial art (https://cocomaterial.com/...); .svg urls become vector nodes, anything else an image node',
    ),
  anchor: z
    .union([
      z.enum(['center', 'behind', ...DECORATION_CORNERS]),
      z.object({
        cell: z.number().int().min(0),
        corner: z.enum([...DECORATION_CORNERS, 'center']),
      }),
    ])
    .describe(
      'center: the middle of the cells (radial: the ring centre, and the ring grows to fit it); behind: the middle of the cells, below every panel; a corner: a sticker on that corner of the whole layout, title included; { cell, corner }: a sticker on a corner (or the centre) of one cell, cells numbered from 0',
    ),
  width: decorationSize,
  height: decorationSize,
  rotation: z.number().min(-360).max(360).optional(),
  // moves the decoration from its anchor, in board pixels
  offset: z.object({ x: offsetAxis, y: offsetAxis }).optional(),
});

export const layoutSpecSchema = z
  .object({
    kind: z.enum(LAYOUT_KINDS),
    title: z.string().max(200).optional(),
    description: z.string().max(1000).optional(),
    cells: z.array(layoutCellSchema).min(1).max(24),
    gridColumns: z.number().int().min(1).max(6).optional(),
    noteColumns: z.number().int().min(1).max(4).optional(),
    // quadrants only: captions in reading order, x [left, right], y [top, bottom]
    axes: z
      .object({ x: axisLabels.optional(), y: axisLabels.optional() })
      .optional(),
    noteColor: hexColor.optional(),
    decorations: z
      .array(layoutDecorationSchema)
      .max(MAX_LAYOUT_DECORATIONS)
      .optional(),
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

    if (
      spec.kind === 'radial' &&
      (spec.cells.length < RADIAL_CELLS.min ||
        spec.cells.length > RADIAL_CELLS.max)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['cells'],
        message: `radial takes ${RADIAL_CELLS.min} to ${RADIAL_CELLS.max} cells`,
      });
    }

    if (spec.axes && spec.kind !== 'quadrants') {
      ctx.addIssue({
        code: 'custom',
        path: ['axes'],
        message: 'axes only apply to quadrants',
      });
    }

    spec.decorations?.forEach(({ anchor }, index) => {
      if (typeof anchor === 'object' && anchor.cell >= spec.cells.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['decorations', index, 'anchor', 'cell'],
          message: `There is no cell ${anchor.cell}; cells are numbered from 0 to ${spec.cells.length - 1}`,
        });
      }
    });
  });

export type LayoutCell = z.infer<typeof layoutCellSchema>;
export type LayoutCellStyle = z.infer<typeof layoutCellStyleSchema>;
export type LayoutDecoration = z.infer<typeof layoutDecorationSchema>;
export type LayoutSpec = z.infer<typeof layoutSpecSchema>;
export type LayoutSpecInput = z.input<typeof layoutSpecSchema>;
