import { DOCUMENT, Injectable, inject } from '@angular/core';
import { Store } from '@ngrx/store';
import { wsOpen } from '../ws.actions';
import { AuthUserModel, optimize } from '@tapiz/board-commons';
import { Router } from '@angular/router';
import customParser from 'socket.io-msgpack-parser';
import { NotificationService } from '../../../shared/notification/notification.service';
import { ConfigService } from '../../../services/config.service';

import { io } from 'socket.io-client';
import { uuid } from '@tapiz/utils/uuid';
import { BehaviorSubject, Subject } from 'rxjs';
import { GlobalStore } from '../../../+state/global.store';
import { appFeature } from '../../../+state/app.reducer';
import { AuthService } from '../../../services/auth.service';
import { AuthApiService } from '../../../services/auth-api.service';
import { signedOutRedirect } from '../../board/guards/board.guard';
import { writeGuestNameHint } from '../../auth/guest-name-hint';

@Injectable({
  providedIn: 'root',
})
export class WsService {
  #store = inject(Store);
  #configService = inject(ConfigService);
  #pool: unknown[] = [];
  #notificationService = inject(NotificationService);
  #router = inject(Router);
  #document = inject(DOCUMENT);
  #authService = inject(AuthService);
  #authApiService = inject(AuthApiService);
  #user = this.#store.selectSignal(appFeature.selectUser);
  #authCheck: Promise<void> | null = null;
  #socket = io(this.#configService.config.WS_URL, {
    autoConnect: false,
    withCredentials: true,
    transports: ['websocket'],
    parser: customParser,
  });
  correlationId = uuid();
  #reconnect = new Subject<void>();
  #connected = new BehaviorSubject<boolean>(false);
  #globalStore = inject(GlobalStore);

  readonly connected$ = this.#connected.asObservable();
  readonly reconnect$ = this.#reconnect.asObservable();

  constructor() {
    // registered once; listen() may run again after a logout/login
    this.#socket.on('connect', () => {
      if (this.#connected.value) {
        this.#reconnect.next();
      }

      this.#store.dispatch(wsOpen());
      this.#connected.next(true);
      this.#socket.emit('correlationId', this.correlationId);
      this.#globalStore.setWsConnectionLost(false);
    });

    this.#socket.on('disconnect', (reason, details) => {
      if (reason.includes('client')) {
        return;
      }

      // the server closed the socket, usually because the session ended
      if (reason === 'io server disconnect') {
        this.#checkSession();
        return;
      }

      this.#globalStore.setWsConnectionLost(true);

      console.log('WS disconnect');
      console.log({ reason, details });
    });

    this.#socket.on(
      'board',
      (
        response: {
          [key in PropertyKey]: unknown;
        }[],
      ) => {
        response.forEach((message) => {
          if (message['type']) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            this.#store.dispatch(message as any);
          }
        });
      },
    );

    // sent right before the server disconnects a socket whose session ended
    this.#socket.on('auth_error', () => {
      this.#checkSession();
    });

    // The server checks the session in the handshake. A refused handshake
    // ('unauthenticated', 'server_error') leaves the socket inactive, socket.io
    // does not retry it; network errors keep it active and retrying.
    this.#socket.on('connect_error', () => {
      if (!this.#socket.active) {
        this.#checkSession();
      }
    });

    this.#socket.on('error', (type: string) => {
      if (type === 'unauthorized') {
        this.#notificationService.open({
          message: 'Unauthorized',
          action: 'Close',
          type: 'error',
        });

        const boardId = this.#boardId();

        if (!boardId) {
          void this.#router.navigate(['/']);
        } else if (this.#user()?.isGuest) {
          // shows that the board is no longer shared by link
          void this.#router.navigate(['/join', boardId], {
            queryParams: { returnUrl: this.#router.url },
          });
        } else {
          void this.#router.navigate(['/404']);
        }
      }
    });

    this.#poolLoop();
  }

  getSocket() {
    return this.#socket;
  }

  listen() {
    if (this.#configService.config.DEMO) {
      return;
    }

    // no-op while connected or reconnecting
    if (!this.#socket.active) {
      this.#socket.connect();
    }
  }

  send(obj: unknown[]) {
    this.#pool.push(...obj);
  }

  close() {
    this.#socket.close();
  }

  leaveBoard() {
    this.#socket.emit('leaveBoard');
  }

  // auth_error and the disconnect that follows it report the same loss
  #checkSession() {
    if (this.#authCheck) {
      return;
    }

    this.#authCheck = this.#recoverSession().finally(() => {
      this.#authCheck = null;
    });
  }

  async #recoverSession() {
    const previousUser = this.#user();
    let user: AuthUserModel | null;

    try {
      user = await this.#authService.refresh();
    } catch {
      // the api is unreachable, the session may still be fine; socket.io
      // retries with backoff and the server re-checks the session on connect
      this.#globalStore.setWsConnectionLost(true);
      this.#socket.connect();
      return;
    }

    if (!user) {
      if (previousUser?.isGuest) {
        writeGuestNameHint(previousUser.name);
      }

      // refresh() already cleared the user, the guards can't run again on
      // the same url so the redirect is resolved here
      signedOutRedirect(
        this.#router,
        this.#authApiService,
        this.#router.url,
      ).subscribe((urlTree) => {
        void this.#router.navigateByUrl(urlTree);
      });
    } else if (user.id !== previousUser?.id) {
      // signed in as someone else in another tab
      this.#document.location.reload();
    } else {
      // only this socket was dropped, reconnect$ joins the board again
      this.#socket.connect();
    }
  }

  #boardId() {
    const segments = this.#router.parseUrl(this.#router.url).root.children[
      'primary'
    ]?.segments;

    return segments?.[0]?.path === 'board' ? segments[1]?.path : undefined;
  }

  #poolLoop() {
    if (this.#pool.length && this.#socket.connected) {
      const optimizedPool = optimize(this.#pool);
      this.#socket.emit('board', optimizedPool);
      this.#pool = [];
    }

    setTimeout(() => {
      this.#poolLoop();
    }, 1000 / 15);
  }
}
