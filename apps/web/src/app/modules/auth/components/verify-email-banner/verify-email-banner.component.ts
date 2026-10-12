import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Store } from '@ngrx/store';
import { appFeature } from '../../../../+state/app.reducer';
import { AuthService } from '../../../../services/auth.service';
import { authErrorMessage } from '../../auth-errors';

const DISMISSED_KEY = 'tapiz.verifyEmailBannerDismissed';

@Component({
  selector: 'tapiz-verify-email-banner',
  template: `
    @if (visible()) {
      <div
        class="banner"
        role="status">
        <mat-icon>mark_email_unread</mat-icon>
        <span class="text">
          Verify your email to receive team invites. We sent a link to
          {{ email() }}.
        </span>
        <button
          mat-button
          type="button"
          [disabled]="resend() !== 'idle'"
          (click)="resendEmail()">
          {{ resend() === 'sent' ? 'Email sent' : 'Resend' }}
        </button>
        <button
          mat-icon-button
          type="button"
          aria-label="Dismiss"
          (click)="dismiss()">
          <mat-icon>close</mat-icon>
        </button>
      </div>
    }
  `,
  styles: `
    .banner {
      align-items: center;
      background: var(--grey-10);
      border-block-end: 1px solid var(--grey-30);
      display: flex;
      gap: var(--spacing-3);
      padding: var(--spacing-1) var(--spacing-4);
      font-size: var(--font-size-14);
    }

    .text {
      flex: 1;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule],
})
export class VerifyEmailBannerComponent {
  #authService = inject(AuthService);
  #snackBar = inject(MatSnackBar);
  #user = inject(Store).selectSignal(appFeature.selectUser);

  dismissed = signal(readDismissed());
  resend = signal<'idle' | 'sending' | 'sent'>('idle');
  email = computed(() => this.#user()?.email ?? '');
  visible = computed(() => {
    const user = this.#user();

    return !!user && !user.isGuest && !user.emailVerified && !this.dismissed();
  });

  resendEmail() {
    this.resend.set('sending');

    this.#authService.resendVerification().then(
      () => this.resend.set('sent'),
      (error) => {
        this.resend.set('idle');
        this.#snackBar.open(authErrorMessage(error), 'Close', {
          duration: 4000,
        });
      },
    );
  }

  dismiss() {
    this.dismissed.set(true);

    try {
      sessionStorage.setItem(DISMISSED_KEY, 'true');
    } catch {
      // storage can be blocked, the banner then only hides until reload
    }
  }
}

function readDismissed() {
  try {
    return sessionStorage.getItem(DISMISSED_KEY) === 'true';
  } catch {
    return false;
  }
}
