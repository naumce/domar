# Deploying domar

One server, three containers: `db` (Postgres 16), `api` (Fastify + the built web app) and `caddy`
(automatic HTTPS). Everything is driven by `docker-compose.prod.yml` and one `.env` file.

## Prerequisites

- A host with Docker and the compose plugin, ports 80 and 443 free.
- A DNS A record pointing your domain at the host — Caddy issues the certificate on first start.

## First deploy

    git clone <repo> /srv/domar && cd /srv/domar
    cp .env.example .env
    # set DOMAIN and POSTGRES_PASSWORD (compose refuses to start while either is empty)
    docker compose -f docker-compose.prod.yml up -d --build

Open `https://$DOMAIN`, register the first organization — its first user is the `owner` who can then
create the rest of the staff from Settings → Users.

## Environment

Only eight variables come from `.env`; compose interpolates them into the stack:

| Variable | Used by | Default |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | `db` and the api's `DATABASE_URL` | none — compose fails without it |
| `POSTGRES_USER` | `db`, `DATABASE_URL`, `pg_isready` | `domar` |
| `POSTGRES_DB` | `db`, `DATABASE_URL` | `domar` |
| `DOMAIN` | Caddy's site address and the api's `CORS_ORIGINS` | none — compose fails without it |
| `TZ` | `db` and `api` | `Europe/Skopje` |
| `SMTP_URL` | `api` — outgoing mail; empty disables email | empty |
| `EMAIL_FROM` | `api` — envelope sender | `domar <no-reply@$DOMAIN>` |
| `JOB_TOKEN` | `api` — the reminder cron's shared secret | none — compose fails without it |
| `PUBLIC_WEB_URL` | `api` — set from `DOMAIN`; the registration link in portal invite emails | `https://$DOMAIN` |
| `DATA_DIR` | `api` — where uploaded documents are written (a named volume) | `/data` in the image |

Generate `JOB_TOKEN` with `openssl rand -hex 32`; the api refuses to start with a token shorter
than 16 characters.

`POSTGRES_PASSWORD` is substituted into `DATABASE_URL` unescaped, so keep it URL-safe: letters,
digits, `-` and `_`. `BACKUP_DIR` is read from `.env` by `scripts/backup.sh` only.

Every other application variable is fixed in the compose `environment:` block (`NODE_ENV=production`,
`SERVE_WEB=true`, `API_HOST`, `API_PORT`, `TRUST_PROXY=1`, `PDF_BROWSER_CHANNEL=chromium`) or in the
image itself, so the `SERVE_WEB`/`WEB_DIST`/`API_*` entries in `.env.example` are for local runs, not
for the stack. The session cookie is `Secure` because `NODE_ENV=production` (`isProduction`), and
`TRUST_PROXY=1` makes rate limiting see the client IP Caddy forwards.

## Migrations, failures and rollback

The api container runs `pnpm --filter @domar/db migrate` on every start
(`scripts/docker-entrypoint.sh`) and only then execs the server. If a migration fails the container
exits and `restart: unless-stopped` puts it in a restart loop, so the new version never serves
traffic — but the old container is already gone, so the site is down until you act:

    docker compose -f docker-compose.prod.yml logs --tail 50 api   # read the migration error
    git checkout <previous commit>
    docker compose -f docker-compose.prod.yml up -d --build api

If the failed migration got part way through, roll the database back too: restore the last backup
(below) before starting the old image again.

## Updating

    cd /srv/domar && git pull
    docker compose -f docker-compose.prod.yml up -d --build api

Caddy waits for the api's health check (`GET /api/health`) before it is considered up.

## Reminders

domar has no in-process scheduler. `POST /api/jobs/reminders` evaluates every building of every
tenant and is authenticated by the `x-job-token` header alone, so anything that can make an HTTPS
request can drive it. One host crontab line is enough — the api container only `expose`s 3001, so
the request goes through Caddy:

    5 3 * * * cd /srv/domar && . ./.env && curl -fsS -m 300 -X POST -H "x-job-token: $JOB_TOKEN" "https://$DOMAIN/api/jobs/reminders" >> /var/log/domar-reminders.log 2>&1

`. ./.env` reads `JOB_TOKEN` and `DOMAIN` out of the same file compose uses; every value in `.env`
that contains spaces must be quoted for that to work (`.env.example` already quotes `EMAIL_FROM`).
The job is idempotent: a reminder is never created twice for the same debt inside 30 days, so a
missed night or a double run costs nothing. `-m 300` only gives up on the response — the run itself
continues on the server, so a timed-out line in the log is not a reason to fire the job again. The
answer counts what happened: `{"tenants","buildings","reminders","failed"}`, where `failed` is the
number of buildings whose run threw. The endpoint answers `401` without the header, `403`
with the wrong token and `503` when `JOB_TOKEN` is unset on the server.

Without `SMTP_URL` the mailer is a no-op, so every reminder is queued as a printable letter instead:
it is created as `pending`, its letter is rendered at `GET /api/reminders/:id/pdf`, and the manager
records the delivery with "mark printed". When SMTP is configured but a send fails, the reminder is
recorded as `failed` and the "Reminders" tab offers both a resend and "mark printed". Settings shows
whether email is configured at all.

For local development, `docker compose up -d mailpit` gives SMTP on `localhost:1025` and a web
inbox on `http://localhost:8025`; point `SMTP_URL=smtp://localhost:1025` at it.

## Notifications

Notification rows are written by the events that cause them (a published period, a new reminder, an
assembly invitation, an assembly's voting opening, a maintenance status change, a request filed from
the portal). Sending them is a second job, on the same shared token:

    */5 * * * * cd /srv/domar && . ./.env && curl -fsS -m 120 -X POST -H "x-job-token: $JOB_TOKEN" "https://$DOMAIN/api/jobs/notifications" >> /var/log/domar-notifications.log 2>&1

Every five minutes, because a notification is worth little an hour late. The job claims the
undelivered rows in chunks of 10 under `for update skip locked`, stamping each chunk's `delivered_at`
before it sends that chunk, so two overlapping runs split the queue and a crash costs at most those
ten rows — never the whole queue, and never a double send. The ten are delivered concurrently, and
one row's fan-out to all the browsers behind it is bounded at 15 seconds (at most ten registered
browsers per owner account, the least recently seen evicted beyond that), so a chunk of dead
endpoints costs roughly one such bound rather than one 10-second push timeout per row. The job also
carries its own 60-second wall-clock budget, checked between chunks: it stops cleanly and returns
what it did rather than running past the cron tick. `-m 120` is exactly twice that budget, which is
the margin a healthy run answers inside. Like the reminder job's `-m 300`, `-m 120` only gives up on
*waiting for the response* — the run itself continues server-side, so a timed-out line in the log is
not a reason to fire the job again; it is the client's ceiling, not the drain's. The answer counts
what happened: `{"claimed","pushed","emailed","failed"}`. It answers `401` without the header, `403` with the wrong
token and `503` when `JOB_TOKEN` is unset — the same three answers as the reminder job.

Web Push needs a VAPID key pair. Generate one once, put both halves in `.env`, and never rotate them
without expecting every installed portal to resubscribe:

    docker compose -f docker-compose.prod.yml run --rm api pnpm --filter @domar/api exec web-push generate-vapid-keys

`.env` alone is not enough: `docker-compose.prod.yml`'s `api` service lists its environment
explicitly (no `env_file`), so `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` each have
their own `${...}` entry there too, the same way `SMTP_URL` and `EMAIL_FROM` do — a key pair sitting
only in `.env` never reaches the container. `VAPID_SUBJECT` is the `mailto:` or `https:` contact a
push service may use to reach the operator; left unset it defaults to `mailto:no-reply@localhost`.

With `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` unset, push is simply off: the portal hides the "enable
notifications" button, every notification falls through to email, and nothing fails. Push payloads
carry a title and a link and nothing else — the amount is loaded in the app, behind the session
(spec §11). A push service answering `404` or `410` has retired that endpoint, and domar deletes the
subscription. A deactivated owner login is skipped outright — neither pushed nor emailed, since
nobody can read either. When neither push nor email delivered, the managers of that tenant get one
bell entry per run summarising how many failed, which is the signal that `SMTP_URL` needs looking
at; a backlog from an SMTP outage does not flood the bell with one row per notification.

## Why the image runs `tsx`

`@domar/db` and `@domar/domain` are workspace packages whose `exports` point at TypeScript sources, so
the dev, test and production paths all load the same files. A `tsc`-emitted `apps/api/dist` would still
import `@domar/db` and hand Node a `.ts` file, and `pnpm deploy` would copy those packages into
`node_modules` where that resolution breaks. The image therefore keeps the workspace layout and starts
the API as `node --import tsx src/index.ts` — node itself is PID 1, so `docker stop` reaches the
`SIGTERM` handler that closes Fastify and the PDF browser. `pnpm --filter @domar/api build`
(`tsc -p tsconfig.build.json`) runs during the image build purely as the type gate.

The runtime stage runs as the image's unprivileged `pwuser`.

## PDFs

The base image is `mcr.microsoft.com/playwright:v1.63.0-noble`, matching the exactly pinned
`playwright-core`, and the container sets `PDF_BROWSER_CHANNEL=chromium` so invoice PDFs use the
browser that ships in it. Bump the tag and `playwright-core` together. `init: true` on the api service
reaps the helper processes Chromium leaves behind.

## Backups

`scripts/backup.sh` writes `$BACKUP_DIR/domar-YYYY-MM-DD-HHMM.sql.gz` (default `./backups`), reads
`.env` for `POSTGRES_USER`/`POSTGRES_DB`, writes to a `.part` file first, refuses to keep a dump
smaller than 1 KB, and only rotates to the newest 14 after a good write. From cron:

    15 2 * * * cd /srv/domar && ./scripts/backup.sh >> /var/log/domar-backup.log 2>&1

Restoring replaces the database, so the api must be down first and the database recreated — `psql`
into a database that still holds the old schema will not give you a clean restore:

    cd /srv/domar
    docker compose -f docker-compose.prod.yml stop api
    docker compose -f docker-compose.prod.yml exec -T db dropdb -U domar --force domar
    docker compose -f docker-compose.prod.yml exec -T db createdb -U domar domar
    gunzip -c backups/domar-2026-10-01-0215.sql.gz \
      | docker compose -f docker-compose.prod.yml exec -T db psql -U domar -v ON_ERROR_STOP=1 domar
    docker compose -f docker-compose.prod.yml start api

Use your own `POSTGRES_USER`/`POSTGRES_DB` in place of `domar` if you changed them.

`pg_dump` does not contain uploaded documents: they live in the `domar-data` volume, outside the
database. Back it up alongside the dump, for example from the same cron line:

    docker run --rm -v domar_domar-data:/data:ro -v /srv/domar/backups:/out alpine \
      tar czf /out/domar-documents-$(date +%Y-%m-%d-%H%M).tar.gz -C /data .

Restoring a database dump without the matching document archive leaves every `documents` row
pointing at a file that is not there; downloads then answer 500 while everything else keeps working.
