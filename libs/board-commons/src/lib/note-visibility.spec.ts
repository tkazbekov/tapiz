import type { StateActions, TuNode } from './models/node.model.js';
import {
  isNoteMaskedFor,
  isNotesHidden,
  maskActionsForViewer,
  maskNodesForViewer,
  maskNote,
} from './note-visibility.js';

const noteContent = (ownerId: string) => ({
  text: `<p>secret of ${ownerId}</p>`,
  position: { x: 10, y: 20 },
  layer: 0,
  ownerId,
  votes: [{ userId: 'other', vote: 2 }],
  emojis: [{ unicode: '1f600', position: { x: 1, y: 1 } }],
  drawing: [{ color: '#000000', size: 2, points: [{ x: 0, y: 0 }] }],
  width: 300,
  height: 300,
  color: '#fee2e2',
  textHidden: true,
});

const note = (id: string, ownerId: string): TuNode => ({
  id,
  type: 'note',
  content: noteContent(ownerId),
  children: [
    {
      id: `${id}-comment`,
      type: 'comment',
      content: { text: 'a comment', userId: ownerId, date: 1 },
    },
  ],
});

const settings = (notesHidden: boolean): TuNode => ({
  id: 'settings',
  type: 'settings',
  content: { notesHidden },
});

const board = (notesHidden: boolean): TuNode[] => [
  settings(notesHidden),
  note('mine', 'me'),
  note('theirs', 'other'),
  { id: 'group', type: 'group', content: { title: 'Ideas', votes: [] } },
];

const masked = {
  id: 'theirs',
  type: 'note',
  content: {
    text: '',
    drawing: [],
    emojis: [],
    position: { x: 10, y: 20 },
    layer: 0,
    ownerId: 'other',
    votes: [{ userId: 'other', vote: 2 }],
    width: 300,
    height: 300,
    color: '#fee2e2',
  },
};

describe('note visibility', () => {
  it('reads the setting from the board or the settings', () => {
    expect(isNotesHidden(board(true))).toBe(true);
    expect(isNotesHidden(board(false))).toBe(false);
    expect(isNotesHidden([])).toBe(false);
    expect(isNotesHidden({ notesHidden: true })).toBe(true);
    expect(isNotesHidden(undefined)).toBe(false);
  });

  it('masks the notes of other users only', () => {
    const nodes = board(true);

    expect(isNoteMaskedFor(nodes[1], nodes, 'me')).toBe(false);
    expect(isNoteMaskedFor(nodes[2], nodes, 'me')).toBe(true);
    expect(isNoteMaskedFor(nodes[2], nodes, 'other')).toBe(false);
    expect(isNoteMaskedFor(nodes[3], nodes, 'me')).toBe(false);
    expect(isNoteMaskedFor(nodes[2], board(false), 'me')).toBe(false);
  });

  it('keeps the card of a masked note and drops its content and comments', () => {
    expect(maskNote(note('theirs', 'other'))).toEqual(masked);
  });

  it('masks a board for each viewer without changing it', () => {
    const nodes = board(true);
    const before = structuredClone(nodes);
    const seen = maskNodesForViewer(nodes, 'me');

    expect(seen).toEqual([nodes[0], nodes[1], masked, nodes[3]]);
    expect(seen[1]).toBe(nodes[1]);
    expect(nodes).toEqual(before);
    expect(maskNodesForViewer(nodes, 'other')[1]).toEqual(maskNote(nodes[1]));
  });

  it('returns the same board and actions when notes are not hidden', () => {
    const nodes = board(false);
    const actions: StateActions[] = [
      {
        op: 'patch',
        data: { id: 'theirs', type: 'note', content: { text: 'x' } },
      },
    ];

    expect(maskNodesForViewer(nodes, 'me')).toBe(nodes);
    expect(maskActionsForViewer(actions, nodes, 'me')).toBe(actions);
  });

  it('masks note adds of other users', () => {
    const add = (ownerId: string): StateActions => ({
      op: 'add',
      data: note('theirs', ownerId),
      position: 2,
    });

    expect(maskActionsForViewer([add('other')], board(true), 'me')).toEqual([
      { op: 'add', data: masked, position: 2 },
    ]);
    expect(maskActionsForViewer([add('me')], board(true), 'me')).toEqual([
      add('me'),
    ]);
  });

  it('omits the content keys of patches to notes of other users', () => {
    const patch = (id: string, content: object): StateActions => ({
      op: 'patch',
      data: { id, type: 'note', content },
    });
    const nodes = board(true);

    expect(
      maskActionsForViewer(
        [
          patch('theirs', {
            text: 'new',
            drawing: [],
            emojis: [],
            textHidden: false,
            position: { x: 1, y: 2 },
            votes: [],
          }),
          patch('theirs', { text: 'only text' }),
          patch('missing', { text: 'unknown owner' }),
          patch('mine', { text: 'my text' }),
          { op: 'remove', data: { id: 'theirs', type: 'note' } },
        ],
        nodes,
        'me',
      ),
    ).toEqual([
      patch('theirs', { position: { x: 1, y: 2 }, votes: [] }),
      patch('mine', { text: 'my text' }),
      { op: 'remove', data: { id: 'theirs', type: 'note' } },
    ]);
  });

  it('drops child actions of notes of other users', () => {
    const comment = (parent: string): StateActions => ({
      op: 'add',
      parent,
      data: {
        id: `${parent}-new`,
        type: 'comment',
        content: { text: 'hi', userId: 'x', date: 1 },
      },
    });
    const nodes = [...board(true), { id: 'poll', type: 'poll', content: {} }];

    expect(
      maskActionsForViewer(
        [
          comment('theirs'),
          comment('mine'),
          comment('missing'),
          comment('poll'),
        ],
        nodes,
        'me',
      ),
    ).toEqual([comment('mine'), comment('poll')]);
  });
});
