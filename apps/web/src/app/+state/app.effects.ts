import { DOCUMENT, inject } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { UserApiService } from '../services/user-api.service';
import { AppActions } from './app.actions';
import {
  EMPTY,
  catchError,
  exhaustMap,
  filter,
  from,
  map,
  of,
  switchMap,
  tap,
} from 'rxjs';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { AuthApiService } from '../services/auth-api.service';
import { HomeActions } from '../modules/home/+state/home.actions';
import { signedOutRedirect } from '../modules/board/guards/board.guard';

export const logout$ = createEffect(
  (
    actions$ = inject(Actions),
    authApiService = inject(AuthApiService),
    document = inject(DOCUMENT),
  ) => {
    return actions$.pipe(
      ofType(AppActions.logout),
      exhaustMap(() => {
        // leave even if the server call fails
        return authApiService.logout().pipe(catchError(() => of(null)));
      }),
      tap(() => {
        // full reload drops every piece of in-memory state of the old user
        document.location.assign('/login');
      }),
    );
  },
  {
    functional: true,
    dispatch: false,
  },
);

export const unauthorized$ = createEffect(
  (
    actions$ = inject(Actions),
    router = inject(Router),
    authService = inject(AuthService),
    authApiService = inject(AuthApiService),
  ) => {
    return actions$.pipe(
      ofType(AppActions.unauthorized),
      exhaustMap(() => {
        // read before refreshing: other handlers may navigate away meanwhile
        const url = router.url;

        // the session may have ended or only this resource may be forbidden
        return from(authService.refresh()).pipe(
          switchMap((user) => {
            if (!user) {
              // link-shared boards offer the guest join page again
              return signedOutRedirect(router, authApiService, url);
            }

            // the ws join refusal can get there before the 401 does
            if (url.startsWith('/404') || url.startsWith('/join/')) {
              return EMPTY;
            }

            const segments =
              router.parseUrl(url).root.children['primary']?.segments;
            const boardId =
              segments?.[0]?.path === 'board' ? segments[1]?.path : undefined;

            // as the ws join refusal does: shows that the board is no
            // longer shared by link
            if (user.isGuest && boardId) {
              return of(
                router.createUrlTree(['/join', boardId], {
                  queryParams: { returnUrl: url },
                }),
              );
            }

            const onBoard = url.startsWith('/board');

            return of(router.createUrlTree([onBoard ? '/404' : '/']));
          }),
          catchError(() => EMPTY),
        );
      }),
      tap((urlTree) => {
        void router.navigateByUrl(urlTree);
      }),
    );
  },
  {
    functional: true,
    dispatch: false,
  },
);

export const fetchOnSetUser$ = createEffect(
  (actions$ = inject(Actions)) => {
    return actions$.pipe(
      ofType(AppActions.setUser, HomeActions.userEvent),
      filter((action) => !('user' in action) || !!action.user),
      map(() => {
        return AppActions.fetchNotifications({ offset: 0 });
      }),
    );
  },
  {
    functional: true,
  },
);

export const notifications$ = createEffect(
  (actions$ = inject(Actions), usersApiService = inject(UserApiService)) => {
    return actions$.pipe(
      ofType(AppActions.fetchNotifications),
      exhaustMap(({ offset }) => {
        return usersApiService.notifications(offset).pipe(
          map((notifications) => {
            return AppActions.fetchNotificationsSuccess({
              ...notifications,
              offset,
            });
          }),
          catchError(() => EMPTY),
        );
      }),
    );
  },
  {
    functional: true,
  },
);

export const clearNotifications$ = createEffect(
  (actions$ = inject(Actions), usersApiService = inject(UserApiService)) => {
    return actions$.pipe(
      ofType(AppActions.clearNotifications),
      exhaustMap(() => {
        return usersApiService.clearNotifications();
      }),
      map(() => {
        return AppActions.fetchNotifications({ offset: 0 });
      }),
    );
  },
  {
    functional: true,
  },
);
