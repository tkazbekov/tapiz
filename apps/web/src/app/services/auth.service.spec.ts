import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Store } from '@ngrx/store';
import { AuthUserModel, defaultUserSettings } from '@tapiz/board-commons';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppActions } from '../+state/app.actions';
import { authInterceptor } from '../commons/api-rest-interceptor/api-rest-interceptor.service';
import { AuthService } from './auth.service';
import { ConfigService } from './config.service';

const API_URL = 'http://localhost:8000/api';

describe('AuthService', () => {
  const user: AuthUserModel = {
    id: 'user-1',
    name: 'Ada',
    picture: '',
    isGuest: false,
    email: 'ada@example.com',
    emailVerified: true,
    settings: defaultUserSettings,
  };
  const config = { API_URL, WS_URL: 'ws://localhost:8000', DEMO: false };
  let dispatch: ReturnType<typeof vi.fn>;
  let http: HttpTestingController;

  beforeEach(() => {
    config.DEMO = false;
    dispatch = vi.fn();
    localStorage.clear();

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        // the interceptor creates WsService, which reads the user
        {
          provide: Store,
          useValue: { dispatch, selectSignal: () => signal(null) },
        },
        { provide: ConfigService, useValue: { config } },
      ],
    });

    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
  });

  function expectSession() {
    const req = http.expectOne(`${API_URL}/auth/session`);

    expect(req.request.method).toEqual('GET');
    expect(req.request.withCredentials).toEqual(true);
    expect(req.request.headers.has('correlation-id')).toEqual(true);

    return req;
  }

  it('loads the session user and drops the legacy cached user', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 'stale' }));
    const bootstrap = TestBed.inject(AuthService).bootstrap();

    expectSession().flush({
      user: { ...user, settings: { wheelInputMode: 'mouse' } },
    });
    await bootstrap;

    expect(localStorage.getItem('user')).toBeNull();
    expect(dispatch).toHaveBeenCalledWith(
      AppActions.setUser({
        user: {
          ...user,
          settings: { ...defaultUserSettings, wheelInputMode: 'mouse' },
        },
      }),
    );
  });

  it('starts anonymous without a session', async () => {
    const bootstrap = TestBed.inject(AuthService).bootstrap();

    expectSession().flush({ user: null });
    await bootstrap;

    expect(dispatch).toHaveBeenCalledWith(AppActions.setUser({ user: null }));
  });

  it('never fails the app start when the API is unreachable', async () => {
    const bootstrap = TestBed.inject(AuthService).bootstrap();

    expectSession().error(new ProgressEvent('error'));

    await expect(bootstrap).resolves.toBeUndefined();
    expect(dispatch).toHaveBeenCalledWith(AppActions.setUser({ user: null }));
  });

  it('skips the session request in Demo', async () => {
    config.DEMO = true;

    await TestBed.inject(AuthService).bootstrap();

    http.expectNone(`${API_URL}/auth/session`);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('refresh returns and stores the current session user', async () => {
    const refresh = TestBed.inject(AuthService).refresh();

    expectSession().flush({ user });

    await expect(refresh).resolves.toEqual(user);
    expect(dispatch).toHaveBeenCalledWith(AppActions.setUser({ user }));
  });

  it('does not report a failed session check as unauthorized', async () => {
    const refresh = TestBed.inject(AuthService).refresh();

    expectSession().flush(null, { status: 401, statusText: 'Unauthorized' });

    await expect(refresh).rejects.toBeDefined();
    expect(dispatch).not.toHaveBeenCalledWith(AppActions.unauthorized());
  });

  it('refresh clears the user when the session ended', async () => {
    const refresh = TestBed.inject(AuthService).refresh();

    expectSession().flush({ user: null });

    await expect(refresh).resolves.toBeNull();
    expect(dispatch).toHaveBeenCalledWith(AppActions.setUser({ user: null }));
  });

  it('refreshes the user when a resend finds the email already verified', async () => {
    const resend = TestBed.inject(AuthService).resendVerification();

    const req = http.expectOne(`${API_URL}/auth/verify-email/resend`);
    expect(req.request.method).toEqual('POST');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await Promise.resolve();

    expectSession().flush({ user });
    await resend;

    expect(dispatch).toHaveBeenCalledWith(AppActions.setUser({ user }));
  });
});
