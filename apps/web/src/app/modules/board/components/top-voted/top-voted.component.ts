import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { Store } from '@ngrx/store';
import { MatIconModule } from '@angular/material/icon';
import { BoardFacade } from '../../../../services/board-facade.service';
import { BoardPageActions } from '../../actions/board-page.actions';
import { boardPageFeature } from '../../reducers/boardPage.reducer';
import { buildTopVotedItems, visibleNoteOwnerIds } from './top-voted.utils';
import type { TopVotedItem } from './top-voted.utils';

@Component({
  selector: 'tapiz-top-voted',
  imports: [MatIconModule],
  template: `
    <section class="top-voted">
      <header>
        <div>
          <h2>Top voted</h2>
          <p>{{ topItems().length }} topics ready to discuss</p>
        </div>
      </header>

      @if (topItems().length) {
        <ol>
          @for (item of topItems(); track item.id + item.type) {
            <li>
              <button
                type="button"
                (click)="goTo(item)">
                <span class="rank">{{ $index + 1 }}</span>
                <span class="content">
                  <span class="title">{{ item.title }}</span>
                  <span class="meta">
                    {{ typeLabel(item) }}
                    @if (item.type === 'panel') {
                      · {{ item.containedItems }}
                      {{ item.containedItems === 1 ? 'item' : 'items' }}
                    }
                  </span>
                </span>
                <span class="votes">
                  <mat-icon>thumb_up</mat-icon>
                  {{ item.votes }}
                </span>
              </button>
            </li>
          }
        </ol>
      } @else {
        <div class="empty">
          <mat-icon>how_to_vote</mat-icon>
          <p>No votes yet</p>
        </div>
      }
    </section>
  `,
  styleUrls: ['./top-voted.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TopVotedComponent {
  #boardFacade = inject(BoardFacade);
  #store = inject(Store);

  #currentUserId = this.#store.selectSignal(boardPageFeature.selectUserId);

  topItems = computed(() => {
    const nodes = this.#boardFacade.nodes();

    return buildTopVotedItems(nodes, {
      visibleNoteOwnerIds: visibleNoteOwnerIds(
        nodes,
        this.#boardFacade.usersNodes(),
        this.#currentUserId(),
        this.#boardFacade.notesHidden(),
      ),
    });
  });

  goTo(item: TopVotedItem) {
    this.#store.dispatch(BoardPageActions.goToNode({ nodeId: item.id }));
  }

  typeLabel(item: TopVotedItem) {
    switch (item.type) {
      case 'group':
        return 'Group';
      case 'panel':
        return 'Panel';
      default:
        return 'Note';
    }
  }
}
