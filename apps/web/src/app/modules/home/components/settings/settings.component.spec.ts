import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Store } from '@ngrx/store';
import { AuthUserModel, defaultUserSettings } from '@tapiz/board-commons';
import { of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiService } from '../../../../services/auth-api.service';
import { WsService } from '../../../ws/services/ws.service';
import { UserApiService } from '../../../../services/user-api.service';
import { SettingsComponent } from './settings.component';

describe('SettingsComponent', () => {
  let apiToken: ReturnType<typeof vi.fn>;
  let generateApiToken: ReturnType<typeof vi.fn>;
  let updateSettings: ReturnType<typeof vi.fn>;
  let changePassword: ReturnType<typeof vi.fn>;
  let wsService: {
    close: ReturnType<typeof vi.fn>;
    listen: ReturnType<typeof vi.fn>;
  };
  let user: ReturnType<typeof signal<AuthUserModel | null>>;

  beforeEach(() => {
    user = signal<AuthUserModel | null>({
      id: 'user-1',
      name: 'Ada',
      picture: '',
      isGuest: false,
      email: 'ada@example.com',
      emailVerified: true,
      settings: defaultUserSettings,
    });

    apiToken = vi.fn(() => of({ hasToken: true, createdAt: '2026-06-25' }));
    generateApiToken = vi.fn(() =>
      of({ token: 'tapiz_pat_generated', createdAt: '2026-06-25' }),
    );
    updateSettings = vi.fn(() => of(defaultUserSettings));
    changePassword = vi.fn(() => of(undefined));
    wsService = { close: vi.fn(), listen: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: Store,
          useValue: {
            dispatch: vi.fn(),
            selectSignal: () => user,
          },
        },
        {
          provide: UserApiService,
          useValue: {
            apiToken,
            generateApiToken,
            updateSettings,
          },
        },
        {
          provide: AuthApiService,
          useValue: { changePassword },
        },
        {
          provide: WsService,
          useValue: wsService,
        },
      ],
    });
  });

  it('keeps the api token state after reloading settings', () => {
    const component = TestBed.runInInjectionContext(
      () => new SettingsComponent(),
    );

    expect(apiToken).toHaveBeenCalledOnce();
    expect(component.apiTokenLoading()).toEqual(false);
    expect(component.apiTokenExists()).toEqual(true);
    expect(component.generatedApiToken()).toBeNull();
  });

  it('shows the newly generated token without waiting for save', () => {
    const component = TestBed.runInInjectionContext(
      () => new SettingsComponent(),
    );

    component.generateApiToken();

    expect(generateApiToken).toHaveBeenCalledOnce();
    expect(updateSettings).not.toHaveBeenCalled();
    expect(component.apiTokenExists()).toEqual(true);
    expect(component.generatedApiToken()).toEqual('tapiz_pat_generated');
  });

  it('preserves board navigation settings when saving note defaults', () => {
    const currentUser = user();

    if (!currentUser) {
      throw new Error('Expected an authenticated user');
    }

    user.set({
      ...currentUser,
      settings: {
        ...defaultUserSettings,
        wheelInputMode: 'trackpad',
      },
    });
    const component = TestBed.runInInjectionContext(
      () => new SettingsComponent(),
    );

    component.save();

    expect(updateSettings).toHaveBeenCalledWith({
      ...defaultUserSettings,
      wheelInputMode: 'trackpad',
    });
  });

  it('changes the password and reconnects the socket with the new session', () => {
    const component = TestBed.runInInjectionContext(
      () => new SettingsComponent(),
    );

    component.passwordForm.setValue({
      currentPassword: 'old-password',
      newPassword: 'new-password',
    });
    component.changePassword();

    expect(wsService.close).toHaveBeenCalledOnce();
    expect(changePassword).toHaveBeenCalledWith({
      currentPassword: 'old-password',
      newPassword: 'new-password',
    });
    expect(wsService.listen).toHaveBeenCalledOnce();
    expect(component.passwordChanged()).toEqual(true);
    expect(component.passwordForm.getRawValue()).toEqual({
      currentPassword: '',
      newPassword: '',
    });
  });

  it('shows the api token as revoked after a password change', () => {
    const component = TestBed.runInInjectionContext(
      () => new SettingsComponent(),
    );

    component.generateApiToken();
    component.passwordForm.setValue({
      currentPassword: 'old-password',
      newPassword: 'new-password',
    });
    component.changePassword();

    expect(component.apiTokenExists()).toEqual(false);
    expect(component.generatedApiToken()).toBeNull();
  });

  it('reports a wrong current password and keeps the socket', () => {
    changePassword.mockReturnValueOnce(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 400,
            error: { error: 'INVALID_CREDENTIALS' },
          }),
      ),
    );
    const component = TestBed.runInInjectionContext(
      () => new SettingsComponent(),
    );

    component.passwordForm.setValue({
      currentPassword: 'wrong-password',
      newPassword: 'new-password',
    });
    component.changePassword();

    expect(component.passwordError()).toEqual(
      'The current password is incorrect.',
    );
    expect(component.passwordChanged()).toEqual(false);
    expect(wsService.listen).toHaveBeenCalledOnce();
  });

  it('does not send a new password shorter than 8 characters', () => {
    const component = TestBed.runInInjectionContext(
      () => new SettingsComponent(),
    );

    component.passwordForm.setValue({
      currentPassword: 'old-password',
      newPassword: 'short',
    });
    component.changePassword();

    expect(changePassword).not.toHaveBeenCalled();
    expect(wsService.close).not.toHaveBeenCalled();
  });
});
