import {
  Component,
  OnInit,
  inject,
  ChangeDetectionStrategy,
  input,
} from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../../../services/auth.service';
import { safeReturnUrl } from '../../../../utils/safe-return-url';

// Landing page of the development agent login, the session cookie is already set
@Component({
  selector: 'tapiz-login-redirect',
  template: '',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginRedirectComponent implements OnInit {
  #router = inject(Router);
  #authService = inject(AuthService);

  returnUrl = input<string>();

  ngOnInit(): void {
    void this.#authService
      .refresh()
      .catch(() => null)
      .then(() => {
        void this.#router.navigateByUrl(safeReturnUrl(this.returnUrl()));
      });
  }
}
