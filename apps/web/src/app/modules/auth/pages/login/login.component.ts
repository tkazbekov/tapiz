import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  computed,
  inject,
  input,
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
import { Store } from '@ngrx/store';
import { appFeature } from '../../../../+state/app.reducer';
import { AuthApiService } from '../../../../services/auth-api.service';
import { safeReturnUrl } from '../../../../utils/safe-return-url';
import { AuthLayoutComponent } from '../../components/auth-layout/auth-layout.component';
import { authErrorMessage } from '../../auth-errors';

@Component({
  selector: 'tapiz-login',
  template: `
    <tapiz-auth-layout heading="Sign in">
      <div class="content">
        <p>
          Welcome to Tapiz! The free Open Source Tool designed for effortless
          and productive meetings, retrospectives, and brainstorming.
        </p>

        @if (guestName(); as name) {
          <p class="notice">
            You're using Tapiz as a guest. Your guest notes stay under "{{
              name
            }}".
          </p>
        }

        <form
          [formGroup]="form"
          (ngSubmit)="submit()">
          <mat-form-field>
            <mat-label>Email</mat-label>
            <input
              matInput
              type="email"
              formControlName="email"
              autocomplete="username"
              required />
          </mat-form-field>

          <mat-form-field>
            <mat-label>Password</mat-label>
            <input
              matInput
              type="password"
              formControlName="password"
              autocomplete="current-password"
              required />
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
            Sign in
          </button>
        </form>

        <div class="links">
          <a routerLink="/forgot-password">Forgot password?</a>
          <a
            routerLink="/register"
            [queryParams]="{ returnUrl: returnUrl() }">
            Create account
          </a>
        </div>
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
export class LoginComponent {
  #authApiService = inject(AuthApiService);
  #document = inject(DOCUMENT);
  #user = inject(Store).selectSignal(appFeature.selectUser);

  returnUrl = input<string>();
  loading = signal(false);
  error = signal<string | null>(null);

  form = new FormGroup({
    email: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.email],
    }),
    password: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
  });

  guestName = computed(() => {
    const user = this.#user();

    return user?.isGuest ? user.name : null;
  });

  submit() {
    if (this.form.invalid || this.loading()) {
      this.form.markAllAsTouched();
      return;
    }

    const { email, password } = this.form.getRawValue();

    this.loading.set(true);
    this.error.set(null);

    this.#authApiService.login({ email: email.trim(), password }).subscribe({
      next: () => {
        // a different user may have been loaded, start from a clean page
        this.#document.location.assign(safeReturnUrl(this.returnUrl()));
      },
      error: (error) => {
        this.loading.set(false);
        this.error.set(
          authErrorMessage(error, {
            INVALID_CREDENTIALS: 'Incorrect email or password.',
          }),
        );
      },
    });
  }
}
