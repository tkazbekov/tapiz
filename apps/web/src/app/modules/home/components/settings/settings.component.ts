import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import {
  ReactiveFormsModule,
  FormControl,
  FormGroup,
  Validators,
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import {
  AuthUserModel,
  NoteFontFamily,
  UserSettings,
  defaultUserSettings,
  noteFontFamilyOptions,
  withDefaultUserSettings,
} from '@tapiz/board-commons';
import { ColorPickerComponent } from '@tapiz/ui/color-picker';
import { Store } from '@ngrx/store';
import { appFeature } from '../../../../+state/app.reducer';
import { UserApiService } from '../../../../services/user-api.service';
import { AppActions } from '../../../../+state/app.actions';
import { AuthApiService } from '../../../../services/auth-api.service';
import { WsService } from '../../../ws/services/ws.service';
import { finalize } from 'rxjs';
import { authErrorMessage } from '../../../auth/auth-errors';

@Component({
  selector: 'tapiz-settings',
  template: `
    <div class="settings-page">
      <header>
        <h1>Settings</h1>
      </header>

      <form
        [formGroup]="form"
        (ngSubmit)="save()">
        <section>
          <div class="section-header">
            <h2>New notes</h2>
          </div>

          <div class="settings-grid">
            <div
              class="fields"
              formGroupName="noteDefaults">
              <label>
                <span>Background</span>
                <tapiz-color-picker
                  [color]="
                    form.controls.noteDefaults.controls.backgroundColor.value
                  "
                  (changed)="updateBackgroundColor($event)" />
              </label>

              <label>
                <span>Text color</span>
                <tapiz-color-picker
                  [color]="form.controls.noteDefaults.controls.textColor.value"
                  (changed)="updateTextColor($event)" />
              </label>

              <mat-form-field>
                <mat-label>Font</mat-label>
                <mat-select formControlName="fontFamily">
                  @for (option of fontFamilyOptions; track option.value) {
                    <mat-option [value]="option.value">
                      {{ option.name }}
                    </mat-option>
                  }
                </mat-select>
              </mat-form-field>

              <mat-checkbox formControlName="bold">Bold</mat-checkbox>
              <mat-checkbox formControlName="italic">Italic</mat-checkbox>

              <button
                mat-stroked-button
                type="button"
                class="reset"
                (click)="resetNoteDefaults()">
                <mat-icon>restart_alt</mat-icon>
                Reset note
              </button>
            </div>

            <div
              class="note-preview"
              [style.background]="
                form.controls.noteDefaults.controls.backgroundColor.value
              "
              [style.color]="
                form.controls.noteDefaults.controls.textColor.value
              "
              [style.font-weight]="
                form.controls.noteDefaults.controls.bold.value ? 700 : 400
              "
              [style.font-style]="
                form.controls.noteDefaults.controls.italic.value
                  ? 'italic'
                  : 'normal'
              ">
              <p
                [style.font-family]="
                  form.controls.noteDefaults.controls.fontFamily.value
                ">
                Write the next step
              </p>
              <span>{{ user()?.name }}</span>
            </div>
          </div>
        </section>

        <section>
          <div class="section-header">
            <h2>API token</h2>
          </div>

          <div class="api-token">
            <div class="api-token-status">
              @if (generatedApiToken()) {
                <span>New token</span>
                <code>{{ generatedApiToken() }}</code>
              } @else if (apiTokenLoading()) {
                <span>Checking token</span>
              } @else if (apiTokenExists()) {
                <span>Token generated</span>
                <small>The token is hidden after reload.</small>
              } @else {
                <span>No token</span>
              }

              @if (tokenCopied()) {
                <small>Copied</small>
              }
            </div>

            <div class="api-token-actions">
              @if (generatedApiToken()) {
                <button
                  mat-stroked-button
                  type="button"
                  (click)="copyGeneratedToken()">
                  <mat-icon>content_copy</mat-icon>
                  Copy
                </button>
              }

              <button
                mat-stroked-button
                type="button"
                (click)="generateApiToken()">
                <mat-icon>{{ apiTokenExists() ? 'sync' : 'add' }}</mat-icon>
                {{ apiTokenExists() ? 'Regenerate' : 'Generate token' }}
              </button>
            </div>
          </div>
        </section>

        <div class="actions">
          @if (saved()) {
            <span class="saved">Saved</span>
          }

          <button
            mat-flat-button
            color="primary"
            type="submit">
            <mat-icon>save</mat-icon>
            Save
          </button>
        </div>
      </form>

      <form
        class="password-form"
        [formGroup]="passwordForm"
        (ngSubmit)="changePassword()">
        <section>
          <div class="section-header">
            <h2>Change password</h2>
          </div>

          <div class="password-fields">
            <!-- lets password managers match the saved credential -->
            <input
              type="email"
              autocomplete="username"
              [value]="user()?.email ?? ''"
              readonly
              hidden />

            <mat-form-field>
              <mat-label>Current password</mat-label>
              <input
                matInput
                type="password"
                formControlName="currentPassword"
                autocomplete="current-password"
                required />
            </mat-form-field>

            <mat-form-field>
              <mat-label>New password</mat-label>
              <input
                matInput
                type="password"
                formControlName="newPassword"
                autocomplete="new-password"
                minlength="8"
                maxlength="128"
                required />
              <mat-hint>At least 8 characters</mat-hint>
            </mat-form-field>

            @if (passwordError()) {
              <p
                class="password-error"
                role="alert">
                {{ passwordError() }}
              </p>
            }

            <div class="password-actions">
              @if (passwordChanged()) {
                <span
                  class="saved"
                  role="status">
                  Password changed. Other sessions were signed out.
                </span>
              }

              <button
                mat-stroked-button
                type="submit"
                [disabled]="passwordSaving()">
                Change password
              </button>
            </div>
          </div>
        </section>
      </form>
    </div>
  `,
  styleUrl: './settings.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    ColorPickerComponent,
  ],
})
export class SettingsComponent {
  #store = inject(Store);
  #userApiService = inject(UserApiService);
  #authApiService = inject(AuthApiService);
  #wsService = inject(WsService);

  user = this.#store.selectSignal(appFeature.selectUser);
  saved = signal(false);
  apiTokenLoading = signal(true);
  apiTokenInfo = signal<{ hasToken: boolean; createdAt: string | null } | null>(
    null,
  );
  generatedApiToken = signal<string | null>(null);
  tokenCopied = signal(false);
  apiTokenExists = computed(() => {
    return (
      (this.apiTokenInfo()?.hasToken ?? false) || !!this.generatedApiToken()
    );
  });
  fontFamilyOptions = noteFontFamilyOptions;
  passwordSaving = signal(false);
  passwordChanged = signal(false);
  passwordError = signal<string | null>(null);
  #formInitialized = false;

  form = new FormGroup({
    noteDefaults: new FormGroup({
      backgroundColor: new FormControl(
        defaultUserSettings.noteDefaults.backgroundColor,
        { nonNullable: true },
      ),
      textColor: new FormControl(defaultUserSettings.noteDefaults.textColor, {
        nonNullable: true,
      }),
      fontFamily: new FormControl<NoteFontFamily>(
        defaultUserSettings.noteDefaults.fontFamily,
        {
          nonNullable: true,
        },
      ),
      bold: new FormControl(defaultUserSettings.noteDefaults.bold, {
        nonNullable: true,
      }),
      italic: new FormControl(defaultUserSettings.noteDefaults.italic, {
        nonNullable: true,
      }),
    }),
  });

  passwordForm = new FormGroup({
    currentPassword: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    newPassword: new FormControl('', {
      nonNullable: true,
      validators: [
        Validators.required,
        Validators.minLength(8),
        Validators.maxLength(128),
      ],
    }),
  });

  constructor() {
    this.#userApiService.apiToken().subscribe((apiTokenInfo) => {
      this.apiTokenInfo.set(apiTokenInfo);
      this.apiTokenLoading.set(false);
    });

    effect(() => {
      const user = this.user();

      if (!user || this.#formInitialized) {
        return;
      }

      const settings = withDefaultUserSettings(user.settings);

      this.form.controls.noteDefaults.setValue(settings.noteDefaults);
      this.#formInitialized = true;
    });
  }

  updateBackgroundColor(color: string | undefined) {
    this.form.controls.noteDefaults.controls.backgroundColor.setValue(
      color ?? defaultUserSettings.noteDefaults.backgroundColor,
    );
  }

  updateTextColor(color: string | undefined) {
    this.form.controls.noteDefaults.controls.textColor.setValue(
      color ?? defaultUserSettings.noteDefaults.textColor,
    );
  }

  resetNoteDefaults() {
    this.form.controls.noteDefaults.setValue(defaultUserSettings.noteDefaults);
    this.saved.set(false);
  }

  generateApiToken() {
    this.#userApiService.generateApiToken().subscribe((apiToken) => {
      this.apiTokenInfo.set({
        hasToken: true,
        createdAt: apiToken.createdAt ?? null,
      });
      this.generatedApiToken.set(apiToken.token);
      this.tokenCopied.set(false);
    });
  }

  copyGeneratedToken() {
    const token = this.generatedApiToken();

    if (!token) {
      return;
    }

    void navigator.clipboard.writeText(token).then(() => {
      this.tokenCopied.set(true);
    });
  }

  save() {
    const currentUser = this.user();

    if (!currentUser) {
      return;
    }

    const settings: UserSettings = {
      ...withDefaultUserSettings(currentUser.settings),
      noteDefaults: this.form.controls.noteDefaults.getRawValue(),
    };

    this.#userApiService.updateSettings(settings).subscribe((savedSettings) => {
      const user: AuthUserModel = {
        ...currentUser,
        settings: savedSettings,
      };

      this.#store.dispatch(AppActions.setUser({ user }));
      this.saved.set(true);
    });
  }

  changePassword() {
    if (this.passwordForm.invalid || this.passwordSaving()) {
      this.passwordForm.markAllAsTouched();
      return;
    }

    this.passwordSaving.set(true);
    this.passwordChanged.set(false);
    this.passwordError.set(null);

    // The server rotates the session cookie and disconnects the sockets of
    // the old sessions. Close ours first and reconnect with the new cookie.
    this.#wsService.close();

    this.#authApiService
      .changePassword(this.passwordForm.getRawValue())
      .pipe(
        finalize(() => {
          this.passwordSaving.set(false);
          this.#wsService.listen();
        }),
      )
      .subscribe({
        next: () => {
          this.passwordForm.reset();
          this.passwordChanged.set(true);
          // the server revokes the personal API token with the password
          this.apiTokenInfo.set({ hasToken: false, createdAt: null });
          this.generatedApiToken.set(null);
        },
        error: (error) => {
          this.passwordError.set(
            authErrorMessage(error, {
              INVALID_CREDENTIALS: 'The current password is incorrect.',
            }),
          );
        },
      });
  }
}
