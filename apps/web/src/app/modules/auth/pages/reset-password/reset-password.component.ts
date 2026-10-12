import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  inject,
  signal,
} from '@angular/core';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { AuthApiService } from '../../../../services/auth-api.service';
import { AuthLayoutComponent } from '../../components/auth-layout/auth-layout.component';
import { authErrorCode, authErrorMessage } from '../../auth-errors';
import { takeHashToken } from '../../hash-token';
import { WsService } from '../../../ws/services/ws.service';
import { Store } from '@ngrx/store';
import { appFeature } from '../../../../+state/app.reducer';

@Component({
  selector: 'tapiz-reset-password',
  template: `
    <tapiz-auth-layout heading="Choose a new password">
      <div class="content">
        @if (token && !invalidToken()) {
          <form
            [formGroup]="form"
            (ngSubmit)="submit()">
            <mat-form-field>
              <mat-label>New password</mat-label>
              <input
                matInput
                type="password"
                formControlName="password"
                autocomplete="new-password"
                minlength="8"
                maxlength="128"
                required />
              <mat-hint>At least 8 characters</mat-hint>
            </mat-form-field>

            @if (error()) {
              <p
                class="error"
                role="alert">
                {{ error() }}
              </p>
            }

            <button
              mat-flat-button
              color="primary"
              type="submit"
              [disabled]="loading()">
              Set password
            </button>
          </form>
        } @else {
          <p
            class="error"
            role="alert">
            This reset link is invalid or has expired.
          </p>
          <div class="links">
            <a routerLink="/forgot-password">Request a new link</a>
          </div>
        }
      </div>
    </tapiz-auth-layout>
  `,
  styleUrl: '../../auth-form.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    AuthLayoutComponent,
  ],
})
export class ResetPasswordComponent {
  #authApiService = inject(AuthApiService);
  #document = inject(DOCUMENT);
  #wsService = inject(WsService);
  #userId = inject(Store).selectSignal(appFeature.selectUserId);

  readonly token = takeHashToken(this.#document);
  loading = signal(false);
  invalidToken = signal(false);
  error = signal<string | null>(null);
  form = new FormGroup({
    password: new FormControl('', {
      nonNullable: true,
      validators: [
        Validators.required,
        Validators.minLength(8),
        Validators.maxLength(128),
      ],
    }),
  });

  submit() {
    if (!this.token || this.form.invalid || this.loading()) {
      this.form.markAllAsTouched();
      return;
    }

    this.loading.set(true);
    this.error.set(null);

    // the reset ends the current session and disconnects its socket; close
    // it first so the session check that follows can't clear the new cookie
    this.#wsService.close();

    this.#authApiService
      .confirmReset({
        token: this.token,
        password: this.form.controls.password.value,
      })
      .subscribe({
        next: () => {
          // the reset signs the account in and ends its other sessions
          this.#document.location.assign('/');
        },
        error: (error) => {
          this.loading.set(false);

          // as app.component does, a socket only runs while signed in
          if (this.#userId()) {
            this.#wsService.listen();
          }

          if (authErrorCode(error) === 'INVALID_OR_EXPIRED_TOKEN') {
            this.invalidToken.set(true);
            return;
          }

          this.error.set(authErrorMessage(error));
        },
      });
  }
}
