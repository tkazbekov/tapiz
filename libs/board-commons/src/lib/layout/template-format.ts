import { z } from 'zod';

import type { Point } from '../models/point.model.js';
import { newArrow } from '../validators/arrow.validator.js';
import { LayerValidator } from '../validators/common-board-validation.js';
import { newGroup } from '../validators/group.validator.js';
import { newImage } from '../validators/image.validator.js';
import { newNote } from '../validators/note.validator.js';
import { newPanel } from '../validators/panel.validator.js';
import { newText } from '../validators/text.validator.js';
import { newVector } from '../validators/vector.validator.js';

export const TEMPLATE_NODE_TYPES = [
  'panel',
  'text',
  'note',
  'group',
  'arrow',
  'vector',
  'image',
] as const;

export type TemplateNodeType = (typeof TEMPLATE_NODE_TYPES)[number];

export const TEMPLATE_LIMITS = {
  maxNodes: 500,
  maxBytes: 512_000,
  maxCoord: 100_000,
  maxNodeSize: 20_000,
  maxTextChars: 20_000,
} as const;

export const TEMPLATE_REF_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

// refs key plain objects in callers
const RESERVED_REFS = new Set(['__proto__', 'constructor', 'prototype']);

export const isTemplateRef = (ref: string) =>
  TEMPLATE_REF_PATTERN.test(ref ?? '') && !RESERVED_REFS.has(ref);

// uploads are stored as bare file names scoped to their board
export const PORTABLE_URL_PATTERN = /^https?:\/\//i;

export interface BoardTemplateNode {
  ref: string;
  type: TemplateNodeType;
  content: Record<string, unknown> & { position: Point; layer: 0 | 1 };
}

/**
 * Coordinates are relative to the top-left of the template's bounding box
 * and the array order is the z-order.
 */
export interface BoardTemplateData {
  version: 1;
  size: { width: number; height: number };
  nodes: BoardTemplateNode[];
}

export interface TemplateIssue {
  path: (string | number)[];
  message: string;
}

export type ParseBoardTemplateResult =
  | { ok: true; data: BoardTemplateData }
  | { ok: false; issues: TemplateIssue[] };

const text = z.string().max(TEMPLATE_LIMITS.maxTextChars);
const portableUrl = (max: number) =>
  z
    .string()
    .max(max)
    .regex(PORTABLE_URL_PATTERN, 'Only http(s) urls work on another board');

interface LimitedContent {
  position: Point;
  width?: number;
  height?: number;
  start?: Point;
  end?: Point;
  drawing?: { points: Point[] }[];
  emojis?: { position: Point }[];
}

const contentLimits = (content: LimitedContent, ctx: z.RefinementCtx) => {
  const points: [Point, (string | number)[]][] = [
    [content.position, ['position']],
    ...(['start', 'end'] as const).flatMap((key): [Point, string[]][] =>
      content[key] ? [[content[key], [key]]] : [],
    ),
    ...(content.drawing ?? []).flatMap((line, index) =>
      line.points.map((point, pointIndex): [Point, (string | number)[]] => [
        point,
        ['drawing', index, 'points', pointIndex],
      ]),
    ),
    ...(content.emojis ?? []).map(
      (emoji, index): [Point, (string | number)[]] => [
        emoji.position,
        ['emojis', index, 'position'],
      ],
    ),
  ];

  points.forEach(([point, path]) => {
    (['x', 'y'] as const).forEach((axis) => {
      if (Math.abs(point[axis]) > TEMPLATE_LIMITS.maxCoord) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, axis],
          message: `Coordinates must be within ±${TEMPLATE_LIMITS.maxCoord}`,
        });
      }
    });
  });

  (['width', 'height'] as const).forEach((key) => {
    const value = content[key];

    if (value !== undefined && Math.abs(value) > TEMPLATE_LIMITS.maxNodeSize) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `Node size must be at most ${TEMPLATE_LIMITS.maxNodeSize}`,
      });
    }
  });
};

// the real node validators, with a required layer
const contentSchemas = {
  panel: newPanel.extend({ layer: LayerValidator, text: text.optional() }),
  text: newText.extend({ layer: LayerValidator, text }),
  note: newNote.extend({ layer: LayerValidator, text }),
  group: newGroup.extend({ layer: LayerValidator }),
  arrow: newArrow.extend({ layer: LayerValidator }),
  vector: newVector.extend({ layer: LayerValidator, url: portableUrl(1000) }),
  image: newImage.extend({ layer: LayerValidator, url: portableUrl(2000) }),
};

const templateNode = <T extends TemplateNodeType>(type: T) =>
  z.object({
    ref: z
      .string()
      .regex(TEMPLATE_REF_PATTERN)
      .refine((ref) => !RESERVED_REFS.has(ref), 'Reserved ref'),
    type: z.literal(type),
    content: contentSchemas[type].superRefine(contentLimits),
  });

const templateNodeSchema = z.discriminatedUnion('type', [
  templateNode('panel'),
  templateNode('text'),
  templateNode('note'),
  templateNode('group'),
  templateNode('arrow'),
  templateNode('vector'),
  templateNode('image'),
]);

const ATTACHMENT_KEYS = ['startAttachment', 'endAttachment'] as const;

export const boardTemplateDataSchema = z
  .object({
    version: z.literal(1),
    size: z.object({
      width: z.number().nonnegative().max(TEMPLATE_LIMITS.maxCoord),
      height: z.number().nonnegative().max(TEMPLATE_LIMITS.maxCoord),
    }),
    nodes: z.array(templateNodeSchema).min(1).max(TEMPLATE_LIMITS.maxNodes),
  })
  .superRefine((data, ctx) => {
    const refs = new Set<string>();

    data.nodes.forEach((node, index) => {
      if (refs.has(node.ref)) {
        ctx.addIssue({
          code: 'custom',
          path: ['nodes', index, 'ref'],
          message: `Duplicate ref "${node.ref}"`,
        });
      }

      refs.add(node.ref);
    });

    data.nodes.forEach((node, index) => {
      if (node.type !== 'arrow') {
        return;
      }

      const content = node.content as Partial<
        Record<(typeof ATTACHMENT_KEYS)[number], { nodeId: string }>
      >;

      ATTACHMENT_KEYS.forEach((key) => {
        const attachment = content[key];

        if (attachment && !refs.has(attachment.nodeId)) {
          ctx.addIssue({
            code: 'custom',
            path: ['nodes', index, 'content', key, 'nodeId'],
            message: `Attachment "${attachment.nodeId}" is not a ref in this template`,
          });
        }
      });
    });

    const bytes = new TextEncoder().encode(JSON.stringify(data)).length;

    if (bytes > TEMPLATE_LIMITS.maxBytes) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: `Template is ${bytes} bytes, the limit is ${TEMPLATE_LIMITS.maxBytes}`,
      });
    }
  });

export function parseBoardTemplate(raw: unknown): ParseBoardTemplateResult {
  const version =
    raw && typeof raw === 'object'
      ? (raw as { version?: unknown }).version
      : undefined;

  // future versions are upgraded in memory here
  if (version !== 1) {
    return {
      ok: false,
      issues: [{ path: ['version'], message: 'unsupported_template_version' }],
    };
  }

  const result = boardTemplateDataSchema.safeParse(raw);

  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.filter(
          (p): p is string | number => typeof p !== 'symbol',
        ),
        message: issue.message,
      })),
    };
  }

  return { ok: true, data: result.data as BoardTemplateData };
}
