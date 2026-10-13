import {
  isNoteMaskedFor,
  isNotesHidden,
  type Note,
  type StateActions,
  type TuNode,
} from '@tapiz/board-commons';

// all anyone can change on someone else's note while notes are hidden
const MOVE_KEYS = new Set(['position', 'width', 'height', 'layer']);

/**
 * While notes are hidden the server rejects any edit of someone else's note,
 * and one rejected action drops the sender's whole batch. Undo, redo, paste
 * and multi-select can still build such actions, so they are filtered before
 * they are applied and sent: patches keep only the move and resize keys,
 * everything else is dropped. `blocked` tells whether anything was removed.
 */
export function filterHiddenNoteActions<T extends StateActions>(
  actions: T[],
  nodes: TuNode[],
  userId: string,
): { actions: T[]; blocked: boolean } {
  if (!isNotesHidden(nodes)) {
    return { actions, blocked: false };
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const isMasked = (id: string | undefined) => {
    const node = id ? byId.get(id) : undefined;

    return !!node && isNoteMaskedFor(node, nodes, userId);
  };

  let blocked = false;

  const allowed = actions.flatMap((action): T[] => {
    // comments of someone else's note
    if (action.parent) {
      if (isMasked(action.parent)) {
        blocked = true;
        return [];
      }

      return [action];
    }

    if (action.data.type !== 'note') {
      return [action];
    }

    if (action.op === 'add') {
      if ((action.data as TuNode<Partial<Note>>).content.ownerId !== userId) {
        blocked = true;
        return [];
      }

      return [action];
    }

    if (!isMasked(action.data.id)) {
      return [action];
    }

    if (action.op === 'remove') {
      blocked = true;
      return [];
    }

    const entries = Object.entries((action.data as TuNode).content);
    const moves = entries.filter(([key]) => MOVE_KEYS.has(key));

    if (moves.length === entries.length) {
      return [action];
    }

    blocked = true;

    if (!moves.length) {
      return [];
    }

    return [
      {
        ...action,
        data: { ...action.data, content: Object.fromEntries(moves) },
      },
    ];
  });

  return { actions: allowed, blocked };
}
