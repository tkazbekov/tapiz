import type { TuNode } from '../models/node.model.js';
import type { Point } from '../models/point.model.js';
import { nodeBounds, nodesById, resolveArrowGeometry } from './geometry.js';

export const TEMPLATE_PREVIEW_MAX_RECTS = 200;

/**
 * One shape of a template preview, in template coordinates. For an arrow,
 * (x, y) is its start and (x + width, y + height) its end, so width and
 * height can be negative. `fill` is a note's own colour, when it has one.
 */
export interface TemplatePreviewRect {
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fill?: string;
}

const round = (value: number) => Math.round(value);

function previewRect(
  node: TuNode,
  byId: ReturnType<typeof nodesById>,
): TemplatePreviewRect | null {
  const rect = nodeBounds(node, byId);

  if (!rect) {
    return null;
  }

  let shape: TemplatePreviewRect = { type: node.type, ...rect };

  if (node.type === 'arrow') {
    // attached ends follow their nodes, the stored points may be stale
    const geometry = resolveArrowGeometry(node, byId);
    const content = node.content as { start?: Point; end?: Point };
    const start = geometry?.start ?? content.start ?? { x: 0, y: 0 };
    const end = geometry?.end ??
      content.end ?? { x: rect.width, y: rect.height };

    shape = {
      type: 'arrow',
      x: rect.x + start.x,
      y: rect.y + start.y,
      width: end.x - start.x,
      height: end.y - start.y,
    };
  }

  if (node.type === 'note') {
    const color = (node.content as { color?: unknown }).color;

    if (typeof color === 'string' && color) {
      shape.fill = color;
    }
  }

  const numbers = [shape.x, shape.y, shape.width, shape.height];

  if (!numbers.every(Number.isFinite)) {
    return null;
  }

  return {
    ...shape,
    x: round(shape.x),
    y: round(shape.y),
    width: round(shape.width),
    height: round(shape.height),
  };
}

/**
 * A compact outline of template data for thumbnails: one rect per drawn
 * node, in board order. Over `max` shapes, the largest ones are kept. Raw
 * stored data is accepted, so garbage gives null rather than a throw.
 */
export function templatePreview(
  data: unknown,
  max = TEMPLATE_PREVIEW_MAX_RECTS,
): TemplatePreviewRect[] | null {
  const { version, nodes: raw } =
    (data as { version?: unknown; nodes?: unknown } | null) ?? {};

  // future versions would be upgraded before reading them
  if (version !== 1 || !Array.isArray(raw)) {
    return null;
  }

  try {
    const nodes: TuNode[] = raw
      .filter(
        (node): node is { ref: string; type: string; content: object } =>
          !!node &&
          typeof node === 'object' &&
          typeof node.type === 'string' &&
          !!node.content &&
          typeof node.content === 'object',
      )
      .map((node) => ({
        id: String(node.ref),
        type: node.type,
        content: node.content,
      }));
    const byId = nodesById(nodes);
    const rects = nodes
      .map((node) => previewRect(node, byId))
      .filter((rect) => !!rect);

    if (rects.length <= max) {
      return rects;
    }

    const kept = new Set(
      rects
        .map((rect, index) => ({
          index,
          area: Math.abs(rect.width * rect.height),
        }))
        .sort((a, b) => b.area - a.area || a.index - b.index)
        .slice(0, max)
        .map((it) => it.index),
    );

    return rects.filter((_, index) => kept.has(index));
  } catch {
    return null;
  }
}
