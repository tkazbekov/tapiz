import { Injectable, inject } from '@angular/core';
import { Store } from '@ngrx/store';
import { firstValueFrom } from 'rxjs';
import { AppActions } from '../+state/app.actions';
import { AuthUserModel, withDefaultUserSettings } from '@tapiz/board-commons';
import { AuthApiService } from './auth-api.service';
import { ConfigService } from './config.service';

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  #store = inject(Store);
  #authApiService = inject(AuthApiService);
  #configService = inject(ConfigService);

  // runs as an app initializer, so guards can read the user synchronously
  async bootstrap() {
    // the user used to be cached here, the session cookie is the source now
    try {
      localStorage.removeItem('user');
    } catch {
      // storage can be blocked
    }

    if (this.#configService.config.DEMO) {
      return;
    }

    try {
      await this.refresh();
    } catch {
      this.setUser(null);
    }
  }

  async refresh(): Promise<AuthUserModel | null> {
    const { user } = await firstValueFrom(this.#authApiService.session());

    this.setUser(user);

    return user;
  }

  setUser(user: AuthUserModel | null) {
    this.#store.dispatch(
      AppActions.setUser({
        user: user
          ? { ...user, settings: withDefaultUserSettings(user.settings) }
          : null,
      }),
    );
  }

  async resendVerification() {
    const response = await firstValueFrom(
      this.#authApiService.resendVerification(),
    );

    // 204: verified meanwhile (e.g. in another tab), nothing was sent
    if (response.status === 204) {
      await this.refresh();
    }
  }

  logout() {
    this.#store.dispatch(AppActions.logout());
  }
}
