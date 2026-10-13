import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiService } from '../../../../services/auth-api.service';
import { AuthLayoutComponent } from '../../components/auth-layout/auth-layout.component';
import { ForgotPasswordComponent } from './forgot-password.component';

// JIT tests can't load scss or signal inputs of local components
@Component({ selector: 'tapiz-auth-layout', template: '<ng-content />' })
class AuthLayoutStubComponent {}

describe('ForgotPasswordComponent', () => {
  let requestReset: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    requestReset = vi.fn(() => of(undefined));

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: AuthApiService, useValue: { requestReset } },
      ],
    });

    TestBed.overrideComponent(ForgotPasswordComponent, {
      set: { styleUrl: undefined, styles: [] },
    });
    TestBed.overrideComponent(ForgotPasswordComponent, {
      remove: { imports: [AuthLayoutComponent] },
      add: { imports: [AuthLayoutStubComponent] },
    });
  });

  it('submits through the form instead of a native submit', async () => {
    const fixture = TestBed.createComponent(ForgotPasswordComponent);
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

    let submitEvent = null as Event | null;
    form.addEventListener('submit', (event) => (submitEvent = event));

    input.value = 'ada@example.com';
    input.dispatchEvent(new Event('input'));
    button.click();
    await fixture.whenStable();

    expect(submitEvent?.defaultPrevented).toBe(true);
    expect(requestReset).toHaveBeenCalledWith({ email: 'ada@example.com' });
    expect(element.textContent).toContain('If an account exists');
  });
});
