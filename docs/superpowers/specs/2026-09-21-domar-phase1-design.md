# Domar — Phase 1 technical design

Date: 2026-09-21. Business plan: `docs/BUSINESS-PLAN.md` (section 4, Phase 1). Working name: **domar**.

## 1. Goal of Phase 1

A licensed building manager closes a real month on domar with no spreadsheet:
buildings, units, owners, services and recurring charges are entered or imported; the monthly
calculation is generated per owner with the layout required by Art. 33 of the Law on Housing; owners
pay; bank statements are imported and matched; reminders go out under the Art. 28 rules; owners log
in to a portal and see their invoices, payments and the building's fund state (Art. 45(4)).

Out of scope for Phase 1: mobile app, maintenance requests, suppliers, documents, assembly module,
annual report, e-Faktura, card payments, accounting export, second country. The data model must not
block them.

## 2. Stack and repository layout

Decisions made with the user: Vue 3 Composition API, Node.js, PostgreSQL (Supabase-compatible so
hosting can move there), push notifications later via Supabase or Firebase.

```
domar/
  package.json              pnpm workspaces, root scripts (dev, test, lint, typecheck, db:*)
  pnpm-workspace.yaml
  docker-compose.yml        postgres:16 for local dev and tests
  .env.example
  packages/
    domain/                 pure TypeScript, no I/O: money, allocation, country packs, legal rules,
                            calculation engine, reminder rules, statement parsers (pure functions)
    db/                     Drizzle ORM schema, migrations, typed query helpers, seed
  apps/
    api/                    Fastify 5 + TypeScript. Routes, auth, tenant scoping, PDF rendering
    web/                    Vue 3 + Vite + TypeScript + Pinia + Vue Router + Tailwind. Manager
                            dashboard AND owner portal (separate route trees, same build)
  docs/
```

Tooling: TypeScript 5 strict everywhere, Vitest for all tests, ESLint + Prettier, `tsx` for dev.
Node 24. pnpm 10. No ORM magic beyond Drizzle; SQL stays readable.

Why these: Fastify is fast, typed and small; Drizzle gives typed SQL and plain migrations that run on
Supabase Postgres unchanged; pure `packages/domain` keeps money and legal rules testable without a DB.

## 3. Architecture principles (from the business plan, section 5)

1. **Multi-tenant, multi-country from the first commit.** Every tenant row carries `tenant_id`.
   A `CountryPack` object owns currency, locale, tax defaults, legal rules and document templates.
   Macedonia (`mk`) is the first pack; the core never hard-codes Macedonian rules.
2. **Ledger-first.** Every money movement is a `posting` against a building fund (`regular` or
   `reserve`) and, when it concerns one owner, an owner sub-account. Invoices, payments, expenses,
   reminders derive from postings. Balances are computed from postings, never stored as truth.
3. **Legal events are first-class.** Reminders and future deadlines are rows with delivery evidence.
4. **Import/export are products.** Owners, units and opening balances import from CSV/XLSX with a
   mapping step; every entity list exports.
5. **Money is integer minor units.** `amount_minor: bigint` in Postgres, `number` in TS (amounts
   stay far below 2^53). Currency per tenant. Splitting uses the largest-remainder method so the
   parts always sum to the whole.

## 4. Domain model

Entities (all tenant-scoped unless noted):

- `tenant` — the management company. `slug`, `name`, `country_code`, `currency`, `locale`,
  company/VAT/bank details, number format. Not tenant-scoped (it is the tenant).
- `user` — staff login. `email` unique per tenant, `password_hash` (argon2id), `role`
  (`owner`, `accountant`, `technician`, `readonly`).
- `owner_account` — owner login, separate table from `user`. `email`, `password_hash`, links to
  one or more `contact` rows across tenants (an owner may own units under two managers).
- `contact` — person or company. `kind` (`person`|`company`), names, `company_number`, `vat_number`,
  `email`, `phone`, `address`. Companies matter for e-Faktura later.
  Deletion: contacts hard-delete while nothing financial references them; invoices, payments and
  postings (sub-plans 2–3) reference contacts with `ON DELETE RESTRICT`, so a contact with
  financial history cannot be deleted and must be archived instead (archive flag arrives with
  sub-plan 2).
- `building` — name, address fields, `representative_contact_id`, `regular_fund_account` and
  `reserve_fund_account` (IBAN strings), `share_basis` (`area`|`equal`|`custom`).
- `unit` — `building_id`, `label`, `floor`, `kind` (`apartment`|`commercial`|`parking`|`storage`|
  `other`), `area_m2` (numeric, nullable), `ownership_share` (numeric, nullable; per Art. 47(5)),
  `owner_contact_id`, `attached_to_unit_id` (parking/storage billed with an apartment).
- `service` — catalog item: name, category, `pricing` (`fixed_per_unit`|`per_m2`|`shared_total`),
  `default_price_minor`, `tax_rate_id`, `applies_to` (unit kinds, empty = all), `recurring` bool.
- `tax_rate` — name, rate (basis points), default flag.
- `building_service` — recurring attachment of a service to a building with optional overrides and
  a `frequency` (`monthly`|`every_n_months`), `starts_period`, `ends_period`.
- `reserve_fund_setting` — per building: `basis` (`per_unit`|`per_m2`), `amount_minor`,
  `applies_to` kinds, `active`, history kept by `valid_from`.
- `billing_period` — per building per `YYYY-MM`: `status` (`open`|`generated`|`published`),
  `management_fee_minor`, `number_prefix`, `number_suffix`.
- `period_line` — line on the master calculation: service or free text, pricing, quantity, price,
  tax rate, `applies_to`, `source` (`auto`|`manual`), `fund` (`regular`|`reserve`).
- `invoice` — one per owner per period: number, `contact_id`, `unit_ids`, `status`
  (`draft`|`published`|`partially_paid`|`paid`|`cancelled`), `issued_at`, `due_at`, totals,
  `previous_balance_minor`, `reserve_fund_balance_building_minor` (snapshot for Art. 33).
- `invoice_line` — per invoice: description, building-wide amount, owner's share, tax, fund.
- `payment` — `invoice_id` nullable (unallocated allowed), `contact_id`, `amount_minor`, `method`
  (`cash`|`bank_transfer`|`card`|`other`), `paid_at`, `reference`, `statement_line_id`, `status`
  (`completed`|`voided`), `void_reason`.
- `posting` — ledger: `building_id`, `fund`, `contact_id` nullable, `amount_minor` (signed),
  `kind` (`charge`|`payment`|`expense`|`adjustment`|`opening`), `ref_type`, `ref_id`, `booked_at`.
- `expense` — money leaving a fund: `building_id`, `fund`, description, `amount_minor`, `paid_at`,
  `supplier_text` (supplier entity comes in Phase 2).
- `bank_statement` + `statement_line` — imported file, per line: date, amount, counterparty,
  reference, raw text, `match_status` (`unmatched`|`suggested`|`matched`|`ignored`), `payment_id`.
- `reminder` — `contact_id`, `invoice_ids`, `rule` (`two_consecutive`|`three_total`), `channel`
  (`email`|`sms`|`letter`), `sent_at`, `delivery_status`, rendered document stored.
- `audit_log` — who, what, entity, before/after JSON, when.
- `import_job` — file, mapping JSON, status, row errors.

## 5. Country pack interface (packages/domain)

```ts
export interface CountryPack {
  code: 'mk';                         // union grows per country
  currency: 'MKD';
  locale: string;                      // 'mk-MK'
  defaultTaxRates: { name: string; rateBp: number; isDefault: boolean }[];
  invoiceLayout: {
    // Art. 33: what a monthly calculation must show
    showBuildingWideAmountPerLine: true;
    showManagementFeeLine: true;
    showReserveFundContribution: true;
    showReserveFundBuildingBalance: true;
    showPreviousBalance: true;
  };
  reminderRules: {
    // Art. 28: reminder after 2 consecutive unpaid or 3 unpaid total, no fee
    consecutiveUnpaid: 2;
    totalUnpaid: 3;
    feeAllowed: false;
    channels: ('email' | 'sms' | 'letter')[];
  };
  statementParsers: StatementParser[];   // MT940, bank CSV/XLS variants
  formatMoney(minor: number): string;
  templates: { invoice: string; reminder: string };  // template ids
}
```

## 6. Monthly calculation engine (packages/domain/calculation)

Input: building, units (with owners, areas, shares, attachments), period lines (auto from
`building_service` + reserve fund + management fee, plus manual), open balances per owner.
Output: one `InvoiceDraft` per owner with lines.

Rules:
- `fixed_per_unit`: each covered unit pays `price`.
- `per_m2`: `price × area_m2`; units without area contribute 0 and are reported in `warnings`.
- `shared_total`: total split across covered units by `share_basis` (area, equal or custom share);
  largest-remainder so the sum equals the total.
- `applies_to` filters unit kinds; empty means all.
- Units `attached_to` an apartment are folded into the apartment owner's invoice.
- One invoice per owner per building per period even if they own several units.
- Reserve fund contribution is a separate line in fund `reserve`, tax-free.
- Management fee is a separate line (Art. 33).
- Previous balance = owner's sub-account balance before this period's charges.
- Every line carries `buildingWideAmountMinor` and `ownerAmountMinor` (Art. 33).

Engine is pure and deterministic; a JSON fixture in tests locks the numbers.

## 7. Ledger rules

- Generating a period writes `charge` postings per invoice line (owner sub-account, fund).
- Recording a payment writes a `payment` posting (negative charge) against the owner and fund; if
  the invoice mixes funds, allocate proportionally by outstanding amount per fund.
- Voiding a payment writes an offsetting posting; nothing is deleted.
- Expenses write `expense` postings at building level (no owner).
- Opening balances are `opening` postings created by import.
- Balance queries: per owner (sum where contact_id), per building fund (sum where fund).

## 8. Bank reconciliation

- Upload a statement file. The pack's parsers are tried in order; the first that recognizes the
  file yields normalized lines.
- Matching, in order: exact invoice number in reference; exact amount + owner name similarity;
  else unmatched. Confidence recorded. Matched lines create `payment` rows on confirm.
- A review queue lists suggested and unmatched lines. Nothing is booked without confirmation
  except exact invoice-number matches, which auto-confirm (configurable per tenant).
- MT940 parser first (UniBank exports it; widely supported). CSV/XLS parsers are added per bank
  from real anonymized files collected in Phase 0.

## 9. Reminders (Art. 28)

- Nightly job evaluates each owner: unpaid published invoices past due. If two consecutive
  periods unpaid, or three unpaid in total, and no reminder for that set in the last 30 days, create a
  `reminder` with the rendered document and send via email (SMS in Phase 2). Letter PDF always
  generated for paper delivery. No fee line is ever added; the rule object forbids it.

## 10. Auth and tenancy

- Staff: email + password (scrypt (Node crypto, N=2^17, r=8, p=1; no native dependency)), session cookie (httpOnly, SameSite=Lax), server-side session
  table with expiry. Tenant resolved from the session, never from the URL.
- Owners: separate `owner_account`, same mechanism, separate cookie name, routes under
  `/api/portal/*`. Magic-link login added later.
- Every repository function takes a `TenantContext { tenantId, userId }` as first argument.
  A test asserts no table (except `tenant`, `owner_account`, `session`) lacks `tenant_id`.
- Rate limiting on login endpoints. Passwords min 10 chars.

## 11. API shape

Fastify with `zod` schemas and generated OpenAPI at `/api/docs`. JSON only. Errors as
`{ error: { code, message, details? } }`. Pagination `?page&pageSize`. Money fields end in
`Minor`. Dates are ISO strings; periods are `YYYY-MM`.

Route groups: `/api/auth`, `/api/tenant`, `/api/users`, `/api/contacts`, `/api/buildings`,
`/api/buildings/:id/units|services|reserve-fund|periods|expenses|statements`, `/api/services`,
`/api/tax-rates`, `/api/invoices`, `/api/payments`, `/api/reminders`, `/api/imports`,
`/api/portal/*`.

## 12. Web app

Vue 3 + Vite + TypeScript + Pinia + Vue Router + Tailwind + Headless UI. Two route trees:
`/app/*` (manager) and `/portal/*` (owner). i18n from day one (`vue-i18n`), Macedonian and English.
Components are small; pages compose them. Server state via a thin typed fetch client generated
from the API's zod schemas (shared package types). No component library lock-in.

## 13. PDF

Invoice and reminder PDFs rendered server-side from HTML templates (per country pack) with
Playwright's Chromium (already used locally; on the server run headless in the API container).
Templates are Vue SFC-free plain HTML with a tiny template function to keep rendering deterministic.

## 14. Testing strategy

- `packages/domain`: unit tests, fixtures for calculation and parsers. Coverage target 90%.
- `packages/db`: migration up/down test against Docker Postgres; tenant_id presence test.
- `apps/api`: integration tests with a real Postgres (Testcontainers-style via docker compose
  service on a random DB name per run). Auth, tenancy isolation, generate/publish/pay flows.
- `apps/web`: component tests with Vitest + Vue Test Utils for calculation-heavy components;
  one Playwright smoke test (login → create building → generate period → view invoice).
- CI: GitHub Actions running lint, typecheck, all tests with a Postgres service.

## 15. Phase 1 sub-plans (each ships working software)

1. **Foundation**: monorepo, Postgres, migrations, tenant + staff auth, country pack `mk`, contacts,
   buildings, units, tax rates. API + web CRUD. (this plan: `docs/superpowers/plans/2026-09-21-01-foundation.md`)
2. **Billing core**: services, building services, reserve fund, calculation engine, periods,
   invoices, ledger postings, publish, PDF.
3. **Money in**: payments, void, ledger balances, bank statement import (MT940), matching, review queue.
4. **Reminders**: Art. 28 evaluation job, email sending, letter PDF, evidence.
5. **Owner portal**: owner accounts, invoices, payments, fund transparency.
6. **Import**: CSV/XLSX import with mapping for units, owners, opening balances; Domexa migration
   script using its JSON API.

## 16. Global constraints

- Node `>=24`, pnpm `>=10`, TypeScript strict, ESM only.
- Postgres 16; schema must run unchanged on Supabase Postgres (no superuser-only extensions;
  `pgcrypto`/`uuid-ossp` allowed).
- Every tenant-scoped table has `tenant_id uuid not null` and an index starting with it.
- Money columns: `bigint`, suffix `_minor`. Never `float`.
- All user-facing strings in the web app go through i18n; Macedonian first, English second.
- No secrets in the repo; `.env.example` documents every variable.
- Commit after every green test cycle; conventional commit messages.

## 17. Sub-plan "Pilot ready" (added 2026-09-24)

Inserted before sub-plans 4–6 so one design-partner company can run a real billing month. Four
deliverables; anything else waits for feedback from that month.

1. **Owner opening balances.** A migrating building carries existing owner debts and credits.
   `POST /buildings/:id/opening-balances` books one owner posting per row: `account 'owner'`,
   `kind 'opening'`, `refType 'opening_balance'`, signed `amountMinor` (positive = owner owes),
   `fund` regular or reserve, `bookedAt` (default now), optional note. Owner account only — fund
   cash is not touched (fund opening balances already exist under `/reserve-fund/opening-balance`).
   Bulk body `{ rows: [...] }` in one transaction. Refused with `409 period_published` when the
   building already has a published period unless `force: true` (audited). Web: "Opening balances"
   tab listing owners with current balance and an amount input per owner.
2. **Staff users.** Owners manage their own staff without email: `GET /users`, `POST /users`
   (owner only; server generates a 16-char temporary password returned once in the response),
   `PATCH /users/:id` (role, `isActive`), `POST /users/:id/reset-password` (owner only; new temporary
   password returned once), `POST /auth/change-password` (self; current + new password). `users`
   gains `is_active boolean not null default true`. Login and existing sessions are refused for an
   inactive user; deactivating deletes the user's sessions. The last active owner cannot be
   deactivated or demoted (`409 last_owner`). Web: a "Users" section on the settings page plus a
   change-password form for the signed-in user.
3. **CSV import of units and owners.** Fixed template, header names accepted in English or
   Macedonian: `label;floor;kind;areaM2;ownershipShare;ownerFirstName;ownerLastName;ownerEmail;
   ownerPhone;openingBalance` (`;` or `,`, UTF-8 with optional BOM, decimal comma or point). Parsing
   and validation live in `packages/domain/src/import/units.ts` (pure): returns rows with
   `{ ok, errors[] }` per line and never throws. `POST /buildings/:id/import/units?dryRun=true`
   returns the preview (rows, per-row errors, counts, existing-label conflicts); without `dryRun`
   it creates in one transaction: contacts (matched by email when present, else by exact
   first+last name within the tenant, else created), units (existing label → `409` unless
   `mode: 'skip'`), and opening balances for non-zero `openingBalance`. Web: "Import" tab with
   file input, preview table with row errors, template download, commit button.
4. **Production packaging.** Multi-stage `Dockerfile` (root) building `@domar/api` and
   `@domar/web`; the API serves `apps/web/dist` through `@fastify/static` with an SPA fallback
   when `SERVE_WEB=true`; migrations run on container start (`pnpm --filter @domar/db migrate`);
   `docker-compose.prod.yml` with `db`, `api`, and `caddy` (automatic HTTPS from `DOMAIN`);
   `scripts/backup.sh` (pg_dump to a dated file, keeps 14); `docs/DEPLOY.md`. Session cookie
   `secure` follows `isProduction`. Chrome for PDFs comes from the `mcr.microsoft.com/playwright`
   base image.

## 18. Sub-plan "Reminders and email" (added 2026-09-24, details for §9 and §15 item 4)

1. **Evaluation is pure.** `packages/domain/src/reminders/evaluate.ts` `evaluateOwner(input, rules, today)`:
   input is the owner's unpaid published invoices (`period`, `dueAt`, `outstandingMinor`) and the
   dates of reminders already sent for this owner in this building; returns
   `{ due: boolean; reason: 'consecutive' | 'total' | null; invoiceIds: string[] }`. Due when
   `rules.consecutiveUnpaid` consecutive periods are unpaid and past due, or `rules.totalUnpaid` in
   total, and no reminder covering the same set of invoices exists within the last 30 days. Only
   invoices past `dueAt` count. The rule object's `feeAllowed: false` is enforced: the reminder
   document never carries a fee line, and there is no code path that books one.
2. **Storage.** `reminders` table: `tenant_id`, `building_id`, `contact_id`, `reason`,
   `invoice_ids uuid[]`, `total_outstanding_minor`, `channel` (`email` | `letter`), `status`
   (`pending` | `sent` | `failed` | `printed`), `sent_at`, `error`, `document_html`, `created_at`.
   One row per evaluation hit; the letter PDF is rendered from `document_html` on demand
   (`GET /reminders/:id/pdf`), never stored.
3. **Job.** `POST /buildings/:id/reminders/run` (owner/accountant) evaluates one building now and
   returns the created reminders; `POST /jobs/reminders` with header `x-job-token` equal to
   `JOB_TOKEN` (env, required in production) evaluates every tenant, for external cron
   (documented in DEPLOY.md with a compose `cron` example using `curl`). No in-process scheduler.
   The job is idempotent within 30 days by rule 1.
4. **Document.** `renderReminderHtml` in `apps/api/src/pdf/reminder-html.ts`, same shell as the
   invoice HTML: tenant header, owner, building, table of unpaid invoices (number, period, due date,
   outstanding), total, the Art. 28 sentence from the country pack labels (`labels.reminderIntro`,
   `labels.reminderLegal`), bank account for payment, no fee. Macedonian text first; locale from the
   tenant.
5. **Email.** `apps/api/src/email/mailer.ts` wraps `nodemailer` with SMTP from env
   (`SMTP_URL` like `smtp://user:pass@host:587`, `EMAIL_FROM`). When `SMTP_URL` is unset the mailer
   is a no-op that logs and marks reminders `failed` with `error 'smtp_not_configured'` — the app
   never crashes for lack of email. Dev compose gains a `mailpit` service (SMTP 1025, UI 8025) and
   `.env.example` points `SMTP_URL` at it. Each send creates an `email_log` row (`to`, `subject`,
   `template`, `ref_type`, `ref_id`, `status`, `error`, `sent_at`) inside the reminder transaction.
   The reminder email carries the letter as a PDF attachment and a plain-text body.
6. **Invoice email.** Because the mailer now exists: `POST /invoices/:id/send` emails the invoice
   PDF to the owner contact's email (409 `no_email` when missing) and logs it; the invoice page
   gets a "Send by email" button. Bulk `POST /buildings/:id/periods/:periodId/send` sends every
   published invoice of the period whose owner has an email and reports counts.
7. **Web.** Building tab "Reminders": run button, list (owner, reason, invoices, total, channel,
   status, sent at), PDF link, "mark printed" for letter delivery. Settings page shows email
   status (configured or not) read from `GET /tenant` (`emailConfigured: boolean`).
8. **Invariants.** Every reminder and email log row is tenant-scoped and written inside the same
   transaction as its audit row. Sending happens after the transaction commits (a failed send
   updates the row to `failed`, never rolls back the reminder). Test transport in Vitest captures
   messages in memory; no test talks to a real SMTP server.
