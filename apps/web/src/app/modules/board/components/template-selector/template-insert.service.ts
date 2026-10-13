import { Injectable, inject, signal } from '@angular/core';
import { Store } from '@ngrx/store';
import {
  BoardTemplateData,
  assignInsertPositions,
  instantiateTemplate,
  viewportCenter,
} from '@tapiz/board-commons';
import { uuid } from '@tapiz/utils/uuid';
import { BoardActions } from '../../actions/board.actions';
import { boardPageFeature } from '../../reducers/boardPage.reducer';
import { BoardFacade } from '../../../../services/board-facade.service';
import { NotificationService } from '../../../../shared/notification/notification.service';

const HEADER_HEIGHT = 42;

/**
 * Built-in and saved templates both land here: centred in the viewport,
 * fresh ids, and their own stacking order kept.
 */
@Injectable({ providedIn: 'root' })
export class TemplateInsertService {
  #store = inject(Store);
  #boardFacade = inject(BoardFacade);
  #notificationService = inject(NotificationService);
  #position = this.#store.selectSignal(boardPageFeature.selectPosition);
  #zoom = this.#store.selectSignal(boardPageFeature.selectZoom);
  #busy = signal(false);

  // a template is loading; the popup blocks other inserts meanwhile
  readonly busy = this.#busy.asReadonly();

  /**
   * Loads and inserts one template at a time. False when another insert is
   * running or the template can't be inserted; load errors are rethrown.
   */
  async insertFrom(load: () => Promise<BoardTemplateData>): Promise<boolean> {
    if (this.#busy()) {
      return false;
    }

    this.#busy.set(true);

    try {
      return this.insert(await load());
    } finally {
      this.#busy.set(false);
    }
  }

  insert(data: BoardTemplateData): boolean {
    const center = viewportCenter(this.#position(), this.#zoom(), {
      width: window.innerWidth,
      height: window.innerHeight - HEADER_HEIGHT,
    });

    // the Templates popup only shows to admins in edit mode
    const result = instantiateTemplate(data, {
      origin: {
        x: center.x - data.size.width / 2,
        y: center.y - data.size.height / 2,
      },
      newId: uuid,
      ownerId: this.#boardFacade.userId(),
      isAdmin: true,
      layer: 'asStored',
    });

    if ('error' in result) {
      this.#notificationService.open({
        message: 'Only board admins can insert this template',
        action: 'Close',
        type: 'error',
        durantion: 4000,
      });

      return false;
    }

    this.#store.dispatch(
      BoardActions.batchNodeActions({
        history: true,
        actions: assignInsertPositions(
          this.#boardFacade.nodes(),
          result.actions,
        ),
      }),
    );

    return true;
  }
}
