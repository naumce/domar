# Deploying domar

One server, three containers: `db` (Postgres 16), `api` (Fastify + the built web app) and `caddy`
(automatic HTTPS). Everything is driven by `docker-compose.prod.yml` and one `.env` file.

## Prerequisites

- A host with Docker and the compose plugin, ports 80 and 443 free.
- A DNS A record pointing your domain at the host — Caddy issues the certificate on first start.

## First deploy

    git clone <repo> /srv/domar && cd /srv/domar
    cp .env.example .env
    # set DOMAIN, POSTGRES_PASSWORD; leave SERVE_WEB/API_HOST to the image defaults
    docker compose -f docker-compose.prod.yml up -d --build

The API container runs `pnpm --filter @domar/db migrate` on every start (`scripts/docker-entrypoint.sh`)
and only then starts serving, so a failed migration keeps the old container's traffic off.
Open `https://$DOMAIN`, register the first organization — its first user is the `owner` who can then
create the rest of the staff from Settings → Users.

## Updating

    cd /srv/domar && git pull
    docker compose -f docker-compose.prod.yml up -d --build api

## Why the image runs `tsx`

`@domar/db` and `@domar/domain` are workspace packages whose `exports` point at TypeScript sources, so
the dev, test and production paths all load the same files. A `tsc`-emitted `apps/api/dist` would still
import `@domar/db` and hand Node a `.ts` file, and `pnpm deploy` would copy those packages into
`node_modules` where that resolution breaks. The image therefore keeps the workspace layout and runs
`pnpm --filter @domar/api start` (`tsx src/index.ts`), exactly like `pnpm dev`. `pnpm --filter @domar/api build`
(`tsc -p tsconfig.build.json`) runs during the image build purely as the type gate.

## PDFs

The base image is `mcr.microsoft.com/playwright:v1.63.0-noble`, matching the pinned `playwright-core`,
and the container sets `PDF_BROWSER_CHANNEL=chromium` so invoice PDFs use the browser that ships in it.
Bump the tag and `playwright-core` together.

## Backups

`scripts/backup.sh` writes `backups/domar-YYYY-MM-DD-HHMM.sql.gz` and keeps the newest 14. From cron:

    15 2 * * * cd /srv/domar && ./scripts/backup.sh >> /var/log/domar-backup.log 2>&1

Restore into a running stack:

    gunzip -c backups/domar-2026-10-01-0215.sql.gz | docker compose -f docker-compose.prod.yml exec -T db psql -U domar domar

## Environment

Every variable is documented in `.env.example`. In production the session cookie is `Secure` because
`NODE_ENV=production` (`isProduction`), and `TRUST_PROXY=1` makes rate limiting see the client IP that
Caddy forwards.
