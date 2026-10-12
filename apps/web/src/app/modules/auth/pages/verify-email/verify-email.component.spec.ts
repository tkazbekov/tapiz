import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
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

  beforeEach(() => {
    user.set(null);
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
      ],
    });
  });

  afterEach(() => {
    history.replaceState(null, '', '/');
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
  });

  it('updates the signed-in user when it is the verified account', () => {
    history.replaceState(null, '', '/verify-email#token=abc');
    user.set(account);

    create();

    expect(setUser).toHaveBeenCalledWith({ ...account, emailVerified: true });
  });

  it('leaves another signed-in user alone', () => {
    history.replaceState(null, '', '/verify-email#token=abc');
    user.set({ ...account, id: 'user-2' });

    create();

    expect(setUser).not.toHaveBeenCalled();
  });

  it('shows an invalid link without calling the API when there is no token', () => {
    history.replaceState(null, '', '/verify-email');

    const component = create();

    expect(verifyEmail).not.toHaveBeenCalled();
    expect(component.state()).toBe('invalid');
  });

  it('offers a new link to unverified accounts when the token expired', () => {
    history.replaceState(null, '', '/verify-email#token=abc');
    user.set(account);
    verifyEmail.mockReturnValueOnce(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 400,
            error: { error: 'INVALID_OR_EXPIRED_TOKEN' },
          }),
      ),
    );

    const component = create();

    expect(component.state()).toBe('invalid');
    expect(component.canResend()).toBe(true);
  });
});
