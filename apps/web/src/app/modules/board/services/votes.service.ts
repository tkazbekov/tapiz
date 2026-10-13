import { Injectable, computed, inject } from '@angular/core';
import { Store } from '@ngrx/store';
import {
  countUserVotes,
  ownVotes,
  StateActions,
  TuNode,
  UserVote,
  votesBudget,
} from '@tapiz/board-commons';
import { BoardActions } from '@tapiz/board-commons/actions/board.actions';
import { BoardFacade } from '../../../services/board-facade.service';
import { NotificationService } from '../../../shared/notification/notification.service';

// how long our own vote on a node counts as in flight
const PENDING_VOTE_MS = 2000;

type VotesAction = StateActions & {
  data: { id: string; type: string; content: { votes: UserVote[] } };
};

function isVotesAction(action: StateActions): action is VotesAction {
  if (action.op === 'remove' || action.parent) {
    return false;
  }

  const content = action.data.content as { votes?: unknown } | undefined;

  return (
    (action.data.type === 'note' || action.data.type === 'group') &&
    Array.isArray(content?.votes)
  );
}

@Injectable({ providedIn: 'root' })
export class VotesService {
  #store = inject(Store);
  #boardFacade = inject(BoardFacade);
  #notificationService = inject(NotificationService);
  // node id -> when we last sent our own votes on it
  #pending = new Map<string, number>();

  // null is unlimited
  budget = computed(() => votesBudget(this.#boardFacade.settings()?.content));

  used = computed(() =>
    countUserVotes(this.#boardFacade.nodes(), this.#boardFacade.userId()),
  );

  votesLeft = computed(() => {
    const budget = this.budget();

    return budget === null ? null : Math.max(0, budget - this.used());
  });

  // left click adds a vote, right click takes one back
  vote(
    node: TuNode<{ votes: UserVote[] }>,
    type: 'note' | 'group',
    event: MouseEvent,
  ) {
    const userId = this.#boardFacade.userId();
    const delta = event.button === 2 ? -1 : 1;
    const vote = ownVotes(node.content.votes, userId) + delta;

    if (vote < 0) {
      return;
    }

    // nobody votes on someone else's note before the reveal
    if (this.#boardFacade.isMasked(node)) {
      this.#notificationService.open({
        message: 'Voting on this note opens after the reveal',
        action: 'Close',
        type: 'info',
        durantion: 3000,
      });
      return;
    }

    if (delta > 0 && this.votesLeft() === 0) {
      this.#notificationService.open({
        message: 'No votes left',
        action: 'Close',
        type: 'info',
        durantion: 3000,
      });
      return;
    }

    const own = { userId, vote };
    const votes = node.content.votes.some((it) => it.userId === userId)
      ? node.content.votes.map((it) => (it.userId === userId ? own : it))
      : [...node.content.votes, own];

    this.#store.dispatch(
      BoardActions.batchNodeActions({
        history: true,
        actions: [
          {
            data: {
              type,
              id: node.id,
              content: {
                votes: votes.filter((it) => it.vote !== 0),
              },
            },
            op: 'patch',
          },
        ],
      }),
    );
  }

  markSent(actions: StateActions[]) {
    const now = Date.now();

    actions.filter(isVotesAction).forEach((action) => {
      this.#pending.set(action.data.id, now);
    });
  }

  // Another user's vote is broadcast with the votes stored when it was
  // queued, so it can carry an older value of our own entry than the vote we
  // just sent. Keep our local entry while our own vote is in flight; after
  // that the incoming entry wins (e.g. a vote from another tab).
  mergeIncoming(actions: StateActions[]): StateActions[] {
    const userId = this.#boardFacade.userId();
    const now = Date.now();

    return actions.map((action) => {
      if (!isVotesAction(action)) {
        return action;
      }

      const sentAt = this.#pending.get(action.data.id);

      if (sentAt === undefined || now - sentAt > PENDING_VOTE_MS) {
        this.#pending.delete(action.data.id);
        return action;
      }

      const node = this.#boardFacade
        .nodes()
        .find((it) => it.id === action.data.id);
      const localVotes = (node?.content as { votes?: UserVote[] } | undefined)
        ?.votes;

      if (!localVotes) {
        return action;
      }

      const own = ownVotes(localVotes, userId);
      const others = action.data.content.votes.filter(
        (it) => it.userId !== userId,
      );

      return {
        ...action,
        data: {
          ...action.data,
          content: {
            ...action.data.content,
            votes: own ? [...others, { userId, vote: own }] : others,
          },
        },
      } as StateActions;
    });
  }

  // the server's stored votes for our own actions are authoritative
  applyCorrections(actions: StateActions[]) {
    actions.filter(isVotesAction).forEach((action) => {
      this.#pending.delete(action.data.id);
    });

    this.#boardFacade.applyActions(actions);
  }
}
