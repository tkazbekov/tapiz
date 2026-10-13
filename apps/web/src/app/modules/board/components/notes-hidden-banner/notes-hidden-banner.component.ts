import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Store } from '@ngrx/store';
import { MatButtonModule } from '@angular/material/button';
import { LucideEyeClosed } from '@lucide/angular';
import { BoardFacade } from '../../../../services/board-facade.service';
import { BoardActions } from '../../actions/board.actions';
import { boardPageFeature } from '../../reducers/boardPage.reducer';
import { settingsAction } from '../board-settings/settings-action';

@Component({
  selector: 'tapiz-notes-hidden-banner',
  imports: [MatButtonModule, LucideEyeClosed],
  template: `
    <svg
      lucideEyeClosed
      size="18"></svg>
    @if (isAdmin()) {
      <span>Notes are hidden</span>
      <button
        type="button"
        mat-flat-button
        (click)="reveal()">
        Reveal notes
      </button>
    } @else {
      <span
        >Notes are hidden until the facilitator reveals them. Only you can see
        your notes' content.</span
      >
    }
  `,
  styleUrl: './notes-hidden-banner.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'status',
  },
})
export class NotesHiddenBannerComponent {
  #store = inject(Store);
  #boardFacade = inject(BoardFacade);

  isAdmin = this.#store.selectSignal(boardPageFeature.selectIsAdmin);

  reveal() {
    this.#store.dispatch(
      BoardActions.batchNodeActions({
        history: false,
        actions: [
          settingsAction(this.#boardFacade.settings(), { notesHidden: false }),
        ],
      }),
    );
  }
}
