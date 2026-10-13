import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { Store } from '@ngrx/store';
import { AuthUserModel, defaultUserSettings } from '@tapiz/board-commons';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiService } from '../../../../services/auth-api.service';
import { AuthService } from '../../../../services/auth.service';
import { VerifyEmailComponent } from './verify-email.component';

describe('VerifyEmailComponent', () => {
  const account: AuthUserModel = {
    id: 'user-1',
    name: 'Ada',
    picture: '',
    isGuest: false,
    email: 'ada@example.com',
    emailVerified: false,
    settings: defaultUserSettings,
  };
  const user = signal<AuthUserModel | null>(null);
  let verifyEmail: ReturnType<typeof vi.fn>;
  let setUser: ReturnType<typeof vi.fn>;
  let navigate: ReturnType<typeof vi.fn>;
  const pendingKey = 'tapiz.verifyEmailToken';

  const rejectWith = (status: number, error: string) =>
    throwError(() => new HttpErrorResponse({ status, error: { error } }));

  beforeEach(() => {
    user.set(account);
    sessionStorage.clear();
    navigate = vi.fn(() => Promise.resolve(true));
    verifyEmail = vi.fn(() =>
      of({ user: { ...account, emailVerified: true } }),
    );
    setUser = vi.fn();

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: Store, useValue: { selectSignal: () => user } },
        { provide: AuthApiService, useValue: { verifyEmail } },
        { provide: AuthService, useValue: { setUser } },
        { provide: Router, useValue: { navigate } },
      ],
    });
  });

  afterEach(() => {
    history.replaceState(null, '', '/');
    sessionStorage.clear();
  });

  function create() {
    const component = TestBed.runInInjectionContext(
      () => new VerifyEmailComponent(),
    );

    component.ngOnInit();

    return component;
  }

  it('strips the token from the address bar and verifies it', () => {
    history.replaceState(null, '', '/verify-email#token=abc');

    const component = create();

    expect(location.hash).toBe('');
    expect(location.pathname).toBe('/verify-email');
    expect(verifyEmail).toHaveBeenCalledWith({ token: 'abc' });
    expect(component.state()).toBe('verified');
    expect(setUser).toHaveBeenCalledWith({ ...account, emailVerified: true });
    expect(sessionStorage.getItem(pendingKey)).toBeNull();
  });

  for (const [who, signedIn] of [
    ['signed out visitors', null],
    ['guests', { ...account, isGuest: true, email: null }],
  ] as const) {
    it(`sends ${who} to sign in, keeping the token out of the url`, () => {
      history.replaceState(null, '', '/verify-email#token=abc');
      user.set(signedIn);

      create();

      expect(verifyEmail).not.toHaveBeenCalled();
      expect(location.hash).toBe('');
      expect(navigate).toHaveBeenCalledWith(['/login'], {
        queryParams: { returnUrl: '/verify-email' },
      });
      expect(sessionStorage.getItem(pendingKey)).toBe('abc');
    });
  }

  it('verifies the kept token after signing in, then forgets it', () => {
    history.replaceState(null, '', '/verify-email');
    sessionStorage.setItem(pendingKey, 'abc');

    const component = create();

    expect(verifyEmail).toHaveBeenCalledWith({ token: 'abc' });
    expect(component.state()).toBe('verified');
    expect(sessionStorage.getItem(pendingKey)).toBeNull();
  });

  it('keeps the token when signed in to another account', () => {
    history.replaceState(null, '', '/verify-email#token=abc');
    verifyEmail.mockReturnValueOnce(rejectWith(401, 'LOGIN_REQUIRED'));

    const component = create();

    expect(component.state()).toBe('wrong-account');
    expect(setUser).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(pendingKey)).toBe('abc');
  });

  it('shows an invalid link without calling the API when there is no token', () => {
    history.replaceState(null, '', '/verify-email');

    const component = create();

    expect(verifyEmail).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(component.state()).toBe('invalid');
  });

  it('offers a new link to unverified accounts when the token expired', () => {
    history.replaceState(null, '', '/verify-email#token=abc');
    verifyEmail.mockReturnValueOnce(
      rejectWith(400, 'INVALID_OR_EXPIRED_TOKEN'),
    );

    const component = create();

    expect(component.state()).toBe('invalid');
    expect(component.canResend()).toBe(true);
    expect(sessionStorage.getItem(pendingKey)).toBeNull();
  });
});
