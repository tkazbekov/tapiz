import { CanActivateFn, Router } from '@angular/router';
import { inject } from '@angular/core';
import { Store } from '@ngrx/store';
import { appFeature } from '../../../+state/app.reducer';
import { ConfigService } from '../../../services/config.service';

// Accounts and guests can open boards, the server decides board access.
export const boardGuard: CanActivateFn = (_route, state) => {
  const store = inject(Store);
  const router = inject(Router);
  const configService = inject(ConfigService);

  if (configService.config.DEMO) {
    return true;
  }

  if (store.selectSignal(appFeature.selectUser)()) {
    return true;
  }

  return router.createUrlTree(['/login'], {
    queryParams: { returnUrl: state.url },
  });
};
