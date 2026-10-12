import {
  DOCUMENT,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { DefaultUrlSerializer, Router } from '@angular/router';
import { Store } from '@ngrx/store';
import { AuthUserModel, defaultUserSettings } from '@tapiz/board-commons';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalStore } from '../../../+state/global.store';
import { AuthApiService } from '../../../services/auth-api.service';
import { AuthService } from '../../../services/auth.service';
import { ConfigService } from '../../../services/config.service';
import { NotificationService } from '../../../shared/notification/notification.service';
import { WsService } from './ws.service';

type Handler = (...args: unknown[]) => void;

const socket = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  active: false,
  connected: false,
  on(event: string, handler: Handler) {
    this.handlers.set(event, handler);
  },
  emit: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(),
}));

vi.mock('socket.io-client', () => ({ io: () => socket }));

describe('WsService', () => {
  const guest: AuthUserModel = {
    id: 'guest-1',
    name: 'Ana',
    picture: '',
    isGuest: true,
    email: null,
    emailVerified: false,
    settings: defaultUserSettings,
  };
  const user = signal<AuthUserModel | null>(guest);
  const serializer = new DefaultUrlSerializer();
  let refresh: ReturnType<typeof vi.fn>;
  let boardLink: ReturnType<typeof vi.fn>;
  let reload: ReturnType<typeof vi.fn>;
  let setWsConnectionLost: ReturnType<typeof vi.fn>;
  let router: {
    url: string;
    navigate: ReturnType<typeof vi.fn>;
    navigateByUrl: ReturnType<typeof vi.fn>;
    parseUrl: (url: string) => ReturnType<DefaultUrlSerializer['parse']>;
    createUrlTree: (commands: string[], extras?: object) => unknown;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    socket.handlers.clear();
    socket.connect.mockClear();
    user.set(guest);
    localStorage.clear();
    refresh = vi.fn();
    boardLink = vi.fn(() => of({ name: 'Retro' }));
    reload = vi.fn();
    setWsConnectionLost = vi.fn();
    router = {
      url: '/board/board-1?nodeId=n1',
      navigate: vi.fn(),
      navigateByUrl: vi.fn(),
      parseUrl: (url) => serializer.parse(url),
      // flattened so the redirects are easy to assert
      createUrlTree: (commands, extras) => ({ commands, extras }),
    };

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: Router, useValue: router },
        { provide: DOCUMENT, useValue: { location: { reload } } },
        {
          provide: Store,
          useValue: { selectSignal: () => user, dispatch: vi.fn() },
        },
        { provide: ConfigService, useValue: { config: { WS_URL: '' } } },
        { provide: NotificationService, useValue: { open: vi.fn() } },
        { provide: GlobalStore, useValue: { setWsConnectionLost } },
        { provide: AuthService, useValue: { refresh } },
        { provide: AuthApiService, useValue: { boardLink } },
      ],
    });

    TestBed.inject(WsService);
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  async function trigger(event: string, ...args: unknown[]) {
    socket.handlers.get(event)?.(...args);

    // let refresh() and the redirect settle
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  }

  it('sends a guest whose session ended back to the join page', async () => {
    refresh.mockResolvedValue(null);

    await trigger('auth_error', 'session_ended');

    expect(boardLink).toHaveBeenCalledWith('board-1');
    expect(router.navigateByUrl).toHaveBeenCalledWith({
      commands: ['/join', 'board-1'],
      extras: { queryParams: { returnUrl: '/board/board-1?nodeId=n1' } },
    });
    expect(localStorage.getItem('tapiz.guestNameHint')).toBe('Ana');
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it('sends to login when the board is no longer shared', async () => {
    refresh.mockResolvedValue(null);
    boardLink.mockReturnValue(
      throwError(() => new HttpErrorResponse({ status: 404 })),
    );

    await trigger('auth_error', 'session_ended');

    const [urlTree] = router.navigateByUrl.mock.calls[0];

    expect(urlTree).toEqual({
      commands: ['/login'],
      extras: {
        queryParams: {
          returnUrl: '/board/board-1?nodeId=n1',
          reason: 'not-shared',
        },
      },
    });
  });

  it('handles auth_error and the following disconnect once', async () => {
    refresh.mockResolvedValue(null);

    socket.handlers.get('auth_error')?.('session_ended');
    await trigger('disconnect', 'io server disconnect');

    expect(refresh).toHaveBeenCalledOnce();
    expect(router.navigateByUrl).toHaveBeenCalledOnce();
  });

  it('reloads when another user signed in meanwhile', async () => {
    refresh.mockResolvedValue({ ...guest, id: 'user-2', isGuest: false });

    await trigger('auth_error', 'session_ended');

    expect(reload).toHaveBeenCalledOnce();
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });

  it('reconnects when the session is still valid', async () => {
    refresh.mockResolvedValue(guest);

    await trigger('disconnect', 'io server disconnect');

    expect(socket.connect).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });

  it('keeps the session when the api is unreachable', async () => {
    refresh.mockRejectedValue(new Error('offline'));

    await trigger('auth_error', 'session_ended');

    expect(setWsConnectionLost).toHaveBeenCalledWith(true);
    expect(socket.connect).toHaveBeenCalledOnce();
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });

  it('ignores disconnects started by the client', () => {
    socket.handlers.get('disconnect')?.('io client disconnect');

    expect(refresh).not.toHaveBeenCalled();
  });

  it('sends guests denied by a board to its join page', () => {
    socket.handlers.get('error')?.('unauthorized');

    expect(router.navigate).toHaveBeenCalledWith(['/join', 'board-1'], {
      queryParams: { returnUrl: '/board/board-1?nodeId=n1' },
    });
  });

  it('sends accounts denied by a board to 404', () => {
    user.set({ ...guest, isGuest: false });

    socket.handlers.get('error')?.('unauthorized');

    expect(router.navigate).toHaveBeenCalledWith(['/404']);
  });

  it('resolves the redirect without a board', async () => {
    refresh.mockResolvedValue(null);
    router.url = '/settings';

    await trigger('auth_error', 'session_ended');

    expect(boardLink).not.toHaveBeenCalled();
    expect(router.navigateByUrl).toHaveBeenCalledWith({
      commands: ['/login'],
      extras: { queryParams: { returnUrl: '/settings' } },
    });
  });
});
