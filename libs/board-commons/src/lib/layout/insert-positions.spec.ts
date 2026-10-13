import type { NodeAdd, TuNode } from '../models/node.model.js';
import {
  assignInsertPositions,
  defaultInsertIndex,
} from './insert-positions.js';

// copy of the add rule in libs/sync-node-box/src/lib/apply-action.ts
function applyAdd(nodes: TuNode[], action: NodeAdd): TuNode[] {
  if (nodes.some((it) => it.id === action.data.id)) {
    return nodes;
  }

  nodes = [...nodes];

  if (
    action.position !== undefined &&
    action.position < nodes.length &&
    action.position >= 0
  ) {
    nodes.splice(action.position, 0, action.data);
  } else {
    nodes.push(action.data);
  }

  return nodes;
}

const node = (id: string, type: string): TuNode => ({ id, type, content: {} });
const add = (id: string, type: string): NodeAdd => ({
  op: 'add',
  data: node(id, type),
});
const ids = (nodes: TuNode[]) => nodes.map((it) => it.id);
const apply = (board: TuNode[], adds: NodeAdd[]) =>
  assignInsertPositions(board, adds).reduce(applyAdd, board);

describe('insert positions', () => {
  it('follows the web rules', () => {
    const board = [
      node('user', 'user'),
      node('panel', 'panel'),
      node('group', 'group'),
      node('note', 'note'),
    ];

    expect(defaultInsertIndex(board, 'panel')).toBe(2);
    expect(defaultInsertIndex(board, 'group')).toBe(3);
    expect(defaultInsertIndex(board, 'note')).toBeUndefined();
    expect(defaultInsertIndex([node('note', 'note')], 'panel')).toBe(0);
    expect(defaultInsertIndex([node('note', 'note')], 'group')).toBe(0);
  });

  it('keeps template panels in order behind existing notes', () => {
    const board = [
      node('user', 'user'),
      node('panelA', 'panel'),
      node('note1', 'note'),
    ];
    const adds = [
      add('p1', 'panel'),
      add('p2', 'panel'),
      add('p3', 'panel'),
      add('n1', 'note'),
    ];

    expect(assignInsertPositions(board, adds).map((it) => it.position)).toEqual(
      [2, 3, 4, undefined],
    );
    expect(ids(apply(board, adds))).toEqual([
      'user',
      'panelA',
      'p1',
      'p2',
      'p3',
      'note1',
      'n1',
    ]);
  });

  it('puts groups after panels and keeps their order', () => {
    const board = [node('note1', 'note')];
    const adds = [
      add('g1', 'group'),
      add('p1', 'panel'),
      add('g2', 'group'),
      add('n1', 'note'),
    ];

    expect(ids(apply(board, adds))).toEqual(['p1', 'g1', 'g2', 'note1', 'n1']);
  });

  it('works on an empty board', () => {
    const adds = [add('p1', 'panel'), add('p2', 'panel'), add('t', 'text')];

    expect(ids(apply([], adds))).toEqual(['p1', 'p2', 't']);
  });

  it('keeps explicit positions and skips ids already on the board', () => {
    const board = [node('a', 'note'), node('b', 'note')];
    const adds = [
      { ...add('x', 'note'), position: 0 },
      add('a', 'panel'),
      add('p', 'panel'),
    ];
    const result = assignInsertPositions(board, adds);

    expect(result.map((it) => it.position)).toEqual([0, 0, 0]);
    expect(ids(result.reduce(applyAdd, board))).toEqual(['p', 'x', 'a', 'b']);
  });

  it('does not change its inputs', () => {
    const board = [node('a', 'note')];
    const adds = [add('p', 'panel')];

    assignInsertPositions(board, adds);

    expect(ids(board)).toEqual(['a']);
    expect(adds[0].position).toBeUndefined();
  });
});
