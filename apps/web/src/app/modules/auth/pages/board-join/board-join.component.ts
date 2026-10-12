import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Store } from '@ngrx/store';
import { appFeature } from '../../../../+state/app.reducer';
import { AuthApiService } from '../../../../services/auth-api.service';
import { AuthService } from '../../../../services/auth.service';
import { safeReturnUrl } from '../../../../utils/safe-return-url';
import { AuthLayoutComponent } from '../../components/auth-layout/auth-layout.component';
import { authErrorMessage } from '../../auth-errors';
import { readGuestNameHint, writeGuestNameHint } from '../../guest-name-hint';

type JoinState = 'loading' | 'open' | 'not-shared' | 'error';

function hasStatus(error: unknown, status: number) {
  return error instanceof HttpErrorResponse && error.status === status;
}

@Component({
  selector: 'tapiz-board-join',
  template: `
    <tapiz-auth-layout heading="Join board">
      <div class="content">
        @switch (state()) {
          @case ('loading') {
            <p role="status">Loading board…</p>
          }
          @case ('open') {
            <p>
              You were invited to
              <strong class="board-name">{{ boardName() }}</strong
              >. Anyone with the link can join, no account needed.
            </p>

            <form
              [formGroup]="form"
              (ngSubmit)="submit()">
              @if (guestName(); as name) {
                <p class="notice">You're joining as {{ name }} (guest).</p>
              } @else {
                <mat-form-field>
                  <mat-label>Your name</mat-label>
                  <input
                    matInput
                    type="text"
                    formControlName="name"
                    autocomplete="nickname"
                    maxlength="64"
                    required />
                  <mat-hint>Shown to others on the board</mat-hint>
                </mat-form-field>
              }

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
                Join board
              </button>
            </form>
          }
          @case ('not-shared') {
            <p
              class="notice"
              role="alert">
              This board isn't shared by link. Sign in with an account that has
              access to open it.
            </p>
          }
          @case ('error') {
            <p
              class="error"
              role="alert">
              {{ error() }}
            </p>
            <button
              mat-flat-button
              color="primary"
              type="button"
              (click)="load()">
              Try again
            </button>
          }
        }

        <div class="links">
          <a
            routerLink="/login"
            [queryParams]="{ returnUrl: returnUrl }">
            Sign in
          </a>
          <a
            routerLink="/register"
            [queryParams]="{ returnUrl: returnUrl }">
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
export class BoardJoinComponent implements OnInit {
  #authApiService = inject(AuthApiService);
  #authService = inject(AuthService);
  #router = inject(Router);
  #route = inject(ActivatedRoute);
  #user = inject(Store).selectSignal(appFeature.selectUser);

  readonly boardId = this.#route.snapshot.paramMap.get('boardId') ?? '';
  readonly returnUrl = safeReturnUrl(
    this.#route.snapshot.queryParamMap.get('returnUrl'),
    `/board/${this.boardId}`,
  );

  state = signal<JoinState>('loading');
  boardName = signal('');
  loading = signal(false);
  error = signal<string | null>(null);
  // a guest whose board was unshared lands here too, it keeps its identity
  guestName = computed(() => {
    const user = this.#user();

    return user?.isGuest ? user.name : null;
  });

  form = new FormGroup({
    name: new FormControl(readGuestNameHint(), {
      nonNullable: true,
      validators: [
        Validators.required,
        Validators.maxLength(64),
        Validators.pattern(/\S/),
      ],
    }),
  });

  ngOnInit() {
    const user = this.#user();

    // accounts don't need a guest identity, the board decides their access
    if (user && !user.isGuest) {
      void this.#router.navigateByUrl(this.returnUrl);
      return;
    }

    this.load();
  }

  load() {
    this.state.set('loading');
    this.error.set(null);

    this.#authApiService.boardLink(this.boardId).subscribe({
      next: ({ name }) => {
        this.boardName.set(name);
        this.state.set('open');
      },
      error: (error) => {
        if (hasStatus(error, 404)) {
          this.state.set('not-shared');
          return;
        }

        this.error.set(authErrorMessage(error));
        this.state.set('error');
      },
    });
  }

  submit() {
    const guestName = this.guestName();

    if ((!guestName && this.form.invalid) || this.loading()) {
      this.form.markAllAsTouched();
      return;
    }

    const name = guestName ?? this.form.getRawValue().name.trim();

    this.loading.set(true);
    this.error.set(null);

    this.#authApiService
      .joinAsGuest({ name, boardId: this.boardId })
      .subscribe({
        next: ({ user }) => {
          writeGuestNameHint(user.name);
          // the socket connects once the user is in the store
          this.#authService.setUser(user);
          void this.#router.navigateByUrl(this.returnUrl);
        },
        error: (error) => {
          this.loading.set(false);

          if (hasStatus(error, 404)) {
            this.state.set('not-shared');
            return;
          }

          // signed in with an account meanwhile, e.g. in another tab
          if (hasStatus(error, 409)) {
            void this.#authService
              .refresh()
              .catch(() => null)
              .then(() => this.#router.navigateByUrl(this.returnUrl));
            return;
          }

          this.error.set(authErrorMessage(error));
        },
      });
  }
}
