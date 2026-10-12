import { Routes } from '@angular/router';
import { PageNotFoundComponent } from './modules/board/components/page-not-found/page-not-found.component';
import { accountGuard } from './modules/board/guards/account.guard';
import { boardGuard } from './modules/board/guards/board.guard';
import { LoginRedirectComponent } from './modules/board/components/login-redirect/login-redirect.component';
import { DemoGuard } from './modules/board/guards/demo.guard';

export const APP_ROUTES: Routes = [
  {
    path: '',
    loadChildren: () =>
      import('./modules/home/home.routes').then((mod) => mod.homesRoutes),
    canActivate: [DemoGuard, accountGuard],
  },
  {
    path: 'board/:id',
    loadChildren: () =>
      import('./modules/board/board.routes').then((mod) => mod.boardRoutes),
    canActivate: [boardGuard],
  },
  {
    // guest entry for link-shared boards, boardGuard sends anonymous visitors here
    path: 'join/:boardId',
    loadComponent: () =>
      import('./modules/auth/pages/board-join/board-join.component').then(
        (mod) => mod.BoardJoinComponent,
      ),
  },
  {
    path: 'login',
    loadComponent: () =>
      import('./modules/auth/pages/login/login.component').then(
        (mod) => mod.LoginComponent,
      ),
    canActivate: [DemoGuard],
  },
  {
    path: 'register',
    loadComponent: () =>
      import('./modules/auth/pages/register/register.component').then(
        (mod) => mod.RegisterComponent,
      ),
    canActivate: [DemoGuard],
  },
  {
    path: 'forgot-password',
    loadComponent: () =>
      import('./modules/auth/pages/forgot-password/forgot-password.component').then(
        (mod) => mod.ForgotPasswordComponent,
      ),
    canActivate: [DemoGuard],
  },
  {
    path: 'reset-password',
    loadComponent: () =>
      import('./modules/auth/pages/reset-password/reset-password.component').then(
        (mod) => mod.ResetPasswordComponent,
      ),
    canActivate: [DemoGuard],
  },
  {
    path: 'verify-email',
    loadComponent: () =>
      import('./modules/auth/pages/verify-email/verify-email.component').then(
        (mod) => mod.VerifyEmailComponent,
      ),
    canActivate: [DemoGuard],
  },
  {
    // landing page of the development agent login (POST /api/agent/session)
    path: 'login-redirect',
    component: LoginRedirectComponent,
  },
  { path: '404', component: PageNotFoundComponent },
  { path: '**', pathMatch: 'full', component: PageNotFoundComponent },
];
