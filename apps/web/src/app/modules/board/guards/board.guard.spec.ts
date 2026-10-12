import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ActivatedRouteSnapshot,
  Router,
  RouterStateSnapshot,
  convertToParamMap,
  provideRouter,
} from '@angular/router';
import { Store } from '@ngrx/store';
import { AuthUserModel, defaultUserSettings } from '@tapiz/board-commons';
import { Observable, firstValueFrom, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiService } from '../../../services/auth-api.service';
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

  let boardLink: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    user.set(null);
    boardLink = vi.fn(() => of({ name: 'Retro' }));

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: Store, useValue: { selectSignal: () => user } },
        { provide: ConfigService, useValue: { config: { DEMO: false } } },
        { provide: AuthApiService, useValue: { boardLink } },
      ],
    });
  });

  async function run(url: string) {
    const result = TestBed.runInInjectionContext(() =>
      boardGuard(
        { paramMap: convertToParamMap({ id: '1' }) } as ActivatedRouteSnapshot,
        {
          url,
        } as RouterStateSnapshot,
      ),
    );

    if (typeof result === 'boolean') {
      return result;
    }

    const tree = await firstValueFrom(result as Observable<never>);

    return TestBed.inject(Router).serializeUrl(tree);
  }

  it('lets any signed-in user in, the server checks board access', async () => {
    user.set(guest);

    expect(await run('/board/1')).toBe(true);
    expect(boardLink).not.toHaveBeenCalled();
  });

  it('sends anonymous visitors of a link-shared board to the join page', async () => {
    expect(await run('/board/1?nodeId=2')).toBe(
      '/join/1?returnUrl=%2Fboard%2F1%3FnodeId%3D2',
    );
    expect(boardLink).toHaveBeenCalledWith('1');
  });

  it('sends anonymous visitors of a private or missing board to login', async () => {
    boardLink.mockReturnValueOnce(
      throwError(() => new HttpErrorResponse({ status: 404 })),
    );

    expect(await run('/board/1?nodeId=2')).toBe(
      '/login?returnUrl=%2Fboard%2F1%3FnodeId%3D2&reason=not-shared',
    );
  });

  it('does not claim the board is private when the check fails', async () => {
    boardLink.mockReturnValueOnce(
      throwError(() => new HttpErrorResponse({ status: 429 })),
    );

    expect(await run('/board/1')).toBe('/login?returnUrl=%2Fboard%2F1');
  });
});
