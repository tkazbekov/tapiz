import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { inject } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Store } from '@ngrx/store';
import { catchError, map, Observable, of } from 'rxjs';
import { appFeature } from '../../../+state/app.reducer';
import { AuthApiService } from '../../../services/auth-api.service';
import { ConfigService } from '../../../services/config.service';

// Accounts and guests can open boards, the server decides board access.
export const boardGuard: CanActivateFn = (route, state) => {
  const store = inject(Store);
  const configService = inject(ConfigService);

  if (configService.config.DEMO) {
    return true;
  }

  if (store.selectSignal(appFeature.selectUser)()) {
    return true;
  }

  return anonymousBoardRedirect(
    inject(Router),
    inject(AuthApiService),
    route.paramMap.get('id') ?? '',
    state.url,
  );
};

// Link-shared boards offer the guest join page, anything else needs a sign in.
// The board-link check answers 404 for private and missing boards alike.
function anonymousBoardRedirect(
  router: Router,
  authApiService: AuthApiService,
  boardId: string,
  returnUrl: string,
): Observable<UrlTree> {
  return authApiService.boardLink(boardId).pipe(
    map(() => {
      return router.createUrlTree(['/join', boardId], {
        queryParams: { returnUrl },
      });
    }),
    catchError((error: unknown) => {
      const notShared =
        error instanceof HttpErrorResponse && error.status === 404;

      return of(
        router.createUrlTree(['/login'], {
          queryParams: {
            returnUrl,
            reason: notShared ? 'not-shared' : undefined,
          },
        }),
      );
    }),
  );
}

// Where to go once the session is gone: board urls get the guest join check,
// anything else needs a sign in.
export function signedOutRedirect(
  router: Router,
  authApiService: AuthApiService,
  url: string,
): Observable<UrlTree> {
  const segments = router.parseUrl(url).root.children['primary']?.segments;

  if (segments?.[0]?.path === 'board' && segments[1]) {
    return anonymousBoardRedirect(
      router,
      authApiService,
      segments[1].path,
      url,
    );
  }

  return of(
    router.createUrlTree(['/login'], { queryParams: { returnUrl: url } }),
  );
}
