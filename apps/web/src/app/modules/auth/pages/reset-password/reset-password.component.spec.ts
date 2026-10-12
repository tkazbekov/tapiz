import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { NEVER, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiService } from '../../../../services/auth-api.service';
import { AuthLayoutComponent } from '../../components/auth-layout/auth-layout.component';
import { ResetPasswordComponent } from './reset-password.component';

// JIT tests can't load scss or signal inputs of local components
@Component({ selector: 'tapiz-auth-layout', template: '<ng-content />' })
class AuthLayoutStubComponent {}

describe('ResetPasswordComponent', () => {
  let confirmReset: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    confirmReset = vi.fn();

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: AuthApiService, useValue: { confirmReset } },
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
