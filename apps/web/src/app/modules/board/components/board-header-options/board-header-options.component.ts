import {
  Component,
  ChangeDetectionStrategy,
  inject,
  input,
} from '@angular/core';
import { Store } from '@ngrx/store';
import { BoardPageActions } from '../../actions/board-page.actions';
import { ExportService } from '../../services/export.service';
import { MatIconModule } from '@angular/material/icon';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { ShareBoardComponent } from '../share-board/share-board.component';
import { boardPageFeature } from '../../reducers/boardPage.reducer';
import { BoardSettingsComponent } from '../board-settings/board-settings.component';
import { computed } from '@angular/core';
import { ConfigService } from '../../../../services/config.service';
import { MatButtonModule } from '@angular/material/button';
import { BoardFacade } from '../../../../services/board-facade.service';
import { BoardMembersComponent } from '../board-members/board-members.component';
import { UserNotificationsComponent } from '../../../home/components/user-notifications/users-notifications.component';
import { LucideEye, LucideEyeClosed } from '@lucide/angular';
import { BoardActions } from '../../actions/board.actions';
import { settingsAction } from '../board-settings/settings-action';

@Component({
  selector: 'tapiz-board-header-options',
  templateUrl: './board-header-options.component.html',
  styleUrls: ['./board-header-options.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatIconModule,
    MatDialogModule,
    MatButtonModule,
    UserNotificationsComponent,
    LucideEye,
    LucideEyeClosed,
  ],
})
export class BoardHeaderOptionsComponent {
  #exportService = inject(ExportService);
  #store = inject(Store);
  #dialog = inject(MatDialog);
  #boardFacade = inject(BoardFacade);
  #boardUsers = this.#store.selectSignal(boardPageFeature.selectBoardUsers);
  #configService = inject(ConfigService);
  #users = this.#boardFacade.users;

  userId = this.#store.selectSignal(boardPageFeature.selectUserId);
  users = computed(() => {
    const boardUsers = this.#boardUsers();

    return this.#users()
      .filter((user) => user.id !== this.userId())
      .map((user) => {
        const boardUser = boardUsers.find(
          (boardUser) => boardUser.id === user.id,
        );

        return {
          ...user,
          picture: boardUser?.picture,
        };
      });
  });
  #settings = this.#boardFacade.settings;

  showUsers = computed(() => {
    return !this.#settings()?.content.anonymousMode;
  });

  notesHidden = this.#boardFacade.notesHidden;

  // anonymous notes have no owner, so they can't be hidden
  anonymousMode = computed(() => {
    return !!this.#settings()?.content.anonymousMode;
  });

  notesHiddenTitle = computed(() => {
    if (this.notesHidden()) {
      return "Show everyone's notes";
    }

    return this.anonymousMode()
      ? 'Turn off anonymous mode to hide notes'
      : "Hide everyone's notes until you reveal them";
  });

  allowSwitchMode = input(true);

  boardMode = this.#store.selectSignal(boardPageFeature.selectBoardMode);
  isAdmin = this.#store.selectSignal(boardPageFeature.selectIsAdmin);
  boardId = this.#store.selectSignal(boardPageFeature.selectBoardId);

  get isDemo() {
    return !!this.#configService.config.DEMO;
  }

  changeBoardMode(boardMode: number) {
    this.#store.dispatch(
      BoardPageActions.changeBoardMode({
        boardMode,
      }),
    );
  }

  toggleNotesHidden() {
    this.#store.dispatch(
      BoardActions.batchNodeActions({
        history: false,
        actions: [
          settingsAction(this.#settings(), {
            notesHidden: !this.notesHidden(),
          }),
        ],
      }),
    );
  }

  export() {
    this.#exportService.getExportFile().then(
      (url) => {
        const fileLink = document.createElement('a');

        fileLink.href = url;
        fileLink.download = `${this.boardId()}.json`;
        fileLink.click();
      },
      () => {
        console.error('export error');
      },
    );
  }

  share() {
    this.#dialog.open(ShareBoardComponent, {
      width: '600px',
      autoFocus: 'dialog',
    });
  }

  settings() {
    this.#dialog.open(BoardSettingsComponent, {
      width: '600px',
      autoFocus: 'dialog',
    });
  }

  openUserList() {
    this.#dialog.open(BoardMembersComponent, {
      width: '600px',
      autoFocus: 'dialog',
    });
  }
}
