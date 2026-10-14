# Production deployment

This opt-in Compose setup preserves the OptiPlex deployment without requiring
an old development worktree, a prebuilt dist directory, or a second Dockerfile.
The existing root Compose/nginx setup remains unchanged for other installations.

## Configure

Run from this directory (`deploy/production`) in a checkout of the desired release.
Copy `.env.example` to `.env`, set its real public HTTPS/WSS origins, exact connector
IPv4, bind address and unique image tags, and protect it with mode 0600. Generate a
random hex database password and use the **same** value for POSTGRES_PASSWORD and
`secrets/db_password` (also 0600, parent directory 0700). The API uses the private
runtime environment; PostgreSQL uses the file-backed Compose secret.

The current OptiPlex instance is a separate installed release in `/opt/tapiz`.
Do not replace its .env/secrets or attach a development checkout to its database.
Copy its existing private configuration separately during an authorized migration;
never put credentials, database files, uploads or dump files in this Git repository.

## Build and launch

```sh
docker compose --env-file .env config --quiet
docker compose --env-file .env build api web
docker compose --env-file .env up -d --wait --wait-timeout 180
docker compose --env-file .env ps
```

Both app images build from the checked-out source and frozen pnpm lockfile. The web
image generates its frontend environment from API_URL/WS_URL build arguments. Its
nginx template substitutes **only** TRUSTED_PROXY_IP; nginx variables stay intact.
The original generic nginx config is still the web Dockerfile's default.

This Compose file publishes **only nginx**. API and DB ports stay Docker-private.
The configured tunnel connector is the only peer allowed to assert an external
HTTPS scheme or Cloudflare client IP. Direct/spoofed forwarding headers are not
trusted. Cookies remain Secure+HttpOnly, development agent-login and reset-link
logging are disabled. Nginx's 10 MiB upload ceiling retains the installed setup;
the API's own multipart limit is 5 MB. This differs intentionally from the generic
nginx config's 100 MiB ceiling.

SMTP is not configured by this template. Password-reset/email-verification delivery
must be set up and tested separately if wanted.

## Persistence, upgrades and rollback

`data/postgres` and `data/uploads` are bind-mounted persistent directories here.
Back them up before an upgrade; keep private settings/secrets out of Git. The API
runs database migrations at startup. Prefer unique immutable release tags, record
image IDs/digests and the Git SHA, and keep the previous images for rollback.
Rolling back an image is NOT a guarantee that database migrations are reversible.

To upgrade an existing installation, retain its advancing database/uploads and
private configuration, verify trusted connector/bind addresses, then recreate only
the intended services. A historical migration dump is not a current backup.
Never use `docker compose down -v` or delete data directories as an upgrade step.

A disposable local smoke stack may use HTTP loopback to exercise proxy routing,
but Secure cookies still require HTTPS for real browser acceptance. Rebuild for
the real public origins before production use. Building/testing this setup does
not itself deploy it to `/opt/tapiz`.
