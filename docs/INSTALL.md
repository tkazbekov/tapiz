## Prerequisites

- Docker installed on your system.
- An SMTP server (optional, but needed to email password reset and email verification links).

## Installation & Configuration

Follow these steps to set up Tapiz using Docker:

1. **Copy the Example Environment File**  
   Create a copy of the example environment file `.env.example` and name it `.env`:

   ```bash
   cp .env.example .env
   ```

2. **Use the Default Environment Variables (Optional)**  
   The default settings in the `.env` file are suitable for local development using Docker. Specifically, the default PostgreSQL credentials are:

   - **Database User**: `tapiz_user`
   - **Database Password**: `tapiz_password`

   These defaults can be used in a local development environment, but **it is strongly recommended to change them** before deploying to production.

3. **Build and Run the Docker Containers**  
   After configuring your environment variables, build and start the Docker containers by running:

   ```bash
   docker-compose up -d
   ```

4. **Access the Application**  
   Your Tapiz application will be available at [http://localhost:4300](http://localhost:4300).

## Accounts and Guests

Tapiz has its own email and password accounts; no external identity provider is needed. Anyone who can reach the app can register.

A board admin can turn on "anyone with the link" sharing for a board. Visitors who open the link without an account pick a display name and join as a guest. Guests can edit the board and be @mentioned (in-app only), but they can't upload files, become board admins, create or duplicate boards, use teams, or hold API tokens. A guest who registers keeps the same identity, so their board content and mentions carry over. Turning link sharing off removes guest access.

## Upgrading from Google Login

Earlier versions signed in with Google. The `0011_own_auth` migration runs automatically when the API starts: it removes Google sign-in, ends all existing sessions, and leaves every existing account without a password and with an unverified email. Boards, teams and other data are kept.

Existing users sign in again through "Forgot password?" on the login page, using the same email address as their Google account. Completing the reset also verifies the email, so email-matched team invitations work again for that account. This needs SMTP, or `AUTH_LOG_RESET_LINKS=true` set temporarily so the links appear in the API log (`docker compose logs api`); the Docker Compose API runs with `NODE_ENV=production`, so links are not logged otherwise. The `GOOGLE_CLIENT_*` variables are no longer used and can be removed from `.env`.

## Email (SMTP)

Set the `SMTP_*` variables so Tapiz can send password reset links, email verification links, team invitations, and mention notifications. Team invitations sent to an email address only match accounts that have verified their email.

Without SMTP (and without `AUTH_LOG_RESET_LINKS=true`), accounts can't verify their email, so team invitations by email address never match anyone, and password resets are impossible. With `NODE_ENV=development`, or with `AUTH_LOG_RESET_LINKS=true`, reset and verification links are written to the API log instead. Only enable that in production if you trust everyone who can read the logs.

## Domains, HTTPS and Cookies

Sessions use the `tapiz_session` cookie with `SameSite=Lax`, so `FRONTEND_URL` and `API_URL` must be on the same site and use the same scheme (both `http` or both `https`): ports and subdomains may differ (`app.example.com` and `api.example.com`), registrable domains may not. Login will not work across sites.

When `API_URL` uses `https`, the cookie is marked `Secure` automatically. `SESSION_COOKIE_SECURE=true|false` overrides that; don't set it to `true` while serving plain http, or browsers will drop the cookie.

## Reverse Proxy and Client IPs

Rate limits key on the client IP. By default the API uses the address of the TCP connection and ignores `X-Forwarded-For`, which is right when browsers talk to the API directly (as with the default `API_URL=http://localhost:8000/api`).

To serve the API through the bundled nginx, which forwards `/api/` and `/socket.io/` to it, point the browser at the web container: set `API_URL` to `${FRONTEND_URL}/api` and `WS_URL` to the same host with `ws`/`wss`, for example:

```dotenv
FRONTEND_URL=https://tapiz.example.com
API_URL=https://tapiz.example.com/api
WS_URL=wss://tapiz.example.com
TRUST_PROXY=1
```

`API_URL` and `WS_URL` are baked into the web bundle at build time, so rebuild the web image after changing them; a restart is not enough:

```bash
docker compose build web && docker compose up -d
```

Then make sure clients can reach the API **only** through the proxy, otherwise anyone can spoof `X-Forwarded-For` and dodge rate limits. With Docker Compose, bind the published API port to the loopback interface, or stop publishing it:

```yaml
api:
  ports:
    - '127.0.0.1:${API_PORT}:${API_PORT}'
```

`TRUST_PROXY=1` is correct when the bundled nginx is the outermost proxy. `nginx.conf` sets `X-Forwarded-For` to its own peer address, replacing any incoming value, so with another proxy in front of it (a TLS terminator such as Caddy or Traefik) every client would get that proxy's IP and share one rate limit. In that case change `$remote_addr` to `$proxy_add_x_forwarded_for` in both `X-Forwarded-For` lines of `nginx.conf`, rebuild the web image, and set `TRUST_PROXY` to the total number of proxies, for example `2`. `TRUST_PROXY` also accepts the proxy IP/CIDR instead of a count. Any other proxy that fronts the API directly must set `X-Forwarded-For`.
