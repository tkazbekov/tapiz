import {
  Component,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { Store } from '@ngrx/store';
import { NEVER, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiService } from '../../../../services/auth-api.service';
import { AuthLayoutComponent } from '../../components/auth-layout/auth-layout.component';
import { WsService } from '../../../ws/services/ws.service';
import { ResetPasswordComponent } from './reset-password.component';

// JIT tests can't load scss or signal inputs of local components
@Component({ selector: 'tapiz-auth-layout', template: '<ng-content />' })
class AuthLayoutStubComponent {}

describe('ResetPasswordComponent', () => {
  const userId = signal<string | null>(null);
  let confirmReset: ReturnType<typeof vi.fn>;
  let wsService: {
    close: ReturnType<typeof vi.fn>;
    listen: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    userId.set(null);
    confirmReset = vi.fn();
    wsService = { close: vi.fn(), listen: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: Store, useValue: { selectSignal: () => userId } },
        { provide: AuthApiService, useValue: { confirmReset } },
        { provide: WsService, useValue: wsService },
      ],
    });

    TestBed.overrideComponent(ResetPasswordComponent, {
      set: { styleUrl: undefined, styles: [] },
    });
    TestBed.overrideComponent(ResetPasswordComponent, {
      remove: { imports: [AuthLayoutComponent] },
      add: { imports: [AuthLayoutStubComponent] },
    });
  });

  afterEach(() => {
    history.replaceState(null, '', '/');
  });

  function create() {
    return TestBed.runInInjectionContext(() => new ResetPasswordComponent());
  }

  it('reads the token from the hash and strips it from the address bar', () => {
    history.replaceState(
      { navigationId: 1 },
      '',
      '/reset-password?a=1#token=abc',
    );

    const component = create();

    expect(component.token).toBe('abc');
    expect(location.hash).toBe('');
    expect(location.pathname + location.search).toBe('/reset-password?a=1');
    expect(history.state).toEqual({ navigationId: 1 });
  });

  it('treats a link without token as invalid', () => {
    history.replaceState(null, '', '/reset-password');

    const component = create();
    component.form.controls.password.setValue('new-password');
    component.submit();

    expect(component.token).toBeNull();
    expect(confirmReset).not.toHaveBeenCalled();
  });

  it('sends the token with the new password and reports an expired link', () => {
    history.replaceState(null, '', '/reset-password#token=abc');
    confirmReset.mockReturnValueOnce(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 400,
            error: { error: 'INVALID_OR_EXPIRED_TOKEN' },
          }),
      ),
    );

    const component = create();
    component.form.controls.password.setValue('new-password');
    component.submit();

    expect(confirmReset).toHaveBeenCalledWith({
      token: 'abc',
      password: 'new-password',
    });
    expect(component.invalidToken()).toBe(true);
    expect(component.loading()).toBe(false);
  });

  it('closes the socket before the reset ends its session', () => {
    history.replaceState(null, '', '/reset-password#token=abc');
    userId.set('user-1');
    confirmReset.mockImplementationOnce(() => {
      expect(wsService.close).toHaveBeenCalled();

      return throwError(() => new HttpErrorResponse({ status: 500 }));
    });

    const component = create();
    component.form.controls.password.setValue('new-password');
    component.submit();

    expect(confirmReset).toHaveBeenCalled();
    // the session survives a failed reset, so the socket comes back
    expect(wsService.listen).toHaveBeenCalled();
  });

  it('keeps the socket closed after a failed reset while signed out', () => {
    history.replaceState(null, '', '/reset-password#token=abc');
    confirmReset.mockReturnValueOnce(
      throwError(() => new HttpErrorResponse({ status: 500 })),
    );

    const component = create();
    component.form.controls.password.setValue('new-password');
    component.submit();

    expect(wsService.listen).not.toHaveBeenCalled();
  });

  it('does not send a password shorter than 8 characters', () => {
    history.replaceState(null, '', '/reset-password#token=abc');

    const component = create();
    component.form.controls.password.setValue('short');
    component.submit();

    expect(confirmReset).not.toHaveBeenCalled();
  });

  it('submits through the form instead of a native submit', async () => {
    history.replaceState(null, '', '/reset-password#token=abc');
    confirmReset.mockReturnValueOnce(NEVER);

    const fixture = TestBed.createComponent(ResetPasswordComponent);
    await fixture.whenStable();

    const element: HTMLElement = fixture.nativeElement;
    const form = element.querySelector('form');
    const input = element.querySelector('input');
    const button = element.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );

    if (!form || !input || !button) {
      throw new Error('Expected the reset form');
    }

    let submitEvent: Event | null = null;
    form.addEventListener('submit', (event) => (submitEvent = event));

    input.value = 'new-password';
    input.dispatchEvent(new Event('input'));
    button.click();
    await fixture.whenStable();

    expect(submitEvent?.defaultPrevented).toBe(true);
    expect(confirmReset).toHaveBeenCalledWith({
      token: 'abc',
      password: 'new-password',
    });
  });
});
