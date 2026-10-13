import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { Store } from '@ngrx/store';
import { describe, beforeEach, it, expect, vi } from 'vitest';
import { isNoteMaskedFor } from '@tapiz/board-commons';
import type { TuNode, UserVote } from '@tapiz/board-commons';
import { BoardFacade } from '../../../services/board-facade.service';
import { NotificationService } from '../../../shared/notification/notification.service';
import { VotesService } from './votes.service';

describe('VotesService', () => {
  let service: VotesService;
  let dispatch: ReturnType<typeof vi.fn>;
  let notify: ReturnType<typeof vi.fn>;
  const nodes = signal<TuNode[]>([]);

  const note = (
    id: string,
    votes: UserVote[],
  ): TuNode<{ votes: UserVote[] }> => ({
    id,
    type: 'note',
    content: { votes },
  });

  const click = (button: number) => ({ button }) as MouseEvent;

  const dispatchedVotes = () =>
    dispatch.mock.calls.map(
      ([action]) => action.actions[0].data.content.votes as UserVote[],
    );

  beforeEach(() => {
    dispatch = vi.fn();
    notify = vi.fn();
    nodes.set([]);

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: Store, useValue: { dispatch } },
        {
          provide: BoardFacade,
          useValue: {
            nodes,
            userId: signal('me'),
            settings: () => nodes().find((it) => it.type === 'settings'),
            isMasked: (node: TuNode) => isNoteMaskedFor(node, nodes(), 'me'),
          },
        },
        { provide: NotificationService, useValue: { open: notify } },
      ],
    });

    service = TestBed.inject(VotesService);
  });

  it('only changes the own vote', () => {
    const target = note('n1', [
      { userId: 'other', vote: 2 },
      { userId: 'me', vote: 1 },
    ]);

    service.vote(target, 'note', click(0));
    service.vote(target, 'note', click(2));

    expect(dispatchedVotes()).toEqual([
      [
        { userId: 'other', vote: 2 },
        { userId: 'me', vote: 2 },
      ],
      [{ userId: 'other', vote: 2 }],
    ]);
  });

  it('stops voting when no votes are left', () => {
    const target = note('n1', [{ userId: 'me', vote: 2 }]);

    nodes.set([
      { id: 'settings', type: 'settings', content: { votesPerUser: 2 } },
      target,
    ]);

    expect(service.votesLeft()).toBe(0);

    service.vote(target, 'note', click(0));

    expect(dispatch).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'No votes left' }),
    );

    // taking a vote back is always allowed
    service.vote(target, 'note', click(2));

    expect(dispatchedVotes()).toEqual([[{ userId: 'me', vote: 1 }]]);
  });

  it('does not vote on someone else’s note while notes are hidden', () => {
    const theirs: TuNode<{ votes: UserVote[]; ownerId: string }> = {
      id: 'n1',
      type: 'note',
      content: { votes: [{ userId: 'me', vote: 1 }], ownerId: 'other' },
    };
    const mine = { ...theirs, id: 'n2', content: { votes: [], ownerId: 'me' } };

    nodes.set([
      { id: 'settings', type: 'settings', content: { notesHidden: true } },
      theirs,
      mine,
    ]);

    service.vote(theirs, 'note', click(0));
    service.vote(theirs, 'note', click(2));

    expect(dispatch).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(2);

    service.vote(mine, 'note', click(0));

    expect(dispatchedVotes()).toEqual([[{ userId: 'me', vote: 1 }]]);
  });

  it('does not go below zero votes', () => {
    service.vote(note('n1', []), 'group', click(2));

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('has unlimited votes without a budget', () => {
    nodes.set([note('n1', [{ userId: 'me', vote: 30 }])]);

    expect(service.budget()).toBeNull();
    expect(service.votesLeft()).toBeNull();
  });
});
