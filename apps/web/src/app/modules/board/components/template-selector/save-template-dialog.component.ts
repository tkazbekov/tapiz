import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { TEMPLATE_LIMITS } from '@tapiz/board-commons';
import {
  CreateTemplateInput,
  CreateTemplateResult,
  TemplateApiService,
  templateErrorMessage,
} from '../../../../services/template-api.service';
import { NotificationService } from '../../../../shared/notification/notification.service';

export interface SaveTemplateDialogData {
  boardId: string;
  nodeIds: string[];
  // the board's team, offered as the other scope
  team: { id: string; name: string | null } | null;
}

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? '' : 's'}`;

export function saveTemplateMessage(result: CreateTemplateResult) {
  const warnings = result.lint.filter(
    (issue) => issue.level === 'warning',
  ).length;
  const notes = [
    result.dropped.length
      ? `${plural(result.dropped.length, 'node')} left out`
      : '',
    warnings ? plural(warnings, 'layout warning') : '',
  ].filter(Boolean);

  return `Saved "${result.template.name}"${notes.length ? ` (${notes.join(', ')})` : ''}`;
}

@Component({
  selector: 'tapiz-save-template-dialog',
  template: `
    <form
      [formGroup]="form"
      (submit)="submit()">
      <h1>Save as template</h1>
      @if (tooMany) {
        <p class="error">
          Select at most {{ maxNodes }} nodes to save them as a template.
        </p>
      }
      <mat-form-field>
        <mat-label>Name</mat-label>
        <input
          formControlName="name"
          matInput
          maxlength="256"
          type="text" />
      </mat-form-field>
      <mat-form-field>
        <mat-label>Description</mat-label>
        <textarea
          formControlName="description"
          matInput
          maxlength="2000"
          rows="3"></textarea>
      </mat-form-field>
      @if (data.team) {
        <mat-form-field>
          <mat-label>Save for</mat-label>
          <mat-select formControlName="scope">
            <mat-option value="personal">Only me</mat-option>
            <mat-option value="team">{{ data.team.name ?? 'Team' }}</mat-option>
          </mat-select>
        </mat-form-field>
      }
      <div class="actions">
        <button
          [disabled]="saving()"
          type="button"
          mat-button
          mat-dialog-close>
          Cancel
        </button>
        <button
          [disabled]="!form.valid || saving() || tooMany"
          type="submit"
          mat-raised-button
          color="primary">
          Save
        </button>
      </div>
    </form>
  `,
  styleUrl: './save-template-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    MatDialogModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
})
export class SaveTemplateDialogComponent {
  data = inject<SaveTemplateDialogData>(MAT_DIALOG_DATA);
  #dialogRef = inject(MatDialogRef<SaveTemplateDialogComponent>);
  #templateApi = inject(TemplateApiService);
  #notificationService = inject(NotificationService);
  #destroyRef = inject(DestroyRef);

  saving = signal(false);
  readonly maxNodes = TEMPLATE_LIMITS.maxNodes;
  // the server rejects bigger selections
  readonly tooMany = this.data.nodeIds.length > this.maxNodes;

  form = new FormGroup({
    name: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/\S/)],
    }),
    description: new FormControl('', { nonNullable: true }),
    scope: new FormControl<'personal' | 'team'>('personal', {
      nonNullable: true,
    }),
  });

  payload(): CreateTemplateInput {
    const { name, description, scope } = this.form.getRawValue();
    const team = scope === 'team' ? this.data.team : null;

    return {
      boardId: this.data.boardId,
      nodeIds: this.data.nodeIds,
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      scope: team ? 'team' : 'personal',
      ...(team ? { teamId: team.id } : {}),
    };
  }

  submit() {
    if (!this.form.valid || this.saving() || this.tooMany) {
      return;
    }

    // closing now would drop the result message of a save that still lands
    this.saving.set(true);
    this.#dialogRef.disableClose = true;

    this.#templateApi
      .createFromBoard(this.payload())
      .pipe(takeUntilDestroyed(this.#destroyRef))
      .subscribe({
        next: (result) => {
          this.#notify(saveTemplateMessage(result), 'info');
          this.#dialogRef.close(result);
        },
        error: (error: unknown) => {
          this.saving.set(false);
          this.#dialogRef.disableClose = false;
          this.#notify(
            templateErrorMessage(error, 'Could not save the template'),
            'error',
          );
        },
      });
  }

  #notify(message: string, type: 'info' | 'error') {
    this.#notificationService.open({
      message,
      action: 'Close',
      type,
      durantion: 5000,
    });
  }
}
