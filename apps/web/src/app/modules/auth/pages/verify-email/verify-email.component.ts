import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { Store } from '@ngrx/store';
import { appFeature } from '../../../../+state/app.reducer';
import { AuthApiService } from '../../../../services/auth-api.service';
import { AuthService } from '../../../../services/auth.service';
import { AuthLayoutComponent } from '../../components/auth-layout/auth-layout.component';
import { authErrorCode, authErrorMessage } from '../../auth-errors';
import { takeHashToken } from '../../hash-token';

type VerifyState =
  'verifying' | 'verified' | 'wrong-account' | 'invalid' | 'error';

// The link only works signed in to the account it was sent for. Its token
// waits here (this tab only, never in a URL) while the visitor signs in.
const pendingTokenKey = 'tapiz.verifyEmailToken';
const returnUrl = '/verify-email';

function readPendingToken(): string | null {
  try {
    return sessionStorage.getItem(pendingTokenKey);
  } catch {
    // storage can be blocked
    return null;
  }
}

function writePendingToken(token: string) {
  try {
    sessionStorage.setItem(pendingTokenKey, token);
  } catch {
    // storage can be blocked
  }
}

function clearPendingToken() {
  try {
    sessionStorage.removeItem(pendingTokenKey);
  } catch {
    // storage can be blocked
  }
}

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
          @case ('wrong-account') {
            <p
              class="error"
              role="alert">
              This link is for another account. Sign in to the account that was
              created with this email to verify it.
            </p>
            <div class="links">
              <a
                routerLink="/login"
                [queryParams]="{ returnUrl }"
                >Sign in to another account</a
              >
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
  #router = inject(Router);

  readonly returnUrl = returnUrl;
  readonly token = takeHashToken(inject(DOCUMENT)) ?? readPendingToken();
  user = inject(Store).selectSignal(appFeature.selectUser);
  state = signal<VerifyState>(this.token ? 'verifying' : 'invalid');
  error = signal('This verification link is invalid or has expired.');
  resend = signal<'idle' | 'sending' | 'sent'>('idle');
  canResend = computed(() => {
    const user = this.user();

    return !!user && !user.isGuest && !user.emailVerified;
  });

  ngOnInit() {
    const token = this.token;

    if (!token) {
      return;
    }

    const user = this.user();

    if (!user || user.isGuest) {
      writePendingToken(token);
      void this.#router.navigate(['/login'], { queryParams: { returnUrl } });
      return;
    }

    this.#authApiService.verifyEmail({ token }).subscribe({
      next: ({ user }) => {
        clearPendingToken();
        this.#authService.setUser(user);
        this.state.set('verified');
      },
      error: (error) => {
        const code = authErrorCode(error);

        // signed in to another account: keep the link for the next sign in
        if (code === 'LOGIN_REQUIRED') {
          writePendingToken(token);
          this.state.set('wrong-account');
          return;
        }

        clearPendingToken();

        if (code === 'INVALID_OR_EXPIRED_TOKEN') {
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
