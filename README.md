# domar

Operations and billing platform for licensed building managers. Phase 1 design:
`docs/superpowers/specs/2026-09-21-domar-phase1-design.md`. Business plan: `docs/BUSINESS-PLAN.md`.

## Dev

    pnpm install
    pnpm db:up
    cp .env.example .env
    pnpm --filter @domar/db migrate
    pnpm dev

API http://localhost:3001/api/health, web http://localhost:5173, OpenAPI http://localhost:3001/api/docs

Re-run `pnpm --filter @domar/db migrate` after pulling a branch that adds a migration. The API tests
build a throwaway database per run and never notice a stale dev database; `pnpm e2e` runs against the
long-lived one and fails in specs that have nothing to do with the new migration. (Production is
unaffected: the API container migrates on every start, `docs/DEPLOY.md`.)

    pnpm e2e

(needs Google Chrome; uses the dev database on port 5180 for the web server)

## Deploy

Production runs from the root `Dockerfile` and `docker-compose.prod.yml` (Postgres, the API serving
the built web app, Caddy for HTTPS). See `docs/DEPLOY.md`.

## Billing

Define services (organization-wide), attach them to a building with a price and a frequency, set the
building's reserve fund, then open a monthly period. The period starts with auto lines from the due
building services; edit or add lines by hand, `generate` to produce draft invoices (one per owner),
and `publish` to number them, book the charges and lock the period. Rendering an invoice to PDF needs
Google Chrome installed (or set `PDF_BROWSER_CHANNEL` to another installed channel). Invoice numbering
uses the server's local time, so set `TZ` (see `.env.example`) on the machine running the API.

## Migrating from another system

The building "Import" tab takes CSV and XLSX with a column-mapping step. A whole company can be
brought over from Domexa with `pnpm --filter @domar/api migrate:domexa -- export|transform|apply`;
see `docs/MIGRATION.md`.
