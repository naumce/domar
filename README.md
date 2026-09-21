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
