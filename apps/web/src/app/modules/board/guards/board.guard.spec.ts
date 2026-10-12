import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRouteSnapshot,
  Router,
  RouterStateSnapshot,
  provideRouter,
} from '@angular/router';
import { Store } from '@ngrx/store';
import { AuthUserModel, defaultUserSettings } from '@tapiz/board-commons';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../../../services/config.service';
import { boardGuard } from './board.guard';

describe('boardGuard', () => {
  const user = signal<AuthUserModel | null>(null);
  const guest: AuthUserModel = {
    id: 'guest-1',
    name: 'Ana',
    picture: '',
    isGuest: true,
    email: null,
    emailVerified: false,
    settings: defaultUserSettings,
  };

  beforeEach(() => {
    user.set(null);

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: Store, useValue: { selectSignal: () => user } },
        { provide: ConfigService, useValue: { config: { DEMO: false } } },
      ],
    });
  });

  function run(url: string) {
    const result = TestBed.runInInjectionContext(() =>
      boardGuard(
        {} as ActivatedRouteSnapshot,
        {
          url,
        } as RouterStateSnapshot,
      ),
    );

    if (typeof result === 'boolean') {
      return result;
    }

    return TestBed.inject(Router).serializeUrl(result as never);
  }

  it('lets any signed-in user in, the server checks board access', () => {
    user.set(guest);

    expect(run('/board/1')).toBe(true);
  });

  it('keeps the full board url, query included, as the return url', () => {
    expect(run('/board/1?nodeId=2')).toBe(
      '/login?returnUrl=%2Fboard%2F1%3FnodeId%3D2',
    );
  });
});
