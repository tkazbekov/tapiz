import type { TuNode } from '../models/node.model.js';
import type { Point } from '../models/point.model.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Placement = 'right' | 'below';

// runtime nodes that are not drawn on the board
export const RUNTIME_NODE_TYPES: ReadonlySet<string> = new Set([
  'user',
  'settings',
  'timer',
]);

const DEFAULT_WIDTHS: Record<string, number> = {
  poll: 650,
  estimation: 650,
  token: 100,
};

type SizedContent = {
  position?: Point;
  width?: number;
  height?: number;
  rotation?: number;
};

const contentOf = (node: TuNode) => (node.content ?? {}) as SizedContent;

// port of apps/web/src/app/shared/node-size.ts
export function nodeSize(node: TuNode): { width: number; height: number } {
  const content = contentOf(node);
  const width = content.width || DEFAULT_WIDTHS[node.type] || 0;
  const height = content.height || width;

  return { width, height };
}

const isPoint = (value: unknown): value is Point =>
  !!value &&
  typeof value === 'object' &&
  Number.isFinite((value as Point).x) &&
  Number.isFinite((value as Point).y);

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

// rotation in degrees, clockwise on screen (y points down)
export function rotatePoint(point: Point, rotation: number): Point {
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos,
  };
}

export type NodesById = ReadonlyMap<string, TuNode>;

export const nodesById = (nodes: TuNode[]): NodesById =>
  new Map(nodes.map((node) => [node.id, node]));

const ARROW_PADDING = 10;

interface ArrowContent {
  position?: Point;
  start?: Point;
  end?: Point;
  startAttachment?: { nodeId: string; offset: Point };
  endAttachment?: { nodeId: string; offset: Point };
}

export interface ArrowGeometry {
  position: Point;
  width: number;
  height: number;
  start: Point;
  end: Point;
}

// resolveAttachment in the web arrow-utils.ts
function attachedPoint(
  attachment: ArrowContent['startAttachment'],
  byId: NodesById,
): Point | null {
  const node = attachment && byId.get(attachment.nodeId);

  if (!node || !isPoint(attachment.offset)) {
    return null;
  }

  const { position, rotation } = contentOf(node);

  if (!isPoint(position)) {
    return null;
  }

  const { width, height } = nodeSize(node);
  const offset = rotatePoint(
    {
      x: clamp(attachment.offset.x, 0, width),
      y: clamp(attachment.offset.y, 0, height),
    },
    rotation ?? 0,
  );

  return { x: position.x + offset.x, y: position.y + offset.y };
}

/**
 * Where an attached arrow renders: the web app draws attached ends at their
 * node and ignores the stored geometry. Null when no end resolves.
 */
export function resolveArrowGeometry(
  arrow: TuNode,
  byId: NodesById,
): ArrowGeometry | null {
  const content = (arrow.content ?? {}) as ArrowContent;
  const start = attachedPoint(content.startAttachment, byId);
  const end = attachedPoint(content.endAttachment, byId);
  const { position } = content;

  if (arrow.type !== 'arrow' || (!start && !end) || !isPoint(position)) {
    return null;
  }

  const stored = (point: Point | undefined) =>
    isPoint(point)
      ? { x: position.x + point.x, y: position.y + point.y }
      : position;
  const a = start ?? stored(content.start);
  const b = end ?? stored(content.end);
  const x = Math.min(a.x, b.x) - ARROW_PADDING;
  const y = Math.min(a.y, b.y) - ARROW_PADDING;

  return {
    position: { x, y },
    width: Math.max(1, Math.max(a.x, b.x) + ARROW_PADDING - x),
    height: Math.max(1, Math.max(a.y, b.y) + ARROW_PADDING - y),
    start: { x: a.x - x, y: a.y - y },
    end: { x: b.x - x, y: b.y - y },
  };
}

/**
 * Nodes rotate (in degrees) around their top-left corner. Pass the other
 * nodes so attached arrows are bounded where they render.
 */
export function nodeBounds(node: TuNode, byId?: NodesById): Rect | null {
  const { position, rotation } = contentOf(node);

  if (RUNTIME_NODE_TYPES.has(node.type) || !isPoint(position)) {
    return null;
  }

  const arrow = byId && resolveArrowGeometry(node, byId);

  if (arrow) {
    return { ...arrow.position, width: arrow.width, height: arrow.height };
  }

  const { width, height } = nodeSize(node);

  if (!rotation) {
    return { x: position.x, y: position.y, width, height };
  }

  const corners = [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ].map(([x, y]) => {
    const offset = rotatePoint({ x, y }, rotation);

    return { x: position.x + offset.x, y: position.y + offset.y };
  });
  const xs = corners.map((it) => it.x);
  const ys = corners.map((it) => it.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);

  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function unionRects(rects: Rect[]): Rect | null {
  if (!rects.length) {
    return null;
  }

  const x = Math.min(...rects.map((it) => it.x));
  const y = Math.min(...rects.map((it) => it.y));
  const right = Math.max(...rects.map((it) => it.x + it.width));
  const bottom = Math.max(...rects.map((it) => it.y + it.height));

  return { x, y, width: right - x, height: bottom - y };
}

export function boundsOfNodes(nodes: TuNode[]): Rect | null {
  const byId = nodesById(nodes);

  return unionRects(
    nodes
      .map((node) => nodeBounds(node, byId))
      .filter((it): it is Rect => it !== null),
  );
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

export function intersectionArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);

  return width > 0 && height > 0 ? width * height : 0;
}

// board point at the centre of the visible area
export function viewportCenter(
  position: Point,
  zoom: number,
  viewport: { width: number; height: number },
): Point {
  return {
    x: (-position.x + viewport.width / 2) / zoom,
    y: (-position.y + viewport.height / 2) / zoom,
  };
}

// where new content goes so it doesn't cover what's already on the board
export function resolveOrigin(
  existing: TuNode[],
  placement: Placement,
  gap = 400,
): Point {
  const bounds = boundsOfNodes(existing);

  if (!bounds) {
    return { x: 0, y: 0 };
  }

  if (placement === 'right') {
    return { x: bounds.x + bounds.width + gap, y: bounds.y };
  }

  return { x: bounds.x, y: bounds.y + bounds.height + gap };
}
