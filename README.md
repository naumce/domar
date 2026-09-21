# domar

Operations and billing platform for licensed building managers. Phase 1 design:
`docs/superpowers/specs/2026-09-21-domar-phase1-design.md`. Business plan: `docs/BUSINESS-PLAN.md`.

## Dev

    pnpm install
    pnpm db:up
    cp .env.example .env
    pnpm --filter @domar/db migrate
    pnpm dev

API on http://localhost:3001, web on http://localhost:5173.
