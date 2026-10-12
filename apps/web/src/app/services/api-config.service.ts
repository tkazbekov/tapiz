import { inject, Injectable } from '@angular/core';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
// eslint-disable-next-line @nx/enforce-module-boundaries
import type { AppRouter } from '@tapiz/api/app/trpc-type';
import { ConfigService } from './config.service';
import { Store } from '@ngrx/store';
import { AppActions } from '../+state/app.actions';
import { WsService } from '../modules/ws/services/ws.service';
@Injectable({
  providedIn: 'root',
})
export class APIConfigService {
  #configService = inject(ConfigService);
  #store = inject(Store);
  #wsService = inject(WsService);
  #config = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: this.#configService.config.API_URL + '/trpc',
        fetch: async (url, options) => {
          // update api-rest-interceptor.service.ts
          // Keep tRPC's own headers (content-type is only set for non-GET).
          const headers = new Headers(options?.headers);
          headers.set('correlation-id', this.#wsService.correlationId);

          const response = await fetch(url, {
            ...options,
            credentials: 'include',
            headers,
          });

          if (response.status === 401) {
            this.#store.dispatch(AppActions.unauthorized());

            return response;
          }

          return response;
        },
      }),
    ],
  });

  public trpc() {
    return this.#config;
  }
}
