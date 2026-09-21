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

    pnpm e2e

(needs Google Chrome; uses the dev database on port 5180 for the web server)

## Billing

Define services (organization-wide), attach them to a building with a price and a frequency, set the
building's reserve fund, then open a monthly period. The period starts with auto lines from the due
building services; edit or add lines by hand, `generate` to produce draft invoices (one per owner),
and `publish` to number them, book the charges and lock the period. Rendering an invoice to PDF needs
Google Chrome installed (or set `PDF_BROWSER_CHANNEL` to another installed channel). Invoice numbering
uses the server's local time, so set `TZ` (see `.env.example`) on the machine running the API.
