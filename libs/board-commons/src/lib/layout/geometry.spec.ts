import type { TuNode } from '../models/node.model.js';
import {
  boundsOfNodes,
  intersectionArea,
  nodeBounds,
  nodesById,
  nodeSize,
  rectContains,
  resolveArrowGeometry,
  rectsIntersect,
  resolveOrigin,
  viewportCenter,
} from './geometry.js';

const node = (
  type: string,
  content: Record<string, unknown>,
  id = type,
): TuNode => ({ id, type, content });

describe('geometry', () => {
  it('sizes nodes like the web app', () => {
    expect(nodeSize(node('note', { width: 300, height: 200 }))).toEqual({
      width: 300,
      height: 200,
    });
    expect(nodeSize(node('poll', {}))).toEqual({ width: 650, height: 650 });
    expect(nodeSize(node('token', { width: 0 }))).toEqual({
      width: 100,
      height: 100,
    });
    expect(nodeSize(node('image', { width: 80 }))).toEqual({
      width: 80,
      height: 80,
    });
  });

  it('bounds an unrotated node at its position', () => {
    expect(
      nodeBounds(
        node('note', { position: { x: 10, y: 20 }, width: 300, height: 300 }),
      ),
    ).toEqual({ x: 10, y: 20, width: 300, height: 300 });
  });

  it('bounds a rotated node around its top-left corner', () => {
    const bounds = nodeBounds(
      node('text', {
        position: { x: 0, y: 0 },
        width: 100,
        height: 50,
        rotation: 90,
      }),
    );

    expect(bounds?.x).toBeCloseTo(-50);
    expect(bounds?.y).toBeCloseTo(0);
    expect(bounds?.width).toBeCloseTo(50);
    expect(bounds?.height).toBeCloseTo(100);
  });

  it('has no bounds for runtime nodes or nodes without a position', () => {
    expect(nodeBounds(node('user', { position: { x: 1, y: 1 } }))).toBeNull();
    expect(nodeBounds(node('settings', {}))).toBeNull();
    expect(nodeBounds(node('timer', {}))).toBeNull();
    expect(nodeBounds(node('note', { width: 10 }))).toBeNull();
  });

  it('unions the bounds of board nodes', () => {
    expect(
      boundsOfNodes([
        node('user', { position: { x: -5000, y: -5000 } }),
        node('note', { position: { x: 0, y: 0 }, width: 100, height: 100 }),
        node('panel', { position: { x: 200, y: 50 }, width: 100, height: 300 }),
      ]),
    ).toEqual({ x: 0, y: 0, width: 300, height: 350 });
    expect(boundsOfNodes([])).toBeNull();
  });

  describe('attached arrows', () => {
    const target = (id: string, x: number, rotation = 0) =>
      node(
        'note',
        { position: { x, y: 0 }, width: 100, height: 100, rotation },
        id,
      );
    const arrow = node(
      'arrow',
      {
        position: { x: -3000, y: -3000 },
        width: 120,
        height: 20,
        start: { x: 10, y: 10 },
        end: { x: 110, y: 10 },
        startAttachment: { nodeId: 'a', offset: { x: 100, y: 50 } },
        endAttachment: { nodeId: 'b', offset: { x: -40, y: 50 } },
      },
      'link',
    );

    it('bounds them between the nodes they are attached to', () => {
      // stored geometry is stale; offsets clamp to the node
      expect(boundsOfNodes([target('a', 0), target('b', 400), arrow])).toEqual({
        x: 0,
        y: 0,
        width: 500,
        height: 100,
      });
      expect(
        nodeBounds(arrow, nodesById([target('a', 0), target('b', 400)])),
      ).toEqual({ x: 90, y: 40, width: 320, height: 20 });
      expect(resolveArrowGeometry(arrow, nodesById([target('a', 0)]))).toEqual({
        position: { x: -2900, y: -3000 },
        width: 3010,
        height: 3060,
        start: { x: 3000, y: 3050 },
        end: { x: 10, y: 10 },
      });
    });

    it('rotates attachment offsets with the node', () => {
      const geometry = resolveArrowGeometry(
        arrow,
        nodesById([target('a', 0, 90)]),
      );
      const start = geometry && {
        x: geometry.position.x + geometry.start.x,
        y: geometry.position.y + geometry.start.y,
      };

      // (100, 50) rotated 90deg about the top-left is (-50, 100)
      expect(start?.x).toBeCloseTo(-50);
      expect(start?.y).toBeCloseTo(100);
    });

    it('keeps the stored geometry without the attached nodes', () => {
      expect(nodeBounds(arrow)).toEqual({
        x: -3000,
        y: -3000,
        width: 120,
        height: 20,
      });
      expect(resolveArrowGeometry(arrow, nodesById([]))).toBeNull();
    });
  });

  it('intersects, contains and measures overlap', () => {
    const a = { x: 0, y: 0, width: 100, height: 100 };

    expect(rectsIntersect(a, { x: 50, y: 50, width: 100, height: 100 })).toBe(
      true,
    );
    expect(rectsIntersect(a, { x: 100, y: 0, width: 10, height: 10 })).toBe(
      false,
    );
    expect(rectContains(a, { x: 10, y: 10, width: 90, height: 90 })).toBe(true);
    expect(rectContains(a, { x: 10, y: 10, width: 91, height: 90 })).toBe(
      false,
    );
    expect(intersectionArea(a, { x: 50, y: 50, width: 100, height: 100 })).toBe(
      2500,
    );
    expect(intersectionArea(a, { x: 200, y: 0, width: 10, height: 10 })).toBe(
      0,
    );
  });

  it('finds the board point at the viewport centre', () => {
    expect(
      viewportCenter({ x: -100, y: 50 }, 2, { width: 800, height: 600 }),
    ).toEqual({ x: 250, y: 125 });
  });

  describe('resolveOrigin', () => {
    const board = [
      node('settings', {}),
      node('user', { position: { x: 9000, y: 9000 } }),
      node('note', { position: { x: 100, y: 200 }, width: 300, height: 300 }),
      node(
        'panel',
        { position: { x: 0, y: 0 }, width: 200, height: 1000 },
        'p',
      ),
    ];

    it('starts an empty board at the origin', () => {
      expect(resolveOrigin([node('settings', {})], 'right')).toEqual({
        x: 0,
        y: 0,
      });
    });

    it('places content right of the existing content', () => {
      expect(resolveOrigin(board, 'right')).toEqual({ x: 800, y: 0 });
    });

    it('places content below the existing content', () => {
      expect(resolveOrigin(board, 'below', 100)).toEqual({ x: 0, y: 1100 });
    });
  });
});
