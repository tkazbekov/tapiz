import { describe, expect, it } from 'vitest';
import type { NodePatch, StateActions, TuNode } from '@tapiz/board-commons';
import { filterHiddenNoteActions } from './hidden-notes-actions';

describe('filterHiddenNoteActions', () => {
  const note = (id: string, ownerId: string): TuNode => ({
    id,
    type: 'note',
    content: { ownerId, text: '', votes: [], position: { x: 0, y: 0 } },
  });

  const settings = (notesHidden: boolean): TuNode => ({
    id: 'settings',
    type: 'settings',
    content: { notesHidden },
  });

  const board = (notesHidden: boolean) => [
    settings(notesHidden),
    note('mine', 'me'),
    note('theirs', 'other'),
  ];

  const patch = (id: string, content: object): NodePatch => ({
    op: 'patch',
    data: { id, type: 'note', content },
  });

  it('keeps everything while notes are visible', () => {
    const actions: StateActions[] = [
      patch('theirs', { text: 'undo' }),
      { op: 'remove', data: { id: 'theirs', type: 'note' } },
    ];

    expect(filterHiddenNoteActions(actions, board(false), 'me')).toEqual({
      actions,
      blocked: false,
    });
  });

  it('only keeps moves and resizes of someone else’s note', () => {
    const result = filterHiddenNoteActions(
      [
        // an undo of an edit made before the notes were hidden
        patch('theirs', {
          text: 'old',
          votes: [],
          position: { x: 5, y: 5 },
          width: 300,
        }),
        patch('theirs', { color: '#fff' }),
        patch('theirs', { layer: 0 }),
        patch('mine', { text: 'mine' }),
      ],
      board(true),
      'me',
    );

    expect(result.blocked).toBe(true);
    expect(result.actions).toEqual([
      patch('theirs', { position: { x: 5, y: 5 }, width: 300 }),
      patch('theirs', { layer: 0 }),
      patch('mine', { text: 'mine' }),
    ]);
  });

  it('keeps reordering someone else’s note', () => {
    const bringToFront: NodePatch = {
      ...patch('theirs', {}),
      position: 10,
    };

    expect(filterHiddenNoteActions([bringToFront], board(true), 'me')).toEqual({
      actions: [bringToFront],
      blocked: false,
    });
  });

  it('drops removes of someone else’s note from a multi-select delete', () => {
    const result = filterHiddenNoteActions(
      [
        { op: 'remove', data: { id: 'mine', type: 'note' } },
        { op: 'remove', data: { id: 'theirs', type: 'note' } },
        { op: 'remove', data: { id: 'group', type: 'group' } },
      ],
      board(true),
      'me',
    );

    expect(result.blocked).toBe(true);
    expect(result.actions.map((it) => it.data.id)).toEqual(['mine', 'group']);
  });

  it('drops notes added for someone else, as an undo of a delete would', () => {
    const result = filterHiddenNoteActions(
      [
        { op: 'add', data: note('restored', 'other') },
        { op: 'add', data: note('new', 'me') },
      ],
      board(true),
      'me',
    );

    expect(result.blocked).toBe(true);
    expect(result.actions.map((it) => it.data.id)).toEqual(['new']);
  });

  it('drops comments on someone else’s note', () => {
    const comment = (parent: string): StateActions => ({
      op: 'add',
      parent,
      data: { id: '', type: 'comment', content: { text: 'hi' } },
    });

    const result = filterHiddenNoteActions(
      [comment('theirs'), comment('mine')],
      board(true),
      'me',
    );

    expect(result.blocked).toBe(true);
    expect(result.actions).toEqual([comment('mine')]);
  });
});
