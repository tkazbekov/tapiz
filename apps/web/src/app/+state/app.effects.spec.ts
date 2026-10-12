import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { provideMockActions } from '@ngrx/effects/testing';
import { Action } from '@ngrx/store';
import { AuthUserModel, defaultUserSettings } from '@tapiz/board-commons';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiService } from '../services/auth-api.service';
import { AuthService } from '../services/auth.service';
import { AppActions } from './app.actions';
import { unauthorized$ } from './app.effects';

@Component({ template: '' })
class EmptyComponent {}

describe('unauthorized$', () => {
  const user: AuthUserModel = {
    id: 'user-1',
    name: 'Ana',
    picture: '',
    isGuest: false,
    email: 'ana@example.com',
    emailVerified: true,
    settings: defaultUserSettings,
  };
  let actions$: Subject<Action>;
  let refresh: ReturnType<typeof vi.fn>;
  let router: Router;

  beforeEach(() => {
    actions$ = new Subject<Action>();
    refresh = vi.fn();

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([{ path: '**', component: EmptyComponent }]),
        provideMockActions(() => actions$),
        { provide: AuthService, useValue: { refresh } },
        { provide: AuthApiService, useValue: {} },
      ],
    });

    router = TestBed.inject(Router);
  });

  async function run(url: string) {
    await router.navigateByUrl(url);

    const navigateByUrl = vi
      .spyOn(router, 'navigateByUrl')
      .mockResolvedValue(true);
    const subscription = TestBed.runInInjectionContext(() =>
      unauthorized$(),
    ).subscribe();

    actions$.next(AppActions.unauthorized());

    await vi.waitFor(() => {
      expect(navigateByUrl).toHaveBeenCalled();
    });

    subscription.unsubscribe();

    return router.serializeUrl(navigateByUrl.mock.calls[0][0] as never);
  }

  it('sends a guest refused on a board to its join page', async () => {
    refresh.mockResolvedValue({ ...user, isGuest: true, email: null });

    expect(await run('/board/board-1?nodeId=n1')).toBe(
      '/join/board-1?returnUrl=%2Fboard%2Fboard-1%3FnodeId%3Dn1',
    );
  });

  it('sends an account refused on a board to 404', async () => {
    refresh.mockResolvedValue(user);

    expect(await run('/board/board-1')).toBe('/404');
  });

  it('sends a guest refused elsewhere home', async () => {
    refresh.mockResolvedValue({ ...user, isGuest: true, email: null });

    expect(await run('/settings')).toBe('/');
  });
});
