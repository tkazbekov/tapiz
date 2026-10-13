import type { NodeAdd, TuNode } from '../models/node.model.js';

/**
 * Same rules as the web (nodes-actions.ts getPositionCandidate): panels go
 * after the last panel, groups after the last panel or group, and anything
 * else is pushed on top (undefined).
 */
export function defaultInsertIndex(
  nodes: Pick<TuNode, 'type'>[],
  type: string,
): number | undefined {
  if (type === 'panel') {
    return nodes.findLastIndex((it) => it.type === 'panel') + 1;
  }

  if (type === 'group') {
    return (
      nodes.findLastIndex((it) => it.type === 'panel' || it.type === 'group') +
      1
    );
  }

  return undefined;
}

/**
 * Gives each add the index it lands at when the adds are applied in order,
 * so the adds keep their relative order (the web inserts every panel at the
 * same index, which reverses them). Adds without a rule that come before the
 * first panel (a layout's 'behind' art) go with the panels, below them,
 * instead of on top of the board.
 */
export function assignInsertPositions(
  board: Pick<TuNode, 'id' | 'type'>[],
  adds: NodeAdd[],
): NodeAdd[] {
  const running = [...board];
  const ids = new Set(board.map((it) => it.id));
  const firstPanel = adds.findIndex(
    (add) => add.position === undefined && add.data.type === 'panel',
  );
  // just after the last add placed below the panels
  let floor = 0;

  return adds.map((add, index) => {
    const ruled = defaultInsertIndex(running, add.data.type);
    const behind =
      add.position === undefined && ruled === undefined && index < firstPanel;
    const position =
      add.position ??
      (behind
        ? Math.max(defaultInsertIndex(running, 'panel') ?? 0, floor)
        : ruled === undefined
          ? undefined
          : Math.max(ruled, floor));

    if (!ids.has(add.data.id)) {
      ids.add(add.data.id);

      // the splice-or-push rule of sync-node-box apply-action
      if (
        position !== undefined &&
        position >= 0 &&
        position < running.length
      ) {
        running.splice(position, 0, add.data);
      } else {
        running.push(add.data);
      }

      if (behind && position !== undefined) {
        floor = Math.min(position, running.length - 1) + 1;
      }
    }

    return position === undefined ? add : { ...add, position };
  });
}
