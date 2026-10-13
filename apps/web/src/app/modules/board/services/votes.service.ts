import { Injectable, computed, inject } from '@angular/core';
import { Store } from '@ngrx/store';
import {
  countUserVotes,
  ownVotes,
  TuNode,
  UserVote,
  votesBudget,
} from '@tapiz/board-commons';
import { BoardActions } from '@tapiz/board-commons/actions/board.actions';
import { BoardFacade } from '../../../services/board-facade.service';
import { NotificationService } from '../../../shared/notification/notification.service';

@Injectable({ providedIn: 'root' })
export class VotesService {
  #store = inject(Store);
  #boardFacade = inject(BoardFacade);
  #notificationService = inject(NotificationService);

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
}
