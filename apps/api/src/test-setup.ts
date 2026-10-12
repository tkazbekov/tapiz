import { vi } from 'vitest';

// Hoisted above the imports: app modules read these on import (file-upload
// creates the uploads folder).
await vi.hoisted(async () => {
  const os = await import('node:os');
  const path = await import('node:path');

  process.env['UPLOADS_DIR'] ||= path.join(os.tmpdir(), 'tapiz-test-uploads');
  process.env['FRONTEND_URL'] ||= 'http://localhost:4300';
  process.env['API_URL'] ||= 'http://localhost:8000/api';
});

// Session cookies `<n>` and `g<n>` stand for test user n and test guest n.
// Real tokens go through the real implementation.
vi.mock('./app/auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./app/auth/session')>();

  return {
    ...actual,
    validateSessionToken: async (
      token?: string,
      options?: { slide?: boolean },
    ) => {
      const match = token ? /^(g?)(\d+)$/.exec(token) : null;

      if (!match) {
        return actual.validateSessionToken(token, options);
      }

      const helpers = await import('./tests/test-helpers.js');
      const auth = (match[1] ? helpers.getGuestAuth : helpers.getAuth)(
        Number(match[2]),
      );
      const account = await (
        await import('./app/db/user-db.js')
      ).getUser(auth.sub);

      return account
        ? {
            account,
            sessionId: `test-${token}`,
            expiresAt: new Date(Date.now() + 1e9),
            refreshed: false,
          }
        : null;
    },
  };
});
