import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { AuthUserModel } from '@tapiz/board-commons';
import { ConfigService } from './config.service';

export interface AuthUserResponse {
  user: AuthUserModel;
}

// REST endpoints under /api/auth; errors come back as { error: CODE }
@Injectable({
  providedIn: 'root',
})
export class AuthApiService {
  #http = inject(HttpClient);
  #configService = inject(ConfigService);

  get #url() {
    return `${this.#configService.config.API_URL}/auth`;
  }

  session() {
    return this.#http.get<{ user: AuthUserModel | null }>(
      `${this.#url}/session`,
      { withCredentials: true },
    );
  }

  boardLink(boardId: string) {
    return this.#http.get<{ name: string }>(
      `${this.#url}/board-link/${encodeURIComponent(boardId)}`,
      { withCredentials: true },
    );
  }

  register(body: { name: string; email: string; password: string }) {
    return this.#http.post<AuthUserResponse>(`${this.#url}/register`, body, {
      withCredentials: true,
    });
  }

  login(body: { email: string; password: string }) {
    return this.#http.post<AuthUserResponse>(`${this.#url}/login`, body, {
      withCredentials: true,
    });
  }

  logout() {
    return this.#http.post<void>(
      `${this.#url}/logout`,
      {},
      { withCredentials: true },
    );
  }

  joinAsGuest(body: { name: string; boardId: string }) {
    return this.#http.post<AuthUserResponse>(`${this.#url}/guest`, body, {
      withCredentials: true,
    });
  }

  requestReset(body: { email: string }) {
    return this.#http.post<{ ok: true }>(
      `${this.#url}/password-reset/request`,
      body,
      { withCredentials: true },
    );
  }

  confirmReset(body: { token: string; password: string }) {
    return this.#http.post<AuthUserResponse>(
      `${this.#url}/password-reset/confirm`,
      body,
      { withCredentials: true },
    );
  }

  changePassword(body: { currentPassword: string; newPassword: string }) {
    return this.#http.post<void>(`${this.#url}/password`, body, {
      withCredentials: true,
    });
  }

  verifyEmail(body: { token: string }) {
    return this.#http.post<AuthUserResponse>(
      `${this.#url}/verify-email`,
      body,
      { withCredentials: true },
    );
  }

  // 202 when a mail was queued, 204 when the account is already verified
  resendVerification() {
    return this.#http.post<void>(
      `${this.#url}/verify-email/resend`,
      {},
      { withCredentials: true, observe: 'response' },
    );
  }
}
