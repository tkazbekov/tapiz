import { HttpErrorResponse } from '@angular/common/http';

const commonMessages: Partial<Record<string, string>> = {
  INVALID_REQUEST: 'Check the form and try again.',
  SERVER_BUSY: 'The server is busy. Try again in a moment.',
};

// Auth routes answer with { error: CODE }; anything unknown gets a generic message
export function authErrorMessage(
  error: unknown,
  messages: Partial<Record<string, string>> = {},
): string {
  if (error instanceof HttpErrorResponse) {
    const code: unknown = error.error?.error;
    const message =
      typeof code === 'string'
        ? (messages[code] ?? commonMessages[code])
        : null;

    if (message) {
      return message;
    }

    if (error.status === 429) {
      return 'Too many attempts. Try again later.';
    }
  }

  return 'Something went wrong. Try again.';
}

export function authErrorCode(error: unknown): string | null {
  if (error instanceof HttpErrorResponse) {
    const code: unknown = error.error?.error;

    return typeof code === 'string' ? code : null;
  }

  return null;
}
