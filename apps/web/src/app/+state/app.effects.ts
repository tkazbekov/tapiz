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
  tap,
} from 'rxjs';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { AuthApiService } from '../services/auth-api.service';
import { HomeActions } from '../modules/home/+state/home.actions';

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
  ) => {
    return actions$.pipe(
      ofType(AppActions.unauthorized),
      exhaustMap(() => {
        // the session may have ended or only this resource may be forbidden
        return from(authService.refresh()).pipe(catchError(() => EMPTY));
      }),
      tap((user) => {
        const onBoard = router.url.startsWith('/board');

        if (!user) {
          void router.navigate(['/login'], {
            queryParams: { returnUrl: router.url },
          });
        } else if (onBoard) {
          void router.navigate(['/404']);
        } else {
          void router.navigate(['/']);
        }
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
