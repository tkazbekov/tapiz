import {
  Component,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ActivatedRoute,
  Router,
  convertToParamMap,
  provideRouter,
} from '@angular/router';
import { Store } from '@ngrx/store';
import { AuthUserModel, defaultUserSettings } from '@tapiz/board-commons';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiService } from '../../../../services/auth-api.service';
import { AuthService } from '../../../../services/auth.service';
import { AuthLayoutComponent } from '../../components/auth-layout/auth-layout.component';
import { BoardJoinComponent } from './board-join.component';

// JIT tests can't load scss or signal inputs of local components
@Component({ selector: 'tapiz-auth-layout', template: '<ng-content />' })
class AuthLayoutStubComponent {}

describe('BoardJoinComponent', () => {
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
  let joinAsGuest: ReturnType<typeof vi.fn>;
  let setUser: ReturnType<typeof vi.fn>;
  let navigateByUrl: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    user.set(null);
    localStorage.clear();
    boardLink = vi.fn(() => of({ name: 'Retro' }));
    joinAsGuest = vi.fn(() => of({ user: guest }));
    setUser = vi.fn();

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: Store, useValue: { selectSignal: () => user } },
        { provide: AuthApiService, useValue: { boardLink, joinAsGuest } },
        {
          provide: AuthService,
          useValue: { setUser, refresh: vi.fn(async () => null) },
        },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              paramMap: convertToParamMap({ boardId: 'board-1' }),
              queryParamMap: convertToParamMap({
                returnUrl: '/board/board-1?nodeId=n1',
              }),
            },
          },
        },
      ],
    });

    TestBed.overrideComponent(BoardJoinComponent, {
      set: { styleUrl: undefined, styles: [] },
    });
    TestBed.overrideComponent(BoardJoinComponent, {
      remove: { imports: [AuthLayoutComponent] },
      add: { imports: [AuthLayoutStubComponent] },
    });

    navigateByUrl = vi
      .spyOn(TestBed.inject(Router), 'navigateByUrl')
      .mockResolvedValue(true);
  });

  afterEach(() => {
    localStorage.clear();
  });

  async function render() {
    const fixture = TestBed.createComponent(BoardJoinComponent);
    await fixture.whenStable();

    return { fixture, element: fixture.nativeElement as HTMLElement };
  }

  it('prefills the last guest name and joins the board as a guest', async () => {
    localStorage.setItem('tapiz.guestNameHint', 'Ana');
    const { fixture, element } = await render();

    expect(boardLink).toHaveBeenCalledWith('board-1');
    expect(element.querySelector('.board-name')?.textContent).toBe('Retro');

    const input = element.querySelector('input');

    expect(input?.value).toBe('Ana');

    element.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await fixture.whenStable();

    expect(joinAsGuest).toHaveBeenCalledWith({
      name: 'Ana',
      boardId: 'board-1',
    });
    expect(setUser).toHaveBeenCalledWith(guest);
    expect(navigateByUrl).toHaveBeenCalledWith('/board/board-1?nodeId=n1');
    expect(localStorage.getItem('tapiz.guestNameHint')).toBe('Ana');
  });

  it('does not join without a name', async () => {
    const { fixture, element } = await render();

    element.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await fixture.whenStable();

    expect(joinAsGuest).not.toHaveBeenCalled();
  });

  it('explains that the board is not shared by link', async () => {
    boardLink.mockReturnValueOnce(
      throwError(() => new HttpErrorResponse({ status: 404 })),
    );
    const { element } = await render();

    expect(element.textContent).toContain("This board isn't shared by link");
    expect(element.querySelector('form')).toBeNull();

    const links = Array.from(element.querySelectorAll('a')).map((link) =>
      link.getAttribute('href'),
    );

    expect(links).toEqual([
      '/login?returnUrl=%2Fboard%2Fboard-1%3FnodeId%3Dn1',
      '/register?returnUrl=%2Fboard%2Fboard-1%3FnodeId%3Dn1',
    ]);
  });

  it('switches to the not-shared state when sharing ends before joining', async () => {
    joinAsGuest.mockReturnValueOnce(
      throwError(() => new HttpErrorResponse({ status: 404 })),
    );
    const { fixture, element } = await render();
    const input = element.querySelector('input');

    if (!input) {
      throw new Error('Expected the name field');
    }

    input.value = 'Ana';
    input.dispatchEvent(new Event('input'));
    element.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await fixture.whenStable();

    expect(setUser).not.toHaveBeenCalled();
    expect(element.textContent).toContain("This board isn't shared by link");
  });

  it('keeps the identity of a signed-in guest', async () => {
    user.set(guest);
    const { fixture, element } = await render();

    expect(element.querySelector('input')).toBeNull();
    expect(element.textContent).toContain("You're joining as Ana (guest)");

    element.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await fixture.whenStable();

    expect(joinAsGuest).toHaveBeenCalledWith({
      name: 'Ana',
      boardId: 'board-1',
    });
  });

  it('sends accounts straight to the board', async () => {
    user.set({
      ...guest,
      id: 'user-1',
      isGuest: false,
      email: 'ada@example.com',
    });
    await render();

    expect(boardLink).not.toHaveBeenCalled();
    expect(navigateByUrl).toHaveBeenCalledWith('/board/board-1?nodeId=n1');
  });
});
