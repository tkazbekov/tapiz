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
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Store } from '@ngrx/store';
import { appFeature } from '../../../../+state/app.reducer';
import { AuthApiService } from '../../../../services/auth-api.service';
import { AuthService } from '../../../../services/auth.service';
import { safeReturnUrl } from '../../../../utils/safe-return-url';
import { AuthLayoutComponent } from '../../components/auth-layout/auth-layout.component';
import { authErrorCode, authErrorMessage } from '../../auth-errors';

@Component({
  selector: 'tapiz-register',
  template: `
    <tapiz-auth-layout heading="Create account">
      <div class="content">
        @if (guestName(); as name) {
          <p class="notice">
            You're a guest ({{ name }}). Create an account to get your own
            boards; your guest work stays yours.
          </p>
        }

        <form
          [formGroup]="form"
          (ngSubmit)="submit()">
          <mat-form-field>
            <mat-label>Name</mat-label>
            <input
              matInput
              type="text"
              formControlName="name"
              autocomplete="name"
              maxlength="64"
              required />
          </mat-form-field>

          <mat-form-field>
            <mat-label>Email</mat-label>
            <input
              matInput
              type="email"
              formControlName="email"
              autocomplete="email"
              maxlength="320"
              required />
          </mat-form-field>

          <mat-form-field>
            <mat-label>Password</mat-label>
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
              @if (emailTaken()) {
                <a
                  routerLink="/login"
                  [queryParams]="{ returnUrl: returnUrl() }">
                  Sign in instead
                </a>
              }
            </p>
          }

          <button
            mat-flat-button
            color="primary"
            type="submit"
            [disabled]="loading()">
            Create account
          </button>
        </form>

        <div class="links">
          <a
            routerLink="/login"
            [queryParams]="{ returnUrl: returnUrl() }">
            Already have an account? Sign in
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
export class RegisterComponent {
  #authApiService = inject(AuthApiService);
  #authService = inject(AuthService);
  #router = inject(Router);
  #document = inject(DOCUMENT);
  #user = inject(Store).selectSignal(appFeature.selectUser);

  returnUrl = input<string>();
  loading = signal(false);
  error = signal<string | null>(null);
  emailTaken = signal(false);
  guestName = computed(() => {
    const user = this.#user();

    return user?.isGuest ? user.name : null;
  });

  form = new FormGroup({
    name: new FormControl(this.guestName() ?? '', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(64)],
    }),
    email: new FormControl('', {
      nonNullable: true,
      validators: [
        Validators.required,
        Validators.email,
        Validators.maxLength(320),
      ],
    }),
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
    if (this.form.invalid || this.loading()) {
      this.form.markAllAsTouched();
      return;
    }

    const { name, email, password } = this.form.getRawValue();
    const wasGuest = !!this.guestName();
    const returnUrl = safeReturnUrl(this.returnUrl());

    this.loading.set(true);
    this.error.set(null);
    this.emailTaken.set(false);

    this.#authApiService
      .register({ name: name.trim(), email: email.trim(), password })
      .subscribe({
        next: ({ user }) => {
          if (wasGuest) {
            // upgraded in place: same id, the open sockets stay valid
            this.#authService.setUser(user);
            void this.#router.navigateByUrl(returnUrl);
            return;
          }

          this.#document.location.assign(returnUrl);
        },
        error: (error) => {
          this.loading.set(false);

          if (authErrorCode(error) === 'ALREADY_SIGNED_IN') {
            this.#document.location.assign('/');
            return;
          }

          this.emailTaken.set(authErrorCode(error) === 'EMAIL_TAKEN');
          this.error.set(
            authErrorMessage(error, {
              EMAIL_TAKEN: 'An account with this email already exists.',
            }),
          );
        },
      });
  }
}
