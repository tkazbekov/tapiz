import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Store } from '@ngrx/store';
import { AuthUserModel, defaultUserSettings } from '@tapiz/board-commons';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../../../services/auth.service';
import { ConfigService } from '../../../../services/config.service';
import { UserApiService } from '../../../../services/user-api.service';
import { BoardWheelInputService } from '../../services/board-wheel-input.service';
import { UserMenuComponent } from './user-menu.component';

describe('UserMenuComponent', () => {
  const authUser = signal<AuthUserModel | null>({
    id: 'user-1',
    name: 'Ada',
    picture: '',
    isGuest: false,
    email: 'ada@example.com',
    emailVerified: true,
    settings: defaultUserSettings,
  });
  let dispatch: ReturnType<typeof vi.fn>;
  let updateSettings: ReturnType<typeof vi.fn>;
  let setDemoMode: ReturnType<typeof vi.fn>;
  let openSnackBar: ReturnType<typeof vi.fn>;
  let openDialog: ReturnType<typeof vi.fn>;
  let logout: ReturnType<typeof vi.fn>;
  let confirmed: boolean;
  const config = { DEMO: false };
  const wheelMode = signal<'auto' | 'mouse' | 'trackpad'>('auto');

  beforeEach(() => {
    config.DEMO = false;
    wheelMode.set('auto');
    authUser.set({
      id: 'user-1',
      name: 'Ada',
      picture: '',
      isGuest: false,
      email: 'ada@example.com',
      emailVerified: true,
      settings: defaultUserSettings,
    });
    dispatch = vi.fn();
    updateSettings = vi.fn((settings) => of(settings));
    setDemoMode = vi.fn((mode) => wheelMode.set(mode));
    openSnackBar = vi.fn();
    confirmed = true;
    openDialog = vi.fn(() => ({ afterClosed: () => of(confirmed) }));
    logout = vi.fn();

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        {
          provide: MatDialog,
          useValue: { open: openDialog },
        },
        {
          provide: AuthService,
          useValue: { logout },
        },
        {
          provide: Store,
          useValue: {
            dispatch,
            selectSignal: () => authUser,
          },
        },
        {
          provide: UserApiService,
          useValue: { updateSettings },
        },
        {
          provide: MatSnackBar,
          useValue: { open: openSnackBar },
        },
        {
          provide: ConfigService,
          useValue: { config },
        },
        {
          provide: BoardWheelInputService,
          useValue: { mode: wheelMode, setDemoMode },
        },
      ],
    });
  });

  it('saves the selected wheel input mode and updates the current user', () => {
    const component = TestBed.runInInjectionContext(
      () => new UserMenuComponent(),
    );

    component.selectWheelInputMode('trackpad');

    const currentUser = authUser();

    if (!currentUser) {
      throw new Error('Expected an authenticated user');
    }

    const updatedUser: AuthUserModel = {
      ...currentUser,
      settings: {
        ...defaultUserSettings,
        wheelInputMode: 'trackpad',
      },
    };
    expect(updateSettings).toHaveBeenCalledWith(updatedUser.settings);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ user: updatedUser }),
    );
    // the session cookie is the source of truth, nothing is cached locally
    expect(localStorage.getItem('user')).toBeNull();
  });

  it('does not save the already selected mode', () => {
    const component = TestBed.runInInjectionContext(
      () => new UserMenuComponent(),
    );

    component.selectWheelInputMode('auto');

    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('stores the selected mode locally in Demo without an authenticated user', () => {
    config.DEMO = true;
    authUser.set(null);
    const component = TestBed.runInInjectionContext(
      () => new UserMenuComponent(),
    );

    component.selectWheelInputMode('trackpad');

    expect(setDemoMode).toHaveBeenCalledWith('trackpad');
    expect(component.currentMode()).toBe('trackpad');
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('rolls back the optimistic update when persistence fails', () => {
    updateSettings.mockReturnValueOnce(
      throwError(() => new Error('Settings request failed')),
    );
    const component = TestBed.runInInjectionContext(
      () => new UserMenuComponent(),
    );
    const currentUser = authUser();

    if (!currentUser) {
      throw new Error('Expected an authenticated user');
    }

    component.selectWheelInputMode('trackpad');

    const optimisticUser: AuthUserModel = {
      ...currentUser,
      settings: {
        ...defaultUserSettings,
        wheelInputMode: 'trackpad',
      },
    };
    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ user: optimisticUser }),
    );
    expect(dispatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ user: currentUser }),
    );
    expect(openSnackBar).toHaveBeenCalledWith(
      'Could not save navigation preference',
      'Close',
      { duration: 4000 },
    );
    expect(component.savingMode()).toBeNull();
  });

  describe('as a guest', () => {
    beforeEach(() => {
      authUser.set({
        id: 'guest-1',
        name: 'Ana',
        picture: '',
        isGuest: true,
        email: null,
        emailVerified: false,
        settings: defaultUserSettings,
      });
    });

    function create() {
      const component = TestBed.runInInjectionContext(
        () => new UserMenuComponent(),
      );
      const router = TestBed.inject(Router);
      vi.spyOn(router, 'url', 'get').mockReturnValue('/board/1?nodeId=2');
      const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

      return { component, navigate };
    }

    it('knows the user is a guest', () => {
      const { component } = create();

      expect(component.isGuest()).toBe(true);
    });

    it('offers to create an account that comes back to the board', () => {
      const { component, navigate } = create();

      component.createAccount();

      expect(navigate).toHaveBeenCalledWith(['/register'], {
        queryParams: { returnUrl: '/board/1?nodeId=2', from: 'guest' },
      });
    });

    it('offers to sign in and come back to the board', () => {
      const { component, navigate } = create();

      component.signIn();

      expect(navigate).toHaveBeenCalledWith(['/login'], {
        queryParams: { returnUrl: '/board/1?nodeId=2' },
      });
    });

    it('leaves the guest session only after confirming', () => {
      const { component } = create();

      confirmed = false;
      component.leaveGuestSession();

      expect(openDialog).toHaveBeenCalledOnce();
      expect(logout).not.toHaveBeenCalled();

      confirmed = true;
      component.leaveGuestSession();

      expect(logout).toHaveBeenCalledOnce();
    });
  });

  it('does not treat accounts as guests', () => {
    const component = TestBed.runInInjectionContext(
      () => new UserMenuComponent(),
    );

    expect(component.isGuest()).toBe(false);
  });
});
