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
import { accountGuard } from './account.guard';

describe('accountGuard', () => {
  const user = signal<AuthUserModel | null>(null);
  const config = { DEMO: false };
  const account: AuthUserModel = {
    id: 'user-1',
    name: 'Ada',
    picture: '',
    isGuest: false,
    email: 'ada@example.com',
    emailVerified: true,
    settings: defaultUserSettings,
  };

  beforeEach(() => {
    user.set(null);
    config.DEMO = false;

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: Store, useValue: { selectSignal: () => user } },
        { provide: ConfigService, useValue: { config } },
      ],
    });
  });

  function run(url: string) {
    const result = TestBed.runInInjectionContext(() =>
      accountGuard(
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

  it('lets accounts in', () => {
    user.set(account);

    expect(run('/settings')).toBe(true);
  });

  it('sends anonymous visitors to login with a return url', () => {
    expect(run('/team/1?spaceId=2')).toBe(
      '/login?returnUrl=%2Fteam%2F1%3FspaceId%3D2',
    );
  });

  it('does not add a return url for the home page', () => {
    expect(run('/')).toBe('/login');
  });

  it('sends guests to create an account', () => {
    user.set({ ...account, isGuest: true, email: null, emailVerified: false });

    expect(run('/starred')).toBe('/register?returnUrl=%2Fstarred&from=guest');
  });

  it('lets everyone in Demo', () => {
    config.DEMO = true;

    expect(run('/')).toBe(true);
  });
});
