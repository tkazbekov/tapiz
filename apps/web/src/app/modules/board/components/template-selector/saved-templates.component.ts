import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import {
  EMPTY,
  catchError,
  filter,
  firstValueFrom,
  merge,
  of,
  switchMap,
} from 'rxjs';
import {
  TemplateApiService,
  TemplateSummary,
  templateErrorMessage,
} from '../../../../services/template-api.service';
import { NotificationService } from '../../../../shared/notification/notification.service';
import { ConfirmComponent } from '../../../../shared/confirm-action/confirm-actions.component';
import { TemplateInsertService } from './template-insert.service';
import { Thumbnail, templateThumbnail } from './template-thumbnail';

export interface SavedTemplateGroup {
  key: string;
  title: string;
  templates: TemplateSummary[];
}

@Component({
  selector: 'tapiz-saved-templates',
  imports: [MatIconModule],
  template: `
    @if (failed()) {
      <p class="hint">Could not load saved templates</p>
    } @else if (!loaded()) {
      <p class="hint">Loading saved templates…</p>
    } @else if (!groups().length) {
      <p class="hint">
        Select nodes on the board and use "Save as template…" from the right
        click menu to keep them here.
      </p>
    }
    @for (group of groups(); track group.key) {
      <h3>{{ group.title }}</h3>
      <div class="templates">
        @for (template of group.templates; track template.id) {
          <div class="card">
            <button
              class="insert"
              type="button"
              [disabled]="busy()"
              [attr.aria-label]="'Insert ' + template.name"
              (click)="insert(template)">
              @let thumbnail = thumbnails()[template.id];
              @if (thumbnail === 'failed') {
                <span class="preview no-preview">No preview</span>
              } @else {
                <svg
                  class="preview"
                  width="300"
                  height="180"
                  preserveAspectRatio="xMidYMid meet"
                  [attr.viewBox]="thumbnail?.viewBox ?? '0 0 300 180'">
                  @for (shape of thumbnail?.shapes ?? []; track $index) {
                    @if (shape.kind === 'line') {
                      <line
                        class="line"
                        vector-effect="non-scaling-stroke"
                        [attr.x1]="shape.x1"
                        [attr.y1]="shape.y1"
                        [attr.x2]="shape.x2"
                        [attr.y2]="shape.y2" />
                    } @else {
                      <rect
                        vector-effect="non-scaling-stroke"
                        [class]="shape.kind"
                        [attr.x]="shape.x"
                        [attr.y]="shape.y"
                        [attr.width]="shape.width"
                        [attr.height]="shape.height"
                        [attr.fill]="shape.fill ?? null" />
                    }
                  }
                </svg>
              }
              <p>{{ template.name }}</p>
            </button>
            @if (template.canEdit) {
              <button
                class="delete"
                type="button"
                title="Delete template"
                [attr.aria-label]="'Delete ' + template.name"
                (click)="remove(template)">
                <mat-icon>delete</mat-icon>
              </button>
            }
          </div>
        }
      </div>
    }
  `,
  styleUrl: './saved-templates.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SavedTemplatesComponent {
  #templateApi = inject(TemplateApiService);
  #templateInsert = inject(TemplateInsertService);
  #notificationService = inject(NotificationService);
  #dialog = inject(MatDialog);
  #destroyRef = inject(DestroyRef);

  selected = output();

  templates = signal<TemplateSummary[]>([]);
  // drawn from the outline each listed template carries: no request per card
  thumbnails = computed((): Partial<Record<string, Thumbnail | 'failed'>> =>
    Object.fromEntries(
      this.templates().map((template): [string, Thumbnail | 'failed'] => [
        template.id,
        template.preview?.length
          ? templateThumbnail(template.preview, template)
          : 'failed',
      ]),
    ),
  );
  loaded = signal(false);
  failed = signal(false);
  busy = this.#templateInsert.busy;

  groups = computed(() => {
    const personal: SavedTemplateGroup = {
      key: 'personal',
      title: 'My templates',
      templates: [],
    };
    const teams = new Map<string, SavedTemplateGroup>();

    this.templates().forEach((template) => {
      const { scope } = template;

      if (scope.kind === 'personal') {
        personal.templates.push(template);
        return;
      }

      const group = teams.get(scope.teamId) ?? {
        key: scope.teamId,
        title: scope.teamName ?? 'Team',
        templates: [],
      };

      group.templates.push(template);
      teams.set(scope.teamId, group);
    });

    return [personal, ...teams.values()].filter(
      (group) => group.templates.length,
    );
  });

  constructor() {
    // listed again whenever a template is saved or deleted, so a pinned
    // popup picks up a template saved from the context menu
    merge(of(undefined), this.#templateApi.changed)
      .pipe(
        switchMap(() =>
          this.#templateApi.list().pipe(
            catchError(() => {
              this.failed.set(true);
              return EMPTY;
            }),
          ),
        ),
        takeUntilDestroyed(this.#destroyRef),
      )
      .subscribe((templates) => {
        this.templates.set(templates);
        this.loaded.set(true);
        this.failed.set(false);
      });
  }

  async insert(template: TemplateSummary) {
    try {
      // fresh data: the server parses it again on every read
      const inserted = await this.#templateInsert.insertFrom(async () => {
        const { data } = await firstValueFrom(
          this.#templateApi.get(template.id),
        );

        return data;
      });

      if (inserted) {
        this.selected.emit();
      }
    } catch (error) {
      this.#notify(
        templateErrorMessage(error, 'Could not insert the template'),
      );
    }
  }

  remove(template: TemplateSummary) {
    this.#dialog
      .open(ConfirmComponent, {
        data: {
          title: 'Delete template?',
          description:
            template.scope.kind === 'team'
              ? `"${template.name}" will be deleted for everyone in the team.`
              : `"${template.name}" will be deleted.`,
          confirm: { text: 'Delete', color: 'warn' },
          cancel: { text: 'Cancel', color: 'basic' },
          align: 'end',
        },
      })
      .afterClosed()
      .pipe(
        filter(Boolean),
        switchMap(() => this.#templateApi.remove(template.id)),
        takeUntilDestroyed(this.#destroyRef),
      )
      .subscribe({
        next: () => {
          this.templates.update((templates) =>
            templates.filter((it) => it.id !== template.id),
          );
        },
        error: (error: unknown) => {
          this.#notify(
            templateErrorMessage(error, 'Could not delete the template'),
          );
        },
      });
  }

  #notify(message: string) {
    this.#notificationService.open({
      message,
      action: 'Close',
      type: 'error',
      durantion: 4000,
    });
  }
}
