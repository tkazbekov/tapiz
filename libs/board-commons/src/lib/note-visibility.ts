import type { BoardSettings } from './models/board-settings.model.js';
import { isSettings } from './models/board-settings.model.js';
import type { StateActions, TuNode } from './models/node.model.js';
import type { Note } from './models/note.model.js';
import { isNote } from './models/note.model.js';

/*
 * While notes are hidden the server never sends a note's content to anyone
 * but its owner, admins included. Masking only changes what is sent: the
 * stored board keeps every note whole.
 */

// the note content that only its owner sees while notes are hidden
const SECRET_NOTE_KEYS = ['text', 'drawing', 'emojis', 'textHidden'] as const;

const ownerOf = (node: TuNode | undefined) =>
  (node?.content as Partial<Note> | undefined)?.ownerId;

export function isNotesHidden(
  source: TuNode[] | BoardSettings | null | undefined,
) {
  const settings = Array.isArray(source)
    ? source.find(isSettings)?.content
    : source;

  return settings?.notesHidden === true;
}

export function isNoteMaskedFor(
  node: TuNode,
  settings: TuNode[] | BoardSettings | null | undefined,
  viewerId: string,
) {
  return isNote(node) && isNotesHidden(settings) && ownerOf(node) !== viewerId;
}

// what a hidden note still shows: its place, size, color, owner and votes
const PUBLIC_NOTE_KEYS = [
  'position',
  'layer',
  'width',
  'height',
  'color',
  'ownerId',
  'votes',
] as const;

// a blank card without comments
export function maskNote(note: TuNode): TuNode {
  const content = note.content as Partial<Note>;
  const visible = PUBLIC_NOTE_KEYS.filter((key) => key in content).map(
    (key) => [key, content[key]],
  );

  return {
    id: note.id,
    type: note.type,
    content: {
      ...Object.fromEntries(visible),
      text: '',
      drawing: [],
      emojis: [],
    },
  };
}

// the same array when nothing is hidden
export function maskNodesForViewer(nodes: TuNode[], viewerId: string) {
  if (!isNotesHidden(nodes)) {
    return nodes;
  }

  return nodes.map((node) =>
    isNote(node) && ownerOf(node) !== viewerId ? maskNote(node) : node,
  );
}

/**
 * `nodes` is the board after the actions were applied. A patch of someone
 * else's note loses its content keys instead of blanking them, so a patch
 * sent late, after a reveal, can't wipe the note. Child actions of someone
 * else's note (comments) are dropped, and so are those of a missing parent.
 */
export function maskActionsForViewer(
  actions: StateActions[],
  nodes: TuNode[],
  viewerId: string,
): StateActions[] {
  if (!isNotesHidden(nodes)) {
    return actions;
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const isForeignNote = (node: TuNode | undefined) =>
    !node || (isNote(node) && ownerOf(node) !== viewerId);

  return actions.flatMap((action): StateActions[] => {
    if (action.parent) {
      return isForeignNote(byId.get(action.parent)) ? [] : [action];
    }

    if (action.data.type !== 'note' || action.op === 'remove') {
      return [action];
    }

    if (action.op === 'add') {
      return ownerOf(action.data) === viewerId
        ? [action]
        : [{ ...action, data: maskNote(action.data) }];
    }

    if (!isForeignNote(byId.get(action.data.id))) {
      return [action];
    }

    const content: Record<string, unknown> = { ...action.data.content };

    SECRET_NOTE_KEYS.forEach((key) => delete content[key]);

    if (!Object.keys(content).length) {
      return [];
    }

    return [{ ...action, data: { ...action.data, content } }];
  });
}
