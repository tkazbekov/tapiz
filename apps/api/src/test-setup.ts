import { vi } from 'vitest';
import { getAuth } from './tests/test-helpers.js';

// Hoisted above the imports: app modules read these on import (file-upload
// creates the uploads folder).
await vi.hoisted(async () => {
  const os = await import('node:os');
  const path = await import('node:path');

  process.env['UPLOADS_DIR'] ||= path.join(os.tmpdir(), 'tapiz-test-uploads');
  process.env['FRONTEND_URL'] ||= 'http://localhost:4300';
  process.env['API_URL'] ||= 'http://localhost:8000/api';
});

vi.mock('./app/auth', async () => {
  return {
    validateSession: (id: string) => {
      const auth = getAuth(Number(id));
      return Promise.resolve({
        user: {
          id: auth.sub,
          email: auth.email,
          googleId: auth.googleId,
          name: auth.name,
        },
        session: 'test',
      });
    },
    lucia: {
      sessionCookieName: 'auth',
      invalidateUserSessions: vi.fn(),
    },
    setPsqlClient: () => {
      return;
    },
  };
});
