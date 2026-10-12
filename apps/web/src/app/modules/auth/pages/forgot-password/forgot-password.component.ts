import {
  ChangeDetectionStrategy,
  Component,
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
import { authErrorMessage } from '../../auth-errors';

@Component({
  selector: 'tapiz-forgot-password',
  template: `
    <tapiz-auth-layout heading="Reset your password">
      <div class="content">
        @if (sent()) {
          <p role="status">
            If an account exists for that email, we sent a link to reset your
            password. The link expires in one hour.
          </p>
        } @else {
          <p>Enter your email and we'll send you a link to reset it.</p>

          <form
            [formGroup]="form"
            (ngSubmit)="submit()">
            <mat-form-field>
              <mat-label>Email</mat-label>
              <input
                matInput
                type="email"
                formControlName="email"
                autocomplete="email"
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
              Send reset link
            </button>
          </form>
        }

        <div class="links">
          <a routerLink="/login">Back to sign in</a>
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
export class ForgotPasswordComponent {
  #authApiService = inject(AuthApiService);

  loading = signal(false);
  sent = signal(false);
  error = signal<string | null>(null);
  form = new FormGroup({
    email: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.email],
    }),
  });

  submit() {
    if (this.form.invalid || this.loading()) {
      this.form.markAllAsTouched();
      return;
    }

    this.loading.set(true);
    this.error.set(null);

    this.#authApiService
      .requestReset({ email: this.form.controls.email.value.trim() })
      .subscribe({
        next: () => this.sent.set(true),
        error: (error) => {
          this.loading.set(false);
          this.error.set(authErrorMessage(error));
        },
      });
  }
}
