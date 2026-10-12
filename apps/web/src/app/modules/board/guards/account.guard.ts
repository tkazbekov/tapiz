import { CanActivateFn, Router } from '@angular/router';
import { inject } from '@angular/core';
import { Store } from '@ngrx/store';
import { appFeature } from '../../../+state/app.reducer';
import { ConfigService } from '../../../services/config.service';

// The user is loaded by the app initializer before the first navigation.
export const accountGuard: CanActivateFn = (_route, state) => {
  const store = inject(Store);
  const router = inject(Router);
  const configService = inject(ConfigService);

  if (configService.config.DEMO) {
    return true;
  }

  const user = store.selectSignal(appFeature.selectUser)();
  const returnUrl = state.url === '/' ? undefined : state.url;

  if (!user) {
    return router.createUrlTree(['/login'], { queryParams: { returnUrl } });
  }

  if (user.isGuest) {
    return router.createUrlTree(['/register'], {
      queryParams: { returnUrl, from: 'guest' },
    });
  }

  return true;
};
