import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { Store } from '@ngrx/store';
import { appFeature } from '../../../../+state/app.reducer';
import { AuthApiService } from '../../../../services/auth-api.service';
import { AuthService } from '../../../../services/auth.service';
import { AuthLayoutComponent } from '../../components/auth-layout/auth-layout.component';
import { authErrorCode, authErrorMessage } from '../../auth-errors';
import { takeHashToken } from '../../hash-token';

type VerifyState = 'verifying' | 'verified' | 'invalid' | 'error';

@Component({
  selector: 'tapiz-verify-email',
  template: `
    <tapiz-auth-layout heading="Verify your email">
      <div class="content">
        @switch (state()) {
          @case ('verifying') {
            <p role="status">Verifying your email…</p>
          }
          @case ('verified') {
            <p role="status">Your email is verified.</p>
            <div class="links">
              <a routerLink="/">Continue to Tapiz</a>
            </div>
          }
          @default {
            <p
              class="error"
              role="alert">
              {{ error() }}
            </p>

            @if (canResend()) {
              <button
                mat-flat-button
                color="primary"
                type="button"
                [disabled]="resend() !== 'idle'"
                (click)="resendEmail()">
                {{ resend() === 'sent' ? 'Email sent' : 'Send a new link' }}
              </button>
            } @else if (!user()) {
              <div class="links">
                <a routerLink="/login">Sign in to get a new link</a>
              </div>
            }
          }
        }
      </div>
    </tapiz-auth-layout>
  `,
  styleUrl: '../../auth-form.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatButtonModule, AuthLayoutComponent],
})
export class VerifyEmailComponent implements OnInit {
  #authApiService = inject(AuthApiService);
  #authService = inject(AuthService);

  readonly token = takeHashToken(inject(DOCUMENT));
  user = inject(Store).selectSignal(appFeature.selectUser);
  state = signal<VerifyState>(this.token ? 'verifying' : 'invalid');
  error = signal('This verification link is invalid or has expired.');
  resend = signal<'idle' | 'sending' | 'sent'>('idle');
  canResend = computed(() => {
    const user = this.user();

    return !!user && !user.isGuest && !user.emailVerified;
  });

  ngOnInit() {
    if (!this.token) {
      return;
    }

    this.#authApiService.verifyEmail({ token: this.token }).subscribe({
      next: ({ user }) => {
        // the link may have been opened while signed in as someone else
        if (this.user()?.id === user.id) {
          this.#authService.setUser(user);
        }

        this.state.set('verified');
      },
      error: (error) => {
        if (authErrorCode(error) === 'INVALID_OR_EXPIRED_TOKEN') {
          this.state.set('invalid');
          return;
        }

        this.error.set(authErrorMessage(error));
        this.state.set('error');
      },
    });
  }

  resendEmail() {
    this.resend.set('sending');

    this.#authService.resendVerification().then(
      () => this.resend.set('sent'),
      (error) => {
        this.resend.set('idle');
        this.error.set(authErrorMessage(error));
      },
    );
  }
}
