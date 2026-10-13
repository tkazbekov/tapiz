import { Injectable, inject } from '@angular/core';
import { Subject, from, tap } from 'rxjs';
import { APIConfigService } from './api-config.service';

type TemplateClient = ReturnType<APIConfigService['trpc']>['template'];

export type TemplateSummary = Awaited<
  ReturnType<TemplateClient['list']['query']>
>[number];
export type TemplateWithData = Awaited<
  ReturnType<TemplateClient['get']['query']>
>;
export type CreateTemplateInput = Parameters<
  TemplateClient['createFromBoard']['mutate']
>[0];
export type CreateTemplateResult = Awaited<
  ReturnType<TemplateClient['createFromBoard']['mutate']>
>;

/**
 * The server's own message, unless it is an input validation error: those
 * carry zod's JSON issue list as their message.
 */
export function templateErrorMessage(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message.trim() : '';

  return message && !/^[[{]/.test(message) ? message : fallback;
}

@Injectable({
  providedIn: 'root',
})
export class TemplateApiService {
  #apiConfigService = inject(APIConfigService);
  #changed = new Subject<void>();

  // a template was saved or deleted
  readonly changed = this.#changed.asObservable();

  get trpc() {
    return this.#apiConfigService.trpc();
  }

  list(teamId?: string) {
    return from(this.trpc.template.list.query(teamId ? { teamId } : {}));
  }

  get(templateId: string) {
    return from(this.trpc.template.get.query({ templateId }));
  }

  createFromBoard(input: CreateTemplateInput) {
    return from(this.trpc.template.createFromBoard.mutate(input)).pipe(
      tap(() => this.#changed.next()),
    );
  }

  remove(templateId: string) {
    return from(this.trpc.template.delete.mutate({ templateId })).pipe(
      tap(() => this.#changed.next()),
    );
  }
}
