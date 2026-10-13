# Auth

Tapiz has its own email and password accounts, hashed DB sessions, and link guests. There is no external identity provider.

## Modules

- `apps/api/src/app/auth/`: `config.ts` (cookie name `tapiz_session`, Secure flag, allowed origins), `tokens.ts` (random tokens and sha256 hashes), `password.ts` (scrypt with a bounded queue), `session.ts` (create, validate, slide, cookie), `principal.ts` (`req.principal` from Bearer token or cookie), `csrf.ts` (Origin / Sec-Fetch-Site check for cookie requests).
- `apps/api/src/app/db/session-db.ts`: the `sessions` table. Only the token hash is stored.
- `apps/api/src/app/routers/auth-routes.ts`: REST routes under `/api/auth/*` (`session`, `register`, `login`, `logout`, `password`, `password-reset/*`, `verify-email`, `verify-email/resend`, `guest`, `board-link/:boardId`). These are REST, not tRPC: a tRPC batch shares one context, and auth failures must not trigger the web app's 401 handling.
- `apps/api/src/app/agent-auth.ts`: development-only API token to session exchange, see [Local AI Browser Login](local-ai-browser-login.md).
- Web: `services/auth.service.ts`, `auth-api.service.ts`, `modules/auth/pages/*`, and the `accountGuard` / `boardGuard` guards.

Registration order in `init-server.ts` matters: cookie, CORS (so 429s carry CORS headers), the CSRF and principal hooks, then the IP-keyed rate limiter, all on the root before child plugins. Otherwise `req.principal` is missing in `fileUpload` or tRPC.

## Tiers

- `participantProcedure`: accounts and guests (`user`, `settings`, `notifications`).
- `protectedProcedure`: accounts only. A guest gets `FORBIDDEN` / `ACCOUNT_REQUIRED`, not `UNAUTHORIZED`, so the web app does not treat it as a lost session.
- `boardMemberProcedure`: guests OK. `boardAccountMemberProcedure` and `boardAdminProcedure` check the account first, so no `accounts_boards` row is created for guests.
- `requireSessionAuth`: cookie sessions only, for minting API tokens and deleting the account.
- With an `Authorization` header only the Bearer token counts; the cookie is never read and CSRF does not apply.

## Guest Rules

- Guests exist only for boards with link sharing on (`boards.public`). They can edit like members and receive in-app mentions, never mention emails.
- Guests can't upload, become admin, create or duplicate boards, use teams, hold API tokens, or use MCP. Guests only mention users with an `accounts_boards` row on that board.
- `isGuest` on user nodes is set by the server; validators must not accept it from clients.
- Registering as a guest upgrades in place and keeps `accounts.id`. Logging in to another account abandons the guest identity.

## Notes

- Login is limited to 10 attempts per 15 minutes per email, counted before the password check. This lets someone lock an account out for the window; that is accepted.
- Email-matched invites only apply to accounts with `email_verified_at` set, and mention emails only go to verified addresses.
- `POST /api/auth/verify-email` needs a cookie session of the account the link was sent for; otherwise it answers 401 `LOGIN_REQUIRED` and the link stays unused. The web page keeps the token in `sessionStorage` (never a URL) while it sends the visitor to `/login?returnUrl=/verify-email`, and clears it once the API answered. The email names the display name that registered.
- Password reset or change clears the API token and ends all of the account's sessions; a change signs the current browser in again with a new session (its sockets reconnect). Both run in one transaction that deletes the sessions before updating the account; `updateUserApiToken` share-locks its session row before the account row, so a token minted on an old session is either cleared by the reset or refused. Sockets are disconnected after the commit.
- Socket handshakes check `Origin` (`allowRequest`), then an `io.use()` middleware validates the session without sliding (`attachBoardSockets` in `server.ts`, also used by `initTestServer`). `connection` only fires for authenticated sockets and registers the client's listeners synchronously, so events sent right after `connect` are handled. A refused handshake reaches the browser as `connect_error` (`unauthenticated` or `server_error`) and leaves the socket inactive; `ws.service.ts` then rechecks the session. Sessions that end later still get `auth_error` before the disconnect.
- Never log a `DrizzleQueryError` (or an error wrapping one) directly: its message and stack contain the query params (password hashes, board state). Use `logError` from `log-error.ts`; the Fastify error handler and tRPC formatter answer unexpected errors with a generic message.

## Testing Locally

- Run the API with `pnpm start:api` and `NODE_ENV=development` (for example in `.env`; `nx serve` does not set it). Without SMTP, reset and verification links are logged as `Tapiz password reset link for ...` / `Tapiz email verification link for ...`. Outside development, set `AUTH_LOG_RESET_LINKS=true` to log them.
- Open a board as a guest: turn on link sharing, then open the board URL in a private window.
- Unit specs: `src/app/auth/*.spec.ts`. Integration specs: `src/tests/api-auth.spec.ts`, `permissions.spec.ts`, `ws.spec.ts`, `file-upload.spec.ts`, run with `pnpm exec nx test api` against the Postgres from `.env`.
- Test helpers (`createUser`, `createGuest`, `getAuth`, `getGuestAuth`) live in `apps/api/src/tests/test-helpers.ts`; test accounts get a verified email.
