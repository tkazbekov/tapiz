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

## Production Mode

The API Docker image sets `NODE_ENV=production`. Unexpected errors are answered with a generic message and logged without query parameters; tRPC error responses never include stack traces. The API starts listening only after the database migrations have run.

## Upgrading from Google Login

Earlier versions signed in with Google. This version also resets the database migration history to a single baseline (`drizzle/0000_baseline.sql`), so it can't upgrade a database created by an earlier version in place: the baseline migration fails against it and the API keeps retrying it, logging "Error connecting to DB". Start from an empty database (for Docker Compose, remove the Postgres volume), and the schema is created when the API starts. The `GOOGLE_CLIENT_*` variables are no longer used and can be removed from `.env`.

## Email (SMTP)

Set the `SMTP_*` variables so Tapiz can send password reset links, email verification links, team invitations, and mention notifications. Team invitations sent to an email address only match accounts that have verified their email, and mention notifications are only emailed to verified addresses.

A verification link only works while signed in to the account it was sent for: opened in a signed-out browser, it asks to sign in first and then verifies. The email names the account that registered the address, so the owner of an address someone else signed up with can ignore it.

Without SMTP (and without `AUTH_LOG_RESET_LINKS=true`), accounts can't verify their email, so team invitations by email address never match anyone, and password resets are impossible. With `NODE_ENV=development`, or with `AUTH_LOG_RESET_LINKS=true`, reset and verification links are written to the API log instead. Only enable that in production if you trust everyone who can read the logs.

## Domains, HTTPS and Cookies

Sessions use the `tapiz_session` cookie with `SameSite=Lax`, so `FRONTEND_URL` and `API_URL` must be on the same site and use the same scheme (both `http` or both `https`): ports and subdomains may differ (`app.example.com` and `api.example.com`), registrable domains may not. Login will not work across sites.

When `API_URL` uses `https`, the cookie is marked `Secure` automatically. `SESSION_COOKIE_SECURE=true|false` overrides that; don't set it to `true` while serving plain http, or browsers will drop the cookie.

## Reverse Proxy and Client IPs

Rate limits key on the client IP. By default the API uses the address of the TCP connection and ignores `X-Forwarded-For`, which is right when browsers talk to the API directly (as with the default `API_URL=http://localhost:8000/api`).

To serve the API through the bundled nginx, which forwards `/api/` and `/socket.io/` to it, point the browser at the web container: set `API_URL` to your `FRONTEND_URL` followed by `/api` and `WS_URL` to the same host with `ws`/`wss`, for example:

```dotenv
FRONTEND_URL=https://tapiz.example.com
API_URL=https://tapiz.example.com/api
WS_URL=wss://tapiz.example.com
TRUST_PROXY=1
API_BIND_HOST=127.0.0.1
```

`API_URL` and `WS_URL` are baked into the web bundle at build time, so rebuild the web image after changing them; a restart is not enough:

```bash
docker compose build web && docker compose up -d
```

Clients must reach the API **only** through the proxy, otherwise anyone can spoof `X-Forwarded-For` and dodge rate limits. `API_BIND_HOST=127.0.0.1` makes Docker Compose publish the API port on the loopback interface only; without Compose, firewall the API port instead.

`TRUST_PROXY=1` is correct when the bundled nginx is the outermost proxy. `nginx.conf` sets `X-Forwarded-For` to its own peer address, replacing any incoming value, so with another proxy in front of it (a TLS terminator such as Caddy or Traefik) every client would get that proxy's IP and share one rate limit. In that case change `$remote_addr` to `$proxy_add_x_forwarded_for` in both `X-Forwarded-For` lines of `nginx.conf`, rebuild the web image, and set `TRUST_PROXY` to the total number of proxies, for example `2`. `TRUST_PROXY` also accepts the proxy IP/CIDR instead of a count. Any other proxy that fronts the API directly must set `X-Forwarded-For`.

## Content Security Policy

The bundled `nginx.conf` sends a `Content-Security-Policy` header for the web app that blocks inline and third-party scripts. Its `connect-src` allows the same origin (the nginx `/api/` and `/socket.io/` proxy), any `https:`/`wss:` origin, and `http://localhost:*`/`ws://localhost:*` for the default `.env`. If browsers reach a plain-http API on another host (for example `API_URL=http://10.0.0.5:8000/api`), add that origin to `connect-src` (both `http://10.0.0.5:8000` and `ws://10.0.0.5:8000`) and to `img-src` (uploaded images), then rebuild the web image.
