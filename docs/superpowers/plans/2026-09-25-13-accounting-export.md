# Accounting Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a manager one zip per month — a balanced double-entry journal, a trial balance that proves it balances, prior-period adjustments and a README — derived from `postings` and posted by their accountant into any product.

**Architecture:** The derivation is pure and lives in `packages/domain/src/accounting/`: rows in, balanced entries out, no IO, no database, no `Date.now()`. The API supplies the rows (`apps/api/src/resources/accounting/data.ts`), renders the CSVs the way the Art. 30 handover export already does (`;` + BOM + `fflate`), files the zip as a `document` and hands back its id. This subsystem is a **reader** of `postings`: it never writes one and adds no posting kinds. Closing a period writes only an `accounting_periods` row; it blocks nothing anywhere else, and a posting that arrives after its period closed comes back in the next export's adjustments section.

**Tech Stack:** TypeScript 5.6 strict ESM, Node >= 24, pnpm >= 10, Fastify + `fastify-type-provider-zod`, Drizzle ORM on Postgres 16, `fflate`, Vue 3 + `vue-i18n` + Tailwind, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-25-domar-phase3-accounting-design.md` (read it before Task 1; it is 106 lines and binding). It builds on `docs/superpowers/specs/2026-09-21-domar-phase1-design.md` and `docs/superpowers/specs/2026-09-24-domar-phase2-design.md`, whose architecture and conventions remain in force.

## Global Constraints

Copied verbatim from Phase 1 §16, Phase 2 §11 and Phase 3 §8. Every task's requirements implicitly include this section.

From Phase 1 §16 (Global constraints):
- Node `>=24`, pnpm `>=10`, TypeScript strict, ESM only.
- Postgres 16; schema must run unchanged on Supabase Postgres (no superuser-only extensions; `pgcrypto`/`uuid-ossp` allowed).
- Every tenant-scoped table has `tenant_id uuid not null` and an index starting with it.
- Money columns: `bigint`, suffix `_minor`. Never `float`.
- All user-facing strings in the web app go through i18n; Macedonian first, English second.
- No secrets in the repo; `.env.example` documents every variable.
- Commit after every green test cycle; conventional commit messages.

From Phase 2 §11 (Invariants, in addition to Phase 1 §16):
- Legal events are append-only and carry evidence; the compliance screen never reads anything but events plus dates already in the system.
- Every document download checks the tenant and, for portal users, the link (minutes and reports of their building only).
- Uploaded files are stored outside the web root, streamed, never executed, mime-checked, size-capped.
- Extraordinary costs and maintenance costs reach the ledger only through the existing period and expense flows; no new posting kinds.
- Notifications never include amounts in push payloads (title + link only); details load in the app.

From Phase 3 §8 (Invariants, in addition to Phase 1 §16 and Phase 2 §11):
- Every entry balances, and the export fails rather than emitting an unbalanced file.
- The export derives from `postings` and never from a screen's aggregate, so it cannot disagree with the ledger the invoices were built from.
- Money never leaves integer minor units until the CSV is written.
- Closing a period adds no refusal anywhere else in the system.
- Every statement is filtered by `ctx.tenantId`; every mutation writes an audit row in its transaction.
- No new posting kinds and no writes to `postings` from this subsystem. It is a reader.

### House rules this plan also holds you to

- Every `select`/`update`/`delete` carries `eq(X.tenantId, ctx.tenantId)`. A row belonging to another tenant is **404** (`notFound(...)`), never 403.
- Every mutation runs in `db.transaction` and calls `writeAudit(tx, ctx, …)` **inside** that transaction.
- `tsconfig` is strict with `exactOptionalPropertyTypes`: never pass `{ x: undefined }` where `x?: string` is declared; use `stripUndefined` (`apps/api/src/resources/common.ts`) or a conditional spread.
- ESM: every relative import ends in `.js`, and type-only imports use `import type`.
- TDD: write the failing test, run it and see it fail, then the minimal implementation, then green, then commit. Conventional commit messages.
- New i18n keys go into **both** `apps/web/src/i18n/mk.ts` and `apps/web/src/i18n/en.ts`, Macedonian written first. `apps/web/test/LoginPage.test.ts` asserts the two key sets are identical and will fail if you add a key to one file only.
- Browser formatting never uses `Intl` (Chrome ships no `mk-MK` ICU data): use `formatMoney`/`formatNumber`/`formatDateTime` from `apps/web/src/utils/money.ts`. Server-side date formatting **may** use `Intl.DateTimeFormat('en-CA', { timeZone })`, exactly as `apps/api/src/resources/reports/export.ts` does.
- Anything an e2e test touches carries a `data-test` attribute (Playwright's `testIdAttribute` is `data-test`).
- Migrations are append-only and generated with `drizzle-kit`; the latest is `0015`. **Every new migration must extend `packages/db/test/migrations.test.ts`** — a past sub-plan broke that suite by forgetting.

### Facts about the existing code you will build on

- `postings` (`packages/db/src/schema/billing.ts:177`): `account` enum `owner|fund`, `fund` enum `regular|reserve`, `kind` enum `charge|payment|expense|adjustment|opening`, signed `amountMinor` bigint, free-text `refType`, nullable `refId`, nullable `period` char(7), `bookedAt` (when it happened) and `createdAt` (when the row arrived). Sign convention: **owner positive means the owner owes**.
- The six `refType` values in use and who writes them:
  - `invoice` — `apps/api/src/resources/invoicing/publish.ts:61`, one **owner/charge** posting **per invoice line**, `amountMinor = ownerGrossMinor`, `refId` = invoice id.
  - `payment` — `apps/api/src/resources/payments/service.ts:71`, per fund a pair: owner `-amt`, fund `+amt`, `refId` = payment id.
  - `payment_void` — `payments/service.ts:93`, the negation of the pair, kind `adjustment`.
  - `opening_balance` — `opening-balances/repo.ts:43` (owner, kind `opening`, `refId` **null**) and `reserve-fund/repo.ts:53` (fund/reserve, kind `opening`, `refId` **null**).
  - `expense` — `reserve-fund/repo.ts:83`, one fund posting `-amountMinor`, `refId` = expense id.
  - `expense_void` — `reserve-fund/repo.ts:96`, one fund posting `+amountMinor`, kind `adjustment`.
- `apps/api/src/ledger.ts` holds `addPosting`/`addPostings` and the balance readers. **Do not call the writers from this subsystem.**
- Tax lives per invoice line: `invoiceLines.taxRateBp`, `ownerNetMinor`, `ownerTaxMinor`, `ownerGrossMinor`; `invoiceLines.kind` is `service|manual|reserve_fund|management_fee` (`billing.ts:159`).
- `expenses` (`billing.ts:69`) has **no category and no tax columns**; a reversal is `voidedAt`/`voidReason`. `suppliers` (`compliance.ts:70`) has no account field — Task 1 adds `account_code_id`.
- The export precedent to copy is `apps/api/src/resources/reports/export.ts`: `;`-delimited CSV with a BOM, cells quoted by `csvCell` from `packages/domain/src/import/serialize.ts:17`, zipped with `fflate`'s `zipSync`, stored by `createDocumentFromBuffer` (`resources/documents/repo.ts:124`) and downloaded through `GET /api/documents/:id/download` (`resources/documents/routes.ts:69`). **There is no server-side XLSX writer and this plan does not add one.**
- Route skeleton and auth: `apps/api/src/resources/reports/routes.ts`; `apps/api/src/auth/roles.ts` exports `WRITE_ROLES = ['owner','accountant']`. Reads are open to every role, `readonly` included.
- Reuse, do not rebuild: `apps/api/src/resources/reports/data.ts` — `tenantPack(db, ctx)` for the tenant row and its country pack, and `collectReportInput(...)` and friends for the annual/handover windows.

---

### Task 1: The chart of accounts and the period ledger (schema + migration 0016)

**Files:**
- Create: `packages/db/src/schema/accounting.ts`
- Modify: `packages/db/src/schema/index.ts` (add the export)
- Modify: `packages/db/src/schema/compliance.ts:70-84` (add `accountCodeId` to `suppliers`)
- Create: `packages/db/migrations/0016_<drizzle-suffix>.sql` (generated)
- Test: `packages/db/test/migrations.test.ts`

**Interfaces:**
- Consumes: nothing — first task.
- Produces: `schema.accountCodes` (`id, tenantId, slot, code, name, isActive, createdAt, updatedAt`), `schema.accountingPeriods` (`id, tenantId, period, closedAt, closedBy, debitTotalMinor, creditTotalMinor, entryCount, createdAt, updatedAt`), the `accountSlot` pg enum with the nine slots, and `schema.suppliers.accountCodeId: string | null`.

- [ ] **Step 1: Write the failing migration test**

Append these three cases to `packages/db/test/migrations.test.ts`, inside the existing `describe('migrations', …)` block:

```ts
  it('account_codes hold one accountant code per slot per tenant', async () => {
    const cols = await t!.sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
      select column_name, data_type, is_nullable from information_schema.columns where table_name = 'account_codes' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual(['code', 'created_at', 'id', 'is_active', 'name', 'slot', 'tenant_id', 'updated_at']);
    const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(by['code']!.is_nullable).toBe('NO');
    expect(by['name']!.is_nullable).toBe('NO');
    const slots = await t!.sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid where ty.typname = 'account_slot' order by e.enumsortorder`;
    expect(slots.map((s) => s.enumlabel)).toEqual([
      'owner_receivable', 'revenue_service', 'revenue_management_fee', 'revenue_reserve_fund',
      'vat_output', 'cash_regular', 'cash_reserve', 'expense_default', 'opening_balance']);
    const idx = await t!.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'account_codes'`;
    expect(idx.some((i) => i.indexdef.includes('UNIQUE') && i.indexdef.includes('(tenant_id, slot)'))).toBe(true);
  });

  it('accounting_periods record one close per period per tenant', async () => {
    const cols = await t!.sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
      select column_name, data_type, is_nullable from information_schema.columns where table_name = 'accounting_periods' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual(
      ['closed_at', 'closed_by', 'created_at', 'credit_total_minor', 'debit_total_minor', 'entry_count', 'id', 'period', 'tenant_id', 'updated_at']);
    const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(by['debit_total_minor']!.data_type).toBe('bigint');
    expect(by['credit_total_minor']!.data_type).toBe('bigint');
    expect(by['entry_count']!.data_type).toBe('integer');
    expect(by['closed_by']!.is_nullable).toBe('YES');
    const idx = await t!.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'accounting_periods'`;
    expect(idx.some((i) => i.indexdef.includes('UNIQUE') && i.indexdef.includes('(tenant_id, period)'))).toBe(true);
  });

  it('a supplier can name the account its expenses are booked to', async () => {
    const [col] = await t!.sql<{ is_nullable: string }[]>`
      select is_nullable from information_schema.columns where table_name = 'suppliers' and column_name = 'account_code_id'`;
    expect(col!.is_nullable).toBe('YES');
    const [fk] = await t!.sql<{ delete_rule: string }[]>`
      select rc.delete_rule from information_schema.referential_constraints rc
      join information_schema.table_constraints tc on tc.constraint_name = rc.constraint_name
      where tc.table_name = 'suppliers' and rc.constraint_name like '%account_code%'`;
    expect(fk!.delete_rule).toBe('SET NULL');
  });
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @domar/db test -- -t "account_codes"`
Expected: FAIL — `expect(cols.map(...)).toEqual([...])` receives `[]`, because the table does not exist.

- [ ] **Step 3: Write the schema file**

Create `packages/db/src/schema/accounting.ts`:

```ts
import { bigint, boolean, char, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { tenants } from './tenant.js';

/**
 * The fixed set of account slots the journal derivation needs, and the only ones (spec §3). A tenant
 * maps its own codes onto them, which is what makes one export feed Pantheon, Logik or an
 * accountant's own Excel without the product knowing any of them.
 */
export const accountSlot = pgEnum('account_slot', [
  'owner_receivable', 'revenue_service', 'revenue_management_fee', 'revenue_reserve_fund',
  'vat_output', 'cash_regular', 'cash_reserve', 'expense_default', 'opening_balance',
]);

const money = (name: string) => bigint(name, { mode: 'number' });
const tenantRef = () => uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' });
const ts = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const accountCodes = pgTable('account_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  slot: accountSlot('slot').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...ts(),
}, (t) => [uniqueIndex('account_codes_tenant_slot_idx').on(t.tenantId, t.slot)]);

/**
 * Closing a period is advisory, not a lock (spec §5): nothing else in the system gains a refusal.
 * The row records what the file said when it was filed, so a posting that arrives afterwards can be
 * reported as a prior-period adjustment rather than silently changing an already-posted month.
 */
export const accountingPeriods = pgTable('accounting_periods', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  period: char('period', { length: 7 }).notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }).notNull().defaultNow(),
  closedBy: uuid('closed_by').references(() => users.id, { onDelete: 'set null' }),
  debitTotalMinor: money('debit_total_minor').notNull().default(0),
  creditTotalMinor: money('credit_total_minor').notNull().default(0),
  entryCount: integer('entry_count').notNull().default(0),
  ...ts(),
}, (t) => [
  uniqueIndex('accounting_periods_tenant_period_idx').on(t.tenantId, t.period),
  index('accounting_periods_tenant_closed_idx').on(t.tenantId, t.closedAt),
]);
```

- [ ] **Step 4: Wire the schema in and add the supplier column**

In `packages/db/src/schema/index.ts`, append after the `./compliance.js` line:

```ts
export * from './accounting.js';
```

In `packages/db/src/schema/compliance.ts`, add the import at the top (keep the existing import order — alphabetical by path):

```ts
import { accountCodes } from './accounting.js';
```

and add this field to `suppliers`, immediately after `iban`:

```ts
  /** Spec §3: an expense booked to this supplier uses its account instead of `expense_default`. */
  accountCodeId: uuid('account_code_id').references(() => accountCodes.id, { onDelete: 'set null' }),
```

- [ ] **Step 5: Generate the migration**

Run: `pnpm --filter @domar/db generate`
It writes `packages/db/migrations/0016_<random-name>.sql`. Open it and check it is exactly this, modulo the generated file name:

```sql
CREATE TYPE "public"."account_slot" AS ENUM('owner_receivable', 'revenue_service', 'revenue_management_fee', 'revenue_reserve_fund', 'vat_output', 'cash_regular', 'cash_reserve', 'expense_default', 'opening_balance');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slot" "account_slot" NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "accounting_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period" char(7) NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by" uuid,
	"debit_total_minor" bigint DEFAULT 0 NOT NULL,
	"credit_total_minor" bigint DEFAULT 0 NOT NULL,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "account_code_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_codes" ADD CONSTRAINT "account_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_account_code_id_account_codes_id_fk" FOREIGN KEY ("account_code_id") REFERENCES "public"."account_codes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_codes_tenant_slot_idx" ON "account_codes" USING btree ("tenant_id","slot");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accounting_periods_tenant_period_idx" ON "accounting_periods" USING btree ("tenant_id","period");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounting_periods_tenant_closed_idx" ON "accounting_periods" USING btree ("tenant_id","closed_at");
```

If drizzle-kit asks anything interactively, answer that both tables are **created**, never renamed. Never edit an existing migration file; `0016` is append-only like the fifteen before it.

- [ ] **Step 6: Run the whole db suite green**

Run: `pnpm --filter @domar/db test`
Expected: PASS, including the pre-existing `every tenant-scoped table has tenant_id and an index starting with it` and `money columns are bigint and end with _minor` cases, which now also cover the two new tables.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm typecheck
git add packages/db/src/schema/accounting.ts packages/db/src/schema/index.ts packages/db/src/schema/compliance.ts packages/db/migrations packages/db/test/migrations.test.ts
git commit -m "feat(db): chart of accounts, accounting periods and a supplier account"
```

---

### Task 2: The pure journal derivation in `packages/domain`

**Files:**
- Create: `packages/domain/src/accounting/slots.ts`
- Create: `packages/domain/src/accounting/journal.ts`
- Modify: `packages/domain/src/index.ts` (two exports)
- Test: `packages/domain/test/accounting-journal.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 — this file has no database, no IO and no imports from `@domar/db`. That is the point: it is testable exhaustively without a database.
- Produces, all exported from `@domar/domain`:
  - `ACCOUNT_SLOTS: readonly AccountSlot[]`, `type AccountSlot`, `interface AccountRef { code: string; name: string }`, `type Chart = Record<AccountSlot, AccountRef>`
  - `missingSlots(rows: readonly { slot: AccountSlot; code: string; isActive: boolean }[]): AccountSlot[]`
  - `chartFrom(rows: readonly { slot: AccountSlot; code: string; name: string; isActive: boolean }[]): Chart`
  - `interface JournalPostingIn`, `JournalInvoiceIn`, `JournalExpenseIn`, `JournalInput`, `JournalLine`, `JournalEntry`, `TrialBalanceRow`, `Journal`
  - `class JournalError extends Error` with `code: 'unbalanced_entry' | 'unbalanced_file' | 'unknown_source'` and `details: Record<string, unknown>`
  - `buildJournal(input: JournalInput): Journal`

- [ ] **Step 1: Write the failing test**

Create `packages/domain/test/accounting-journal.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildJournal, chartFrom, JournalError, missingSlots,
  type Chart, type JournalInput, type JournalPostingIn,
} from '../src/accounting/journal.js';
import { ACCOUNT_SLOTS } from '../src/accounting/slots.js';

/** A code per slot, numbered so a wrong slot in the output is obvious by eye. */
const CHART: Chart = chartFrom(ACCOUNT_SLOTS.map((slot, i) => ({ slot, code: `${120 + i}`, name: slot, isActive: true })));

function posting(p: Partial<JournalPostingIn> & Pick<JournalPostingIn, 'id' | 'amountMinor' | 'refType'>): JournalPostingIn {
  return {
    account: 'owner', fund: 'regular', kind: 'charge', refId: null, period: '2026-09', date: '2026-09-15',
    buildingName: 'Јане Сандански 5', counterparty: 'Марко Марков', prior: false, ...p,
  };
}
const input = (over: Partial<JournalInput>): JournalInput =>
  ({ chart: CHART, postings: [], invoices: {}, expenses: {}, closedPeriods: [], ...over });

describe('missingSlots', () => {
  it('names every slot that has no active code, in the canonical order', () => {
    expect(missingSlots([
      { slot: 'owner_receivable', code: '120', isActive: true },
      { slot: 'vat_output', code: '260', isActive: false },
      { slot: 'cash_regular', code: '', isActive: true },
    ])).toEqual(['revenue_service', 'revenue_management_fee', 'revenue_reserve_fund', 'vat_output', 'cash_regular', 'cash_reserve', 'expense_default', 'opening_balance']);
  });

  it('is empty for a complete chart', () => {
    expect(missingSlots(ACCOUNT_SLOTS.map((slot) => ({ slot, code: '1', isActive: true })))).toEqual([]);
  });
});

describe('buildJournal — an invoice', () => {
  // 3.000,00 service net + 540,00 VAT, 1.000,00 reserve fund, 500,00 management fee: gross 5.040,00.
  const j = buildJournal(input({
    postings: [
      posting({ id: 'p1', amountMinor: 354000, refType: 'invoice', refId: 'inv1' }),
      posting({ id: 'p2', amountMinor: 100000, refType: 'invoice', refId: 'inv1', fund: 'reserve' }),
      posting({ id: 'p3', amountMinor: 50000, refType: 'invoice', refId: 'inv1' }),
    ],
    invoices: {
      inv1: {
        number: 'INV-1/2026',
        lines: [
          { kind: 'service', ownerNetMinor: 300000, ownerTaxMinor: 54000, ownerGrossMinor: 354000 },
          { kind: 'reserve_fund', ownerNetMinor: 100000, ownerTaxMinor: 0, ownerGrossMinor: 100000 },
          { kind: 'management_fee', ownerNetMinor: 50000, ownerTaxMinor: 0, ownerGrossMinor: 50000 },
        ],
      },
    },
  }));

  it('debits the receivable gross and credits revenue net plus output VAT', () => {
    expect(j.entries).toHaveLength(1);
    const lines = j.entries[0]!.lines.map((l) => [l.name, l.debitMinor, l.creditMinor]);
    expect(lines).toEqual([
      ['owner_receivable', 504000, 0],
      ['revenue_service', 0, 300000],
      ['revenue_management_fee', 0, 50000],
      ['revenue_reserve_fund', 0, 100000],
      ['vat_output', 0, 54000],
    ]);
  });

  it('carries the invoice number, the source and the period', () => {
    expect(j.entries[0]).toMatchObject({ no: 1, sourceType: 'invoice', sourceId: 'inv1', period: '2026-09', date: '2026-09-15' });
    expect(j.entries[0]!.lines[0]!.description).toBe('INV-1/2026');
  });
});

describe('buildJournal — a manual line is service revenue', () => {
  it('books `manual` to revenue_service, the same slot as `service`', () => {
    const j = buildJournal(input({
      postings: [posting({ id: 'p1', amountMinor: 20000, refType: 'invoice', refId: 'inv2' })],
      invoices: { inv2: { number: 'INV-2/2026', lines: [{ kind: 'manual', ownerNetMinor: 20000, ownerTaxMinor: 0, ownerGrossMinor: 20000 }] } },
    }));
    expect(j.entries[0]!.lines.map((l) => l.name)).toEqual(['owner_receivable', 'revenue_service']);
  });
});

describe('buildJournal — money in and out', () => {
  it('a payment debits the fund cash account and credits the receivable', () => {
    const j = buildJournal(input({
      postings: [
        posting({ id: 'p1', amountMinor: -80000, refType: 'payment', refId: 'pay1', kind: 'payment' }),
        posting({ id: 'p2', amountMinor: 80000, refType: 'payment', refId: 'pay1', kind: 'payment', account: 'fund' }),
        posting({ id: 'p3', amountMinor: -20000, refType: 'payment', refId: 'pay1', kind: 'payment', fund: 'reserve' }),
        posting({ id: 'p4', amountMinor: 20000, refType: 'payment', refId: 'pay1', kind: 'payment', account: 'fund', fund: 'reserve' }),
      ],
    }));
    expect(j.entries).toHaveLength(1);
    expect(j.entries[0]!.lines.map((l) => [l.name, l.debitMinor, l.creditMinor])).toEqual([
      ['cash_regular', 80000, 0],
      ['cash_reserve', 20000, 0],
      ['owner_receivable', 0, 100000],
    ]);
  });

  it('a voided payment is the same entry the other way round', () => {
    const j = buildJournal(input({
      postings: [
        posting({ id: 'p1', amountMinor: 80000, refType: 'payment_void', refId: 'pay1', kind: 'adjustment' }),
        posting({ id: 'p2', amountMinor: -80000, refType: 'payment_void', refId: 'pay1', kind: 'adjustment', account: 'fund' }),
      ],
    }));
    expect(j.entries[0]!.lines.map((l) => [l.name, l.debitMinor, l.creditMinor])).toEqual([
      ['owner_receivable', 80000, 0],
      ['cash_regular', 0, 80000],
    ]);
  });

  it('an expense debits the supplier account when it has one and the default when it has not', () => {
    const j = buildJournal(input({
      postings: [
        posting({ id: 'p1', amountMinor: -60000, refType: 'expense', refId: 'e1', kind: 'expense', account: 'fund', counterparty: 'ЕВН' }),
        posting({ id: 'p2', amountMinor: -30000, refType: 'expense', refId: 'e2', kind: 'expense', account: 'fund', fund: 'reserve', counterparty: 'Лифт Сервис' }),
      ],
      expenses: {
        e1: { description: 'Струја', account: { code: '4030', name: 'Електрична енергија' } },
        e2: { description: 'Поправка на лифт', account: null },
      },
    }));
    expect(j.entries.map((e) => e.lines.map((l) => [l.name, l.debitMinor, l.creditMinor]))).toEqual([
      [['Електрична енергија', 60000, 0], ['cash_regular', 0, 60000]],
      [['expense_default', 30000, 0], ['cash_reserve', 0, 30000]],
    ]);
  });

  it('a voided expense reverses the pair', () => {
    const j = buildJournal(input({
      postings: [posting({ id: 'p1', amountMinor: 60000, refType: 'expense_void', refId: 'e1', kind: 'adjustment', account: 'fund' })],
      expenses: { e1: { description: 'Струја', account: null } },
    }));
    expect(j.entries[0]!.lines.map((l) => [l.name, l.debitMinor, l.creditMinor])).toEqual([
      ['cash_regular', 60000, 0],
      ['expense_default', 0, 60000],
    ]);
  });
});

describe('buildJournal — opening balances follow the sign', () => {
  it('an owner who owes is a debit and an owner in credit is the reverse', () => {
    const j = buildJournal(input({
      postings: [
        posting({ id: 'p1', amountMinor: 45000, refType: 'opening_balance', kind: 'opening' }),
        posting({ id: 'p2', amountMinor: -15000, refType: 'opening_balance', kind: 'opening' }),
        posting({ id: 'p3', amountMinor: 900000, refType: 'opening_balance', kind: 'opening', account: 'fund', fund: 'reserve' }),
      ],
    }));
    expect(j.entries.map((e) => e.lines.map((l) => [l.name, l.debitMinor, l.creditMinor]))).toEqual([
      [['owner_receivable', 45000, 0], ['opening_balance', 0, 45000]],
      [['owner_receivable', 0, 15000], ['opening_balance', 15000, 0]],
      [['cash_reserve', 900000, 0], ['opening_balance', 0, 900000]],
    ]);
    // `refId` is null on an opening balance, so each posting is its own entry.
    expect(j.entries.map((e) => e.sourceId)).toEqual(['p1', 'p2', 'p3']);
  });
});

describe('buildJournal — balance is an invariant', () => {
  it('refuses an invoice whose lines do not add up to its postings, naming the entry and the gap', () => {
    const run = () => buildJournal(input({
      postings: [posting({ id: 'p1', amountMinor: 100000, refType: 'invoice', refId: 'inv3' })],
      invoices: { inv3: { number: 'INV-3/2026', lines: [{ kind: 'service', ownerNetMinor: 90000, ownerTaxMinor: 0, ownerGrossMinor: 90000 }] } },
    }));
    expect(run).toThrow(JournalError);
    try { run(); } catch (e) {
      const err = e as JournalError;
      expect(err.code).toBe('unbalanced_entry');
      expect(err.details).toEqual({ entryNo: 1, sourceType: 'invoice', sourceId: 'inv3', differenceMinor: 10000 });
      expect(err.message).toBe('entry 1 (invoice inv3) is out by 10000 minor units');
    }
  });

  it('refuses a posting whose refType it does not know rather than inventing an account', () => {
    const run = () => buildJournal(input({ postings: [posting({ id: 'p1', amountMinor: 1, refType: 'card_settlement' })] }));
    expect(run).toThrow(JournalError);
    try { run(); } catch (e) {
      expect((e as JournalError).code).toBe('unknown_source');
      expect((e as JournalError).details).toEqual({ refType: 'card_settlement', postingId: 'p1' });
    }
  });

  it('refuses an invoice it was handed no lines for', () => {
    const run = () => buildJournal(input({ postings: [posting({ id: 'p1', amountMinor: 1000, refType: 'invoice', refId: 'gone' })] }));
    try { run(); } catch (e) {
      expect((e as JournalError).code).toBe('unknown_source');
      expect((e as JournalError).details).toEqual({ refType: 'invoice', postingId: 'p1', refId: 'gone' });
    }
    expect(run).toThrow(JournalError);
  });
});

describe('buildJournal — the trial balance and the sections', () => {
  const j = buildJournal(input({
    postings: [
      posting({ id: 'p1', amountMinor: 118000, refType: 'invoice', refId: 'inv1', date: '2026-09-01', period: '2026-09' }),
      posting({ id: 'p2', amountMinor: -118000, refType: 'payment', refId: 'pay1', kind: 'payment', date: '2026-09-20', period: '2026-09' }),
      posting({ id: 'p3', amountMinor: 118000, refType: 'payment', refId: 'pay1', kind: 'payment', account: 'fund', date: '2026-09-20', period: '2026-09' }),
      // Booked in August, arrived in September: a prior-period adjustment (spec §5).
      posting({ id: 'p4', amountMinor: -5000, refType: 'payment', refId: 'pay2', kind: 'payment', date: '2026-08-28', period: '2026-08', prior: true }),
      posting({ id: 'p5', amountMinor: 5000, refType: 'payment', refId: 'pay2', kind: 'payment', account: 'fund', date: '2026-08-28', period: '2026-08', prior: true }),
    ],
    invoices: { inv1: { number: 'INV-1/2026', lines: [{ kind: 'service', ownerNetMinor: 100000, ownerTaxMinor: 18000, ownerGrossMinor: 118000 }] } },
    closedPeriods: ['2026-08'],
  }));

  it('splits the entries of the window itself from the prior-period adjustments', () => {
    expect(j.entries.map((e) => e.sourceId)).toEqual(['inv1', 'pay1']);
    expect(j.adjustments.map((e) => e.sourceId)).toEqual(['pay2']);
    expect(j.adjustments[0]).toMatchObject({ period: '2026-08', date: '2026-08-28', closedPeriod: true });
  });

  it('numbers every entry once across both sections', () => {
    expect([...j.entries, ...j.adjustments].map((e) => e.no)).toEqual([1, 2, 3]);
  });

  it('totals each account and the whole file, and the file sums to zero', () => {
    expect(j.trialBalance.map((r) => [r.name, r.debitMinor, r.creditMinor, r.differenceMinor])).toEqual([
      ['owner_receivable', 118000, 123000, -5000],
      ['revenue_service', 0, 100000, -100000],
      ['vat_output', 0, 18000, -18000],
      ['cash_regular', 123000, 0, 123000],
    ]);
    expect(j.totals).toEqual({ debitMinor: 241000, creditMinor: 241000, entryCount: 3, lineCount: 7 });
    expect(j.totals.debitMinor - j.totals.creditMinor).toBe(0);
  });

  it('reports which of the periods it covers were already closed', () => {
    expect(j.closedPeriods).toEqual(['2026-08']);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @domar/domain test -- accounting-journal`
Expected: FAIL — `Failed to resolve import "../src/accounting/journal.js"`.

- [ ] **Step 3: Write the slots module**

Create `packages/domain/src/accounting/slots.ts`:

```ts
/**
 * The fixed set of account slots the derivation needs, and the only ones (spec §3). The order is
 * canonical: `missingSlots` reports in it, and the chart screen lists in it.
 */
export const ACCOUNT_SLOTS = [
  'owner_receivable', 'revenue_service', 'revenue_management_fee', 'revenue_reserve_fund',
  'vat_output', 'cash_regular', 'cash_reserve', 'expense_default', 'opening_balance',
] as const;

export type AccountSlot = (typeof ACCOUNT_SLOTS)[number];

/** One account as the accountant knows it: their own code and their own name for it. */
export interface AccountRef {
  code: string;
  name: string;
}

/** Every slot mapped. The export refuses to run without one (spec §3). */
export type Chart = Record<AccountSlot, AccountRef>;

/**
 * Every slot with no usable code, in canonical order. A blank code or an inactive row counts as
 * unmapped: a half-mapped chart produces a file that looks right and posts wrong.
 */
export function missingSlots(rows: readonly { slot: AccountSlot; code: string; isActive: boolean }[]): AccountSlot[] {
  const mapped = new Set(rows.filter((r) => r.isActive && r.code.trim() !== '').map((r) => r.slot));
  return ACCOUNT_SLOTS.filter((s) => !mapped.has(s));
}

/** The rows as the derivation wants them. Callers check `missingSlots` first; a gap here is a bug. */
export function chartFrom(rows: readonly { slot: AccountSlot; code: string; name: string; isActive: boolean }[]): Chart {
  const by = new Map(rows.filter((r) => r.isActive).map((r) => [r.slot, { code: r.code, name: r.name }]));
  const out = {} as Chart;
  for (const slot of ACCOUNT_SLOTS) {
    const ref = by.get(slot);
    if (!ref) throw new RangeError(`account slot ${slot} is not mapped`);
    out[slot] = ref;
  }
  return out;
}
```

- [ ] **Step 4: Write the journal builder**

Create `packages/domain/src/accounting/journal.ts`:

```ts
import { type AccountRef, ACCOUNT_SLOTS, type AccountSlot, type Chart, chartFrom, missingSlots } from './slots.js';

export { ACCOUNT_SLOTS, chartFrom, missingSlots };
export type { AccountRef, AccountSlot, Chart };

export type JournalFund = 'regular' | 'reserve';
export type JournalAccount = 'owner' | 'fund';
export type JournalKind = 'charge' | 'payment' | 'expense' | 'adjustment' | 'opening';
export type JournalLineKind = 'service' | 'manual' | 'reserve_fund' | 'management_fee';

/**
 * One `postings` row, already resolved by the caller: the period it belongs to, the civil day it
 * happened on in the tenant's zone, and the names a human reads. Nothing here needs a database, so
 * the derivation can be tested exhaustively without one (spec §4).
 */
export interface JournalPostingIn {
  id: string;
  account: JournalAccount;
  fund: JournalFund;
  kind: JournalKind;
  /** Signed minor units, straight off the ledger. Owner positive means the owner owes. */
  amountMinor: number;
  refType: string;
  refId: string | null;
  /** `YYYY-MM` — the posting's own `period`, else the civil month of `bookedAt`. */
  period: string;
  /** `YYYY-MM-DD` in the tenant's zone. */
  date: string;
  buildingName: string;
  counterparty: string;
  /** Booked before the window and reported in it: a prior-period adjustment (spec §5). */
  prior: boolean;
}

export interface JournalInvoiceIn {
  number: string;
  lines: readonly { kind: JournalLineKind; ownerNetMinor: number; ownerTaxMinor: number; ownerGrossMinor: number }[];
}

export interface JournalExpenseIn {
  description: string;
  /** The supplier's own account, when it has one; else the derivation uses `expense_default`. */
  account: AccountRef | null;
}

export interface JournalInput {
  chart: Chart;
  postings: readonly JournalPostingIn[];
  /** Keyed by invoice id — every invoice named by a `charge` posting in `postings`. */
  invoices: Readonly<Record<string, JournalInvoiceIn>>;
  /** Keyed by expense id — every expense named by an `expense`/`expense_void` posting. */
  expenses: Readonly<Record<string, JournalExpenseIn>>;
  /** The periods already closed, for the README and the adjustments section. */
  closedPeriods: readonly string[];
}

export interface JournalLine {
  code: string;
  name: string;
  debitMinor: number;
  creditMinor: number;
  description: string;
}

export interface JournalEntry {
  no: number;
  date: string;
  period: string;
  buildingName: string;
  counterparty: string;
  sourceType: string;
  sourceId: string;
  /** True for an entry in the adjustments section whose period had already been closed. */
  closedPeriod: boolean;
  lines: JournalLine[];
}

export interface TrialBalanceRow {
  code: string;
  name: string;
  debitMinor: number;
  creditMinor: number;
  differenceMinor: number;
}

export interface Journal {
  entries: JournalEntry[];
  adjustments: JournalEntry[];
  trialBalance: TrialBalanceRow[];
  totals: { debitMinor: number; creditMinor: number; entryCount: number; lineCount: number };
  closedPeriods: string[];
}

/** The one error this module raises. Its `code` is the API's error code and the web's i18n key. */
export class JournalError extends Error {
  constructor(
    public readonly code: 'unbalanced_entry' | 'unbalanced_file' | 'unknown_source',
    message: string,
    public readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'JournalError';
  }
}

const REVENUE_SLOT: Record<JournalLineKind, AccountSlot> = {
  service: 'revenue_service',
  manual: 'revenue_service',
  management_fee: 'revenue_management_fee',
  reserve_fund: 'revenue_reserve_fund',
};

const CASH_SLOT: Record<JournalFund, AccountSlot> = { regular: 'cash_regular', reserve: 'cash_reserve' };

const KNOWN = new Set(['invoice', 'payment', 'payment_void', 'expense', 'expense_void', 'opening_balance']);

/** A group is one accounting event: everything sharing a source. An opening balance has no `refId`. */
function groupKey(p: JournalPostingIn): string {
  return p.refType === 'opening_balance' ? `opening_balance:${p.id}` : `${p.refType}:${p.refId ?? p.id}`;
}

const debit = (a: AccountRef, minor: number, description: string): JournalLine =>
  ({ code: a.code, name: a.name, debitMinor: minor, creditMinor: 0, description });
const credit = (a: AccountRef, minor: number, description: string): JournalLine =>
  ({ code: a.code, name: a.name, debitMinor: 0, creditMinor: minor, description });

/** A signed amount against one account: positive is a debit, negative a credit of its absolute value. */
const signed = (a: AccountRef, minor: number, description: string): JournalLine =>
  (minor >= 0 ? debit(a, minor, description) : credit(a, -minor, description));

function invoiceLines(chart: Chart, group: JournalPostingIn[], invoice: JournalInvoiceIn): JournalLine[] {
  const gross = group.reduce((s, p) => s + p.amountMinor, 0);
  const byRevenue = new Map<AccountSlot, number>();
  let tax = 0;
  for (const l of invoice.lines) {
    byRevenue.set(REVENUE_SLOT[l.kind], (byRevenue.get(REVENUE_SLOT[l.kind]) ?? 0) + l.ownerNetMinor);
    tax += l.ownerTaxMinor;
  }
  const out = [debit(chart.owner_receivable, gross, invoice.number)];
  // Canonical slot order, so two runs of the same month produce byte-identical files.
  for (const slot of ACCOUNT_SLOTS) {
    const net = byRevenue.get(slot);
    if (net !== undefined) out.push(credit(chart[slot], net, invoice.number));
  }
  if (tax !== 0) out.push(credit(chart.vat_output, tax, invoice.number));
  return out;
}

function expenseLines(chart: Chart, p: JournalPostingIn, expense: JournalExpenseIn): JournalLine[] {
  const account = expense.account ?? chart.expense_default;
  const cash = chart[CASH_SLOT[p.fund]];
  // Money out is a negative fund posting: debit the expense, credit the cash. A void is the reverse.
  return p.amountMinor < 0
    ? [debit(account, -p.amountMinor, expense.description), credit(cash, -p.amountMinor, expense.description)]
    : [debit(cash, p.amountMinor, expense.description), credit(account, p.amountMinor, expense.description)];
}

function openingLines(chart: Chart, p: JournalPostingIn, description: string): JournalLine[] {
  const side = p.account === 'owner' ? chart.owner_receivable : chart[CASH_SLOT[p.fund]];
  return [signed(side, p.amountMinor, description), signed(chart.opening_balance, -p.amountMinor, description)];
}

/**
 * A payment and its void are the same shape: the ledger already wrote both sides, so each posting
 * becomes one line against its own account and the group balances because the ledger's does.
 */
function cashLines(chart: Chart, group: JournalPostingIn[], description: string): JournalLine[] {
  const byAccount = new Map<string, { account: AccountRef; minor: number }>();
  for (const p of group) {
    const account = p.account === 'owner' ? chart.owner_receivable : chart[CASH_SLOT[p.fund]];
    const at = byAccount.get(account.code) ?? { account, minor: 0 };
    at.minor += p.amountMinor;
    byAccount.set(account.code, at);
  }
  return [...byAccount.values()]
    .filter((x) => x.minor !== 0)
    .sort((a, b) => Number(b.minor > 0) - Number(a.minor > 0))
    .map((x) => signed(x.account, x.minor, description));
}

function entryLines(input: JournalInput, group: JournalPostingIn[]): JournalLine[] {
  const head = group[0]!;
  switch (head.refType) {
    case 'invoice': {
      const invoice = input.invoices[head.refId!];
      if (!invoice) throw new JournalError('unknown_source', `no invoice ${head.refId} for posting ${head.id}`, { refType: 'invoice', postingId: head.id, refId: head.refId });
      return invoiceLines(input.chart, group, invoice);
    }
    case 'payment':
    case 'payment_void':
      return cashLines(input.chart, group, head.counterparty);
    case 'expense':
    case 'expense_void': {
      const expense = input.expenses[head.refId!];
      if (!expense) throw new JournalError('unknown_source', `no expense ${head.refId} for posting ${head.id}`, { refType: head.refType, postingId: head.id, refId: head.refId });
      return expenseLines(input.chart, head, expense);
    }
    case 'opening_balance':
      return openingLines(input.chart, head, head.counterparty);
    default:
      throw new JournalError('unknown_source', `unknown refType ${head.refType}`, { refType: head.refType, postingId: head.id });
  }
}

/**
 * The ledger as a balanced double-entry journal (spec §4). Pure: the same rows always produce the
 * same file. Money stays in integer minor units throughout; only the CSV writer renders it.
 *
 * Balance is an invariant, not a feature: an entry that does not sum to zero stops the whole build
 * and says which entry and by how much, because a file that silently does not balance cannot be
 * posted and is worse than no file at all (spec §2).
 */
export function buildJournal(input: JournalInput): Journal {
  for (const p of input.postings) {
    if (!KNOWN.has(p.refType)) throw new JournalError('unknown_source', `unknown refType ${p.refType}`, { refType: p.refType, postingId: p.id });
  }
  const groups = new Map<string, JournalPostingIn[]>();
  for (const p of input.postings) {
    const key = groupKey(p);
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }
  const closed = new Set(input.closedPeriods);
  const ordered = [...groups.values()].sort((a, b) => {
    const [x, y] = [a[0]!, b[0]!];
    // Adjustments last, then oldest first, then a stable tiebreak so two runs agree byte for byte.
    return Number(x.prior) - Number(y.prior) || x.date.localeCompare(y.date)
      || x.refType.localeCompare(y.refType) || groupKey(x).localeCompare(groupKey(y));
  });

  const entries: JournalEntry[] = [];
  const adjustments: JournalEntry[] = [];
  let no = 0;
  for (const group of ordered) {
    const head = group[0]!;
    const sourceId = head.refType === 'opening_balance' ? head.id : head.refId!;
    no += 1;
    const lines = entryLines(input, group).filter((l) => l.debitMinor !== 0 || l.creditMinor !== 0);
    const difference = lines.reduce((s, l) => s + l.debitMinor - l.creditMinor, 0);
    if (difference !== 0) {
      throw new JournalError('unbalanced_entry', `entry ${no} (${head.refType} ${sourceId}) is out by ${difference} minor units`,
        { entryNo: no, sourceType: head.refType, sourceId, differenceMinor: difference });
    }
    const entry: JournalEntry = {
      no, date: head.date, period: head.period, buildingName: head.buildingName, counterparty: head.counterparty,
      sourceType: head.refType, sourceId, closedPeriod: closed.has(head.period), lines,
    };
    (head.prior ? adjustments : entries).push(entry);
  }

  const all = [...entries, ...adjustments];
  const totals = { debitMinor: 0, creditMinor: 0, entryCount: all.length, lineCount: 0 };
  const byAccount = new Map<string, TrialBalanceRow>();
  for (const e of all) {
    for (const l of e.lines) {
      totals.debitMinor += l.debitMinor;
      totals.creditMinor += l.creditMinor;
      totals.lineCount += 1;
      const row = byAccount.get(l.code) ?? { code: l.code, name: l.name, debitMinor: 0, creditMinor: 0, differenceMinor: 0 };
      row.debitMinor += l.debitMinor;
      row.creditMinor += l.creditMinor;
      row.differenceMinor = row.debitMinor - row.creditMinor;
      byAccount.set(l.code, row);
    }
  }
  if (totals.debitMinor !== totals.creditMinor) {
    // Unreachable while every entry balances, and kept anyway: this is the check the whole file
    // rests on, and an arithmetic slip above must stop the export rather than ship a broken one.
    throw new JournalError('unbalanced_file', `the file is out by ${totals.debitMinor - totals.creditMinor} minor units`,
      { differenceMinor: totals.debitMinor - totals.creditMinor });
  }
  const covered = new Set(all.map((e) => e.period));
  return {
    entries, adjustments,
    trialBalance: [...byAccount.values()].sort((a, b) => a.code.localeCompare(b.code)),
    totals,
    closedPeriods: [...covered].filter((p) => closed.has(p)).sort(),
  };
}
```

- [ ] **Step 5: Export from the package barrel**

In `packages/domain/src/index.ts`, append after the `./statements/index.js` line:

```ts
export * from './accounting/slots.js';
export * from './accounting/journal.js';
```

`journal.ts` re-exports the slot names, so keep the `slots.js` line first and let the duplicate re-export resolve to the same bindings; if the TypeScript build complains about ambiguity, drop the `export { ACCOUNT_SLOTS, chartFrom, missingSlots }` / `export type { … }` block from `journal.ts` and import the slot types from `@domar/domain` consumers directly.

- [ ] **Step 6: Run the test and watch it pass**

Run: `pnpm --filter @domar/domain test -- accounting-journal`
Expected: PASS, 15 cases.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm typecheck
git add packages/domain/src/accounting packages/domain/src/index.ts packages/domain/test/accounting-journal.test.ts
git commit -m "feat(domain): derive a balanced double-entry journal from the ledger"
```

---

### Task 3: The chart-of-accounts API

**Files:**
- Create: `apps/api/src/resources/accounting/schema.ts`
- Create: `apps/api/src/resources/accounting/chart.ts`
- Create: `apps/api/src/resources/accounting/routes.ts`
- Modify: `apps/api/src/app.ts` (register `accountingRoutes` at `/account-codes`)
- Modify: `apps/api/src/resources/suppliers/schema.ts` (add `accountCodeId`)
- Modify: `apps/api/src/resources/suppliers/repo.ts` (validate `accountCodeId` on write)
- Test: `apps/api/test/account-codes.test.ts`

**Interfaces:**
- Consumes: `schema.accountCodes`, `schema.suppliers.accountCodeId` (Task 1); `missingSlots`, `chartFrom`, `ACCOUNT_SLOTS`, `type AccountSlot`, `type Chart` from `@domar/domain` (Task 2).
- Produces:
  - `loadChart(db: Db, ctx: TenantContext): Promise<{ rows: AccountCodeRow[]; missing: AccountSlot[]; chart: Chart | null }>` in `chart.ts`
  - `putAccountCode(db: Db, ctx: TenantContext, slot: AccountSlot, input: { code: string; name: string; isActive?: boolean }): Promise<AccountCodeRow>`
  - `requireChart(db: Db, ctx: TenantContext): Promise<Chart>` — throws `AppError(409, 'chart_incomplete', …, { missing })`
  - `export const accountingRoutes: FastifyPluginAsyncZod` (Tasks 4–6 add routes to this same plugin)
  - `GET /api/account-codes` → `{ rows, missing }`; `PUT /api/account-codes/:slot` → the row

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/account-codes.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaffUser, registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
let owner: string;
let readonlyCookie: string;

beforeAll(async () => {
  t = await createTestApp();
  const reg = await registerTenant(t.app, 'acct-chart');
  owner = reg.cookie;
  readonlyCookie = (await createStaffUser(t.app, owner, 'acct-chart', { email: 'r@acct-chart.mk', firstName: 'R', lastName: 'O', role: 'readonly' })).cookie;
});
afterAll(async () => { await t.close(); });

describe('GET /api/account-codes', () => {
  it('starts empty and names every unmapped slot', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/account-codes', headers: { cookie: owner } });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toEqual([]);
    expect(res.json().missing).toEqual([
      'owner_receivable', 'revenue_service', 'revenue_management_fee', 'revenue_reserve_fund',
      'vat_output', 'cash_regular', 'cash_reserve', 'expense_default', 'opening_balance']);
  });

  it('is readable by a readonly user', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/account-codes', headers: { cookie: readonlyCookie } });
    expect(res.statusCode).toBe(200);
  });
});

describe('PUT /api/account-codes/:slot', () => {
  it('maps a slot, then rewrites the same row rather than adding a second', async () => {
    const first = await t.app.inject({
      method: 'PUT', url: '/api/account-codes/owner_receivable', headers: { cookie: owner },
      payload: { code: '1200', name: 'Побарувања од купувачи' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ slot: 'owner_receivable', code: '1200', isActive: true });
    const second = await t.app.inject({
      method: 'PUT', url: '/api/account-codes/owner_receivable', headers: { cookie: owner },
      payload: { code: '1201', name: 'Побарувања од сопственици' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    const list = await t.app.inject({ method: 'GET', url: '/api/account-codes', headers: { cookie: owner } });
    expect(list.json().rows).toHaveLength(1);
    expect(list.json().rows[0].code).toBe('1201');
    expect(list.json().missing).not.toContain('owner_receivable');
  });

  it('rejects an unknown slot and an empty code', async () => {
    expect((await t.app.inject({ method: 'PUT', url: '/api/account-codes/petty_cash', headers: { cookie: owner }, payload: { code: '1', name: 'x' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'PUT', url: '/api/account-codes/vat_output', headers: { cookie: owner }, payload: { code: '  ', name: 'x' } })).statusCode).toBe(400);
  });

  it('is refused to a readonly user', async () => {
    const res = await t.app.inject({ method: 'PUT', url: '/api/account-codes/vat_output', headers: { cookie: readonlyCookie }, payload: { code: '4700', name: 'ДДВ' } });
    expect(res.statusCode).toBe(403);
  });

  it('writes an audit row inside the transaction', async () => {
    await t.app.inject({ method: 'PUT', url: '/api/account-codes/cash_regular', headers: { cookie: owner }, payload: { code: '1000', name: 'Жиро сметка' } });
    const rows = await t.db.query.auditLogs.findMany({});
    expect(rows.some((r) => r.action === 'account_code.put' && r.entityType === 'account_code')).toBe(true);
  });
});

describe('a supplier names its own expense account', () => {
  it('accepts a code of this tenant and refuses one of another', async () => {
    const code = (await t.app.inject({ method: 'PUT', url: '/api/account-codes/expense_default', headers: { cookie: owner }, payload: { code: '4000', name: 'Трошоци' } })).json();
    const created = await t.app.inject({ method: 'POST', url: '/api/suppliers', headers: { cookie: owner }, payload: { name: 'ЕВН', accountCodeId: code.id } });
    expect(created.statusCode).toBe(201);
    expect(created.json().accountCodeId).toBe(code.id);

    const other = await registerTenant(t.app, 'acct-chart-2');
    const theirs = (await t.app.inject({ method: 'PUT', url: '/api/account-codes/expense_default', headers: { cookie: other.cookie }, payload: { code: '4000', name: 'Трошоци' } })).json();
    const rejected = await t.app.inject({ method: 'POST', url: '/api/suppliers', headers: { cookie: owner }, payload: { name: 'Туѓ', accountCodeId: theirs.id } });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe('invalid_reference');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @domar/api test -- account-codes`
Expected: FAIL — every request returns 404, because `/api/account-codes` is not registered.

- [ ] **Step 3: Write the zod schemas**

Create `apps/api/src/resources/accounting/schema.ts`:

```ts
import { ACCOUNT_SLOTS } from '@domar/domain';
import { z } from 'zod';

export const accountSlotEnum = z.enum(ACCOUNT_SLOTS);
export const accountSlotParam = z.object({ slot: accountSlotEnum });

export const accountCodeOut = z.object({
  id: z.string(), slot: accountSlotEnum, code: z.string(), name: z.string(), isActive: z.boolean(),
  createdAt: z.date().or(z.string()), updatedAt: z.date().or(z.string()),
});
export const accountCodeListOut = z.object({ rows: z.array(accountCodeOut), missing: z.array(accountSlotEnum) });
export const accountCodePut = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  isActive: z.boolean().optional(),
});
export type AccountCodePut = z.infer<typeof accountCodePut>;
```

- [ ] **Step 4: Write the chart repo**

Create `apps/api/src/resources/accounting/chart.ts`:

```ts
import { type Db, schema } from '@domar/db';
import { type AccountSlot, type Chart, chartFrom, missingSlots } from '@domar/domain';
import { and, asc, eq } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { AppError, badRequest } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import type { AccountCodePut } from './schema.js';

const AC = schema.accountCodes;
export type AccountCodeRow = typeof AC.$inferSelect;

/** The tenant's chart, the slots it still has to map, and the derivation's view of it when complete. */
export async function loadChart(db: Db, ctx: TenantContext): Promise<{ rows: AccountCodeRow[]; missing: AccountSlot[]; chart: Chart | null }> {
  const rows = await db.select().from(AC).where(eq(AC.tenantId, ctx.tenantId)).orderBy(asc(AC.slot));
  const missing = missingSlots(rows);
  return { rows, missing, chart: missing.length === 0 ? chartFrom(rows) : null };
}

/**
 * Spec §3: the export refuses to run while a required slot is unmapped, and names every one of them.
 * 409 rather than 400 — the request is well formed, the organization is not ready to answer it.
 */
export async function requireChart(db: Db, ctx: TenantContext): Promise<Chart> {
  const { missing, chart } = await loadChart(db, ctx);
  if (!chart) throw new AppError(409, 'chart_incomplete', `Unmapped account slots: ${missing.join(', ')}`, { missing });
  return chart;
}

/** One row per slot per tenant: a second PUT rewrites the first rather than adding a rival code. */
export async function putAccountCode(db: Db, ctx: TenantContext, slot: AccountSlot, input: AccountCodePut): Promise<AccountCodeRow> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(AC).where(and(eq(AC.tenantId, ctx.tenantId), eq(AC.slot, slot))).limit(1);
    const values = { code: input.code, name: input.name, ...(input.isActive === undefined ? {} : { isActive: input.isActive }) };
    const [row] = await tx.insert(AC).values({ tenantId: ctx.tenantId, slot, ...values })
      .onConflictDoUpdate({ target: [AC.tenantId, AC.slot], set: { ...values, updatedAt: new Date() } }).returning();
    await writeAudit(tx, ctx, { action: 'account_code.put', entityType: 'account_code', entityId: row!.id, before: before ?? null, after: row });
    return row!;
  });
}

/** A code of another tenant is not a 403 but a bad reference: the caller must not learn it exists. */
export async function assertAccountCodeInTenant(db: Db, ctx: TenantContext, id: string | null | undefined): Promise<void> {
  if (!id) return;
  const [row] = await db.select({ id: AC.id }).from(AC).where(and(eq(AC.tenantId, ctx.tenantId), eq(AC.id, id))).limit(1);
  if (!row) throw badRequest('invalid_reference', 'accountCodeId does not belong to this organization');
}
```

- [ ] **Step 5: Write the routes and register them**

Create `apps/api/src/resources/accounting/routes.ts`:

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { loadChart, putAccountCode } from './chart.js';
import { accountCodeListOut, accountCodeOut, accountCodePut, accountSlotParam } from './schema.js';

/** Reads for every role, `readonly` included (Phase 1 §10); mapping a slot is a write. */
export const accountCodeRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', { schema: { response: { 200: accountCodeListOut } } }, async (req) => {
    const { rows, missing } = await loadChart(req.db, req.ctx!);
    return { rows, missing };
  });

  app.put('/:slot', {
    preHandler: requireRole(...WRITE_ROLES),
    schema: { params: accountSlotParam, body: accountCodePut, response: { 200: accountCodeOut } },
  }, async (req) => putAccountCode(req.db, req.ctx!, req.params.slot, req.body));
};
```

In `apps/api/src/app.ts`, add the import beside the other resource imports (keep them sorted by path):

```ts
import { accountCodeRoutes } from './resources/accounting/routes.js';
```

and register it next to `supplierRoutes`:

```ts
    await api.register(accountCodeRoutes, { prefix: '/account-codes' });
```

- [ ] **Step 6: Let a supplier name its account**

In `apps/api/src/resources/suppliers/schema.ts`, add to both `supplierOut` and `supplierCreate`:

```ts
  accountCodeId: z.string().uuid().nullable().optional(),   // supplierCreate
  accountCodeId: z.string().nullable(),                      // supplierOut
```

In `apps/api/src/resources/suppliers/repo.ts`, import the guard and call it in both writers, before the insert/update:

```ts
import { assertAccountCodeInTenant } from '../accounting/chart.js';
```

```ts
    await assertAccountCodeInTenant(tx, ctx, input.accountCodeId);   // in createSupplier
    await assertAccountCodeInTenant(tx, ctx, patch.accountCodeId);   // in updateSupplier
```

- [ ] **Step 7: Run the test and watch it pass**

Run: `pnpm --filter @domar/api test -- account-codes suppliers`
Expected: PASS — the new suite plus the untouched `suppliers.test.ts`.

- [ ] **Step 8: Typecheck and commit**

```bash
pnpm typecheck
git add apps/api/src/resources/accounting apps/api/src/app.ts apps/api/src/resources/suppliers apps/api/test/account-codes.test.ts
git commit -m "feat(api): the tenant's chart of accounts and a supplier's expense account"
```

---

### Task 4: Collect the ledger rows and preview the trial balance

**Files:**
- Create: `apps/api/src/resources/accounting/data.ts`
- Modify: `apps/api/src/resources/accounting/schema.ts` (window query + preview response)
- Modify: `apps/api/src/resources/accounting/routes.ts` (add `GET /api/accounting/preview`)
- Modify: `apps/api/src/app.ts` (register `accountingRoutes` at `/accounting`)
- Test: `apps/api/test/accounting-preview.test.ts`

**Interfaces:**
- Consumes: `requireChart(db, ctx)` and `loadChart` (Task 3); `buildJournal`, `JournalError`, `type Journal`, `type JournalInput`, `type JournalPostingIn` from `@domar/domain` (Task 2); `tenantPack(db, ctx)` from `apps/api/src/resources/reports/data.ts`; `getBuilding(db, ctx, id)` from `apps/api/src/resources/buildings/repo.ts`.
- Produces:
  - `interface AccountingWindow { from: Date; to: Date; buildingId?: string | undefined }`
  - `collectJournalInput(db: Db, ctx: TenantContext, w: AccountingWindow): Promise<JournalInput>`
  - `buildJournalFor(db: Db, ctx: TenantContext, w: AccountingWindow): Promise<{ journal: Journal; buildingName: string | null; tenantName: string }>` — the one entry point Tasks 5 and 6 call
  - `export const accountingRoutes: FastifyPluginAsyncZod` with `GET /preview`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/accounting-preview.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
let cookie: string;
let buildingId: string;
let invoiceId: string;

/** A building with one owner, one 18 % service, one published September invoice and one payment. */
beforeAll(async () => {
  t = await createTestApp();
  cookie = (await registerTenant(t.app, 'acct-preview')).cookie;
  const post = async (url: string, payload: unknown = {}) => {
    const res = await t.app.inject({ method: 'POST', url, headers: { cookie }, payload });
    if (res.statusCode >= 300) throw new Error(`${url} → ${res.body}`);
    return res.json();
  };
  const rates = (await t.app.inject({ method: 'GET', url: '/api/tax-rates', headers: { cookie } })).json();
  const vatId = rates.rows.find((r: { rateBp: number }) => r.rateBp === 1800).id;
  const owner = await post('/api/contacts', { firstName: 'Марко', lastName: 'Марков' });
  const building = await post('/api/buildings', { name: 'Партизанска 1', address: 'Партизанска 1', city: 'Скопје', postalCode: '1000' });
  buildingId = building.id;
  await post(`/api/buildings/${buildingId}/units`, { label: '1', kind: 'apartment', areaM2: 50, ownerContactId: owner.id });
  const service = await post('/api/services', { name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 100000, taxRateId: vatId, appliesTo: ['apartment'] });
  await post(`/api/buildings/${buildingId}/services`, { serviceId: service.id, startsPeriod: '2026-01' });
  const period = await post(`/api/buildings/${buildingId}/periods`, { period: '2026-09' });
  await post(`/api/buildings/${buildingId}/periods/${period.id}/generate`);
  await post(`/api/buildings/${buildingId}/periods/${period.id}/publish`);
  const invoices = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}`, headers: { cookie } })).json();
  invoiceId = invoices.rows[0].id;
  await post(`/api/invoices/${invoiceId}/payments`, { amountMinor: 118000, method: 'bank', paidAt: new Date().toISOString() });
});
afterAll(async () => { await t.close(); });

const mapChart = async () => {
  const slots: [string, string, string][] = [
    ['owner_receivable', '1200', 'Побарувања'], ['revenue_service', '7400', 'Приходи од услуги'],
    ['revenue_management_fee', '7410', 'Приходи од управување'], ['revenue_reserve_fund', '7420', 'Резервен фонд'],
    ['vat_output', '4700', 'ДДВ на излез'], ['cash_regular', '1000', 'Редовна сметка'],
    ['cash_reserve', '1001', 'Резервна сметка'], ['expense_default', '4000', 'Трошоци'], ['opening_balance', '9000', 'Почетна состојба'],
  ];
  for (const [slot, code, name] of slots) {
    await t.app.inject({ method: 'PUT', url: `/api/account-codes/${slot}`, headers: { cookie }, payload: { code, name } });
  }
};

describe('GET /api/accounting/preview', () => {
  it('refuses while the chart is incomplete and names every missing slot', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/accounting/preview?from=2026-09-01&to=2026-10-01', headers: { cookie } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('chart_incomplete');
    expect(res.json().error.details.missing).toContain('owner_receivable');
  });

  it('returns a trial balance that balances once the chart is complete', async () => {
    await mapChart();
    const res = await t.app.inject({ method: 'GET', url: '/api/accounting/preview?from=2026-09-01&to=2026-10-01', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totals.debitMinor).toBe(body.totals.creditMinor);
    expect(body.totals.entryCount).toBe(2);
    const byCode = Object.fromEntries(body.trialBalance.map((r: { code: string; debitMinor: number; creditMinor: number }) => [r.code, r]));
    expect(byCode['1200']).toMatchObject({ debitMinor: 118000, creditMinor: 118000 });
    expect(byCode['7400']).toMatchObject({ debitMinor: 0, creditMinor: 100000 });
    expect(byCode['4700']).toMatchObject({ debitMinor: 0, creditMinor: 18000 });
    expect(byCode['1000']).toMatchObject({ debitMinor: 118000, creditMinor: 0 });
  });

  it('scopes to one building when asked', async () => {
    const other = await t.app.inject({
      method: 'POST', url: '/api/buildings', headers: { cookie },
      payload: { name: 'Празна', address: 'Празна 2', city: 'Скопје', postalCode: '1000' },
    });
    const res = await t.app.inject({ method: 'GET', url: `/api/accounting/preview?from=2026-09-01&to=2026-10-01&buildingId=${other.json().id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().totals).toEqual({ debitMinor: 0, creditMinor: 0, entryCount: 0, lineCount: 0 });
  });

  it('404s on a building of another tenant, never 403', async () => {
    const other = await registerTenant(t.app, 'acct-preview-2');
    const theirs = await t.app.inject({
      method: 'POST', url: '/api/buildings', headers: { cookie: other.cookie },
      payload: { name: 'Туѓа', address: 'Туѓа 3', city: 'Скопје', postalCode: '1000' },
    });
    const res = await t.app.inject({ method: 'GET', url: `/api/accounting/preview?from=2026-09-01&to=2026-10-01&buildingId=${theirs.json().id}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a window that ends before it starts', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/accounting/preview?from=2026-10-01&to=2026-09-01', headers: { cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_window');
  });

  it('reports a payment that arrived after its month as a prior-period adjustment', async () => {
    // Booked in August (`paidAt`), created now: it belongs to August and arrives in this window.
    await t.app.inject({
      method: 'POST', url: `/api/invoices/${invoiceId}/payments`, headers: { cookie },
      payload: { amountMinor: 1000, method: 'cash', paidAt: '2026-08-15T10:00:00.000Z' },
    });
    const from = new Date(Date.now() - 60_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const res = await t.app.inject({ method: 'GET', url: `/api/accounting/preview?from=${from}&to=${to}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().adjustmentCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @domar/api test -- accounting-preview`
Expected: FAIL — the first case gets 404 instead of 409; `/api/accounting/preview` does not exist.

- [ ] **Step 3: Extend the zod schemas**

Append to `apps/api/src/resources/accounting/schema.ts`:

```ts
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const accountingWindowQuery = z.object({
  from: dateOnly,
  to: dateOnly,
  buildingId: z.string().uuid().optional(),
});

export const trialBalanceRowOut = z.object({
  code: z.string(), name: z.string(), debitMinor: z.number(), creditMinor: z.number(), differenceMinor: z.number(),
});
export const accountingPreviewOut = z.object({
  from: z.string(), to: z.string(), buildingName: z.string().nullable(),
  trialBalance: z.array(trialBalanceRowOut),
  totals: z.object({ debitMinor: z.number(), creditMinor: z.number(), entryCount: z.number(), lineCount: z.number() }),
  adjustmentCount: z.number(),
  closedPeriods: z.array(z.string()),
  balanced: z.boolean(),
});
```

- [ ] **Step 4: Write the collector**

Create `apps/api/src/resources/accounting/data.ts`:

```ts
import { type Db, schema } from '@domar/db';
import {
  buildJournal, JournalError, type Journal, type JournalExpenseIn, type JournalInput,
  type JournalInvoiceIn, type JournalLineKind, type JournalPostingIn,
} from '@domar/domain';
import { and, asc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import { AppError, badRequest } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import { tenantPack } from '../reports/data.js';
import { requireChart } from './chart.js';

const P = schema.postings; const B = schema.buildings; const C = schema.contacts;
const INV = schema.invoices; const IL = schema.invoiceLines;
const E = schema.expenses; const S = schema.suppliers; const AC = schema.accountCodes;
const AP = schema.accountingPeriods;

export interface AccountingWindow {
  from: Date;
  to: Date;
  buildingId?: string | undefined;
}

/** A civil day of the tenant's zone, never UTC — the same helper `resources/reports/export.ts` uses. */
function dayIn(timeZone: string): (x: Date) => string {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (x) => fmt.format(x);
}

/**
 * Every ledger row the file reports, in two sets that cannot overlap (spec §5):
 *  - the window's own movements, `booked_at` inside it;
 *  - the late arrivals, `booked_at` **before** it and `created_at` inside it. Closing a period
 *    refuses nothing, so a September payment entered in October is recordable — and this is where it
 *    resurfaces, in its own section, with the day it really arrived and the period it belongs to.
 */
export async function collectJournalInput(db: Db, ctx: TenantContext, w: AccountingWindow): Promise<JournalInput> {
  if (w.to.getTime() <= w.from.getTime()) throw badRequest('invalid_window', 'The window must end after it starts');
  const [chart, { tenant }] = await Promise.all([requireChart(db, ctx), tenantPack(db, ctx)]);
  if (w.buildingId) await getBuilding(db, ctx, w.buildingId); // 404 across tenants

  const day = dayIn(tenant.timezone);
  const rows = await db.select({
    p: P, buildingName: B.name, firstName: C.firstName, lastName: C.lastName,
  }).from(P)
    .innerJoin(B, and(eq(B.id, P.buildingId), eq(B.tenantId, P.tenantId)))
    .leftJoin(C, and(eq(C.id, P.contactId), eq(C.tenantId, P.tenantId)))
    .where(and(
      eq(P.tenantId, ctx.tenantId),
      ...(w.buildingId ? [eq(P.buildingId, w.buildingId)] : []),
      or(
        and(gte(P.bookedAt, w.from), lt(P.bookedAt, w.to)),
        and(lt(P.bookedAt, w.from), gte(P.createdAt, w.from), lt(P.createdAt, w.to)),
      ),
    ))
    .orderBy(asc(P.bookedAt), asc(P.createdAt), asc(P.id));

  const postings: JournalPostingIn[] = rows.map((r) => ({
    id: r.p.id, account: r.p.account, fund: r.p.fund, kind: r.p.kind,
    amountMinor: r.p.amountMinor, refType: r.p.refType, refId: r.p.refId,
    period: r.p.period ?? day(r.p.bookedAt).slice(0, 7),
    date: day(r.p.bookedAt),
    buildingName: r.buildingName,
    counterparty: `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim(),
    prior: r.p.bookedAt.getTime() < w.from.getTime(),
  }));

  const invoiceIds = [...new Set(postings.filter((p) => p.refType === 'invoice' && p.refId).map((p) => p.refId!))];
  const expenseIds = [...new Set(postings.filter((p) => (p.refType === 'expense' || p.refType === 'expense_void') && p.refId).map((p) => p.refId!))];
  const periods = [...new Set(postings.map((p) => p.period))];

  const [invoiceRows, lineRows, expenseRows, closedRows] = await Promise.all([
    invoiceIds.length
      ? db.select({ id: INV.id, number: INV.number }).from(INV).where(and(eq(INV.tenantId, ctx.tenantId), inArray(INV.id, invoiceIds)))
      : [],
    invoiceIds.length
      ? db.select({ invoiceId: IL.invoiceId, kind: IL.kind, net: IL.ownerNetMinor, tax: IL.ownerTaxMinor, gross: IL.ownerGrossMinor })
        .from(IL).where(and(eq(IL.tenantId, ctx.tenantId), inArray(IL.invoiceId, invoiceIds))).orderBy(asc(IL.invoiceId), asc(IL.sortOrder))
      : [],
    expenseIds.length
      ? db.select({ id: E.id, description: E.description, code: AC.code, name: AC.name }).from(E)
        .leftJoin(S, and(eq(S.id, E.supplierId), eq(S.tenantId, E.tenantId)))
        .leftJoin(AC, and(eq(AC.id, S.accountCodeId), eq(AC.tenantId, E.tenantId), eq(AC.isActive, true)))
        .where(and(eq(E.tenantId, ctx.tenantId), inArray(E.id, expenseIds)))
      : [],
    periods.length
      ? db.select({ period: AP.period }).from(AP).where(and(eq(AP.tenantId, ctx.tenantId), inArray(AP.period, periods)))
      : [],
  ]);

  const invoices: Record<string, JournalInvoiceIn> = {};
  for (const i of invoiceRows) invoices[i.id] = { number: i.number ?? '', lines: [] };
  for (const l of lineRows) {
    invoices[l.invoiceId]?.lines.push({
      kind: l.kind as JournalLineKind, ownerNetMinor: l.net, ownerTaxMinor: l.tax, ownerGrossMinor: l.gross,
    } as never);
  }
  const expenses: Record<string, JournalExpenseIn> = {};
  for (const e of expenseRows) {
    expenses[e.id] = { description: e.description, account: e.code !== null && e.name !== null ? { code: e.code, name: e.name } : null };
  }

  return { chart, postings, invoices, expenses, closedPeriods: closedRows.map((r) => r.period) };
}

/**
 * The one entry point the preview, the export and the period close all share, so the three can never
 * disagree about what a month contains. A derivation failure is an API error the screen can read.
 */
export async function buildJournalFor(db: Db, ctx: TenantContext, w: AccountingWindow): Promise<{ journal: Journal; buildingName: string | null; tenantName: string }> {
  const [input, { tenant }] = await Promise.all([collectJournalInput(db, ctx, w), tenantPack(db, ctx)]);
  const buildingName = w.buildingId ? (await getBuilding(db, ctx, w.buildingId)).name : null;
  try {
    return { journal: buildJournal(input), buildingName, tenantName: tenant.name };
  } catch (err) {
    if (err instanceof JournalError) throw new AppError(409, err.code, err.message, err.details);
    throw err;
  }
}
```

`invoices[l.invoiceId]?.lines.push(...)` needs `lines` to be mutable: declare the builder's `JournalInvoiceIn.lines` as `readonly` (it already is) and build a local `Record<string, { number: string; lines: JournalInvoiceIn['lines'][number][] }>` instead of casting. Write it that way — replace the two loops with:

```ts
  const draft = new Map<string, { number: string; lines: { kind: JournalLineKind; ownerNetMinor: number; ownerTaxMinor: number; ownerGrossMinor: number }[] }>();
  for (const i of invoiceRows) draft.set(i.id, { number: i.number ?? '', lines: [] });
  for (const l of lineRows) draft.get(l.invoiceId)?.lines.push({ kind: l.kind as JournalLineKind, ownerNetMinor: l.net, ownerTaxMinor: l.tax, ownerGrossMinor: l.gross });
  const invoices: Record<string, JournalInvoiceIn> = Object.fromEntries(draft);
```

- [ ] **Step 5: Add the preview route**

In `apps/api/src/resources/accounting/routes.ts`, add below `accountCodeRoutes`:

```ts
/** Everything under `/api/accounting`. Reads are open to every role; writing is Tasks 5 and 6. */
export const accountingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/preview', { schema: { querystring: accountingWindowQuery, response: { 200: accountingPreviewOut } } }, async (req) => {
    const w = windowOf(req.query);
    const { journal, buildingName } = await buildJournalFor(req.db, req.ctx!, w);
    return {
      from: req.query.from, to: req.query.to, buildingName,
      trialBalance: journal.trialBalance, totals: journal.totals,
      adjustmentCount: journal.adjustments.length, closedPeriods: journal.closedPeriods,
      balanced: journal.totals.debitMinor === journal.totals.creditMinor,
    };
  });
};
```

with these imports and helper at the top of the file:

```ts
import { buildJournalFor, type AccountingWindow } from './data.js';
import { accountingPreviewOut, accountingWindowQuery } from './schema.js';

/** `to` is exclusive and both bounds are plain civil days, as every window in this product is. */
const windowOf = (q: { from: string; to: string; buildingId?: string | undefined }): AccountingWindow =>
  ({ from: new Date(`${q.from}T00:00:00.000Z`), to: new Date(`${q.to}T00:00:00.000Z`), ...(q.buildingId ? { buildingId: q.buildingId } : {}) });
```

In `apps/api/src/app.ts`, import `accountingRoutes` alongside `accountCodeRoutes` and register:

```ts
    await api.register(accountingRoutes, { prefix: '/accounting' });
```

- [ ] **Step 6: Run the test and watch it pass**

Run: `pnpm --filter @domar/api test -- accounting-preview`
Expected: PASS, 6 cases.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm typecheck
git add apps/api/src/resources/accounting apps/api/src/app.ts apps/api/test/accounting-preview.test.ts
git commit -m "feat(api): collect the ledger into a journal and preview its trial balance"
```

---

### Task 5: The zip — `dnevnik.csv`, `bruto-bilans.csv`, `korekcii.csv`, `README.txt`

**Files:**
- Create: `apps/api/src/resources/accounting/export.ts`
- Create: `apps/api/src/resources/accounting/service.ts`
- Modify: `apps/api/src/resources/accounting/schema.ts` (export body + response)
- Modify: `apps/api/src/resources/accounting/routes.ts` (add `POST /api/accounting/export`)
- Test: `apps/api/test/accounting-export.test.ts`

**Interfaces:**
- Consumes: `buildJournalFor` (Task 4); `csvCell` from `@domar/domain`; `createDocumentFromBuffer` from `../documents/repo.js`; `writeAudit`; `app.documents` (`DocumentStore`).
- Produces:
  - `interface AccountingExportMeta { tenantName: string; buildingName: string | null; from: string; to: string; createdAt: Date }`
  - `buildAccountingExport(journal: Journal, meta: AccountingExportMeta): Buffer`
  - `exportAccounting(db: Db, ctx: TenantContext, input: { from: string; to: string; buildingId?: string | undefined }, rt: { documents: DocumentStore; log: { warn(obj: unknown, msg: string): void } }): Promise<{ documentId: string; fileName: string; entryCount: number; adjustmentCount: number; debitMinor: number; creditMinor: number }>`
  - `POST /api/accounting/export` (roles `owner`/`accountant`) → 201 with that object

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/accounting-export.test.ts`:

```ts
import { unzipSync, strFromU8 } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaffUser, registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
let cookie: string;
let readonlyCookie: string;
let buildingId: string;

beforeAll(async () => {
  t = await createTestApp();
  const reg = await registerTenant(t.app, 'acct-export');
  cookie = reg.cookie;
  readonlyCookie = (await createStaffUser(t.app, cookie, 'acct-export', { email: 'r@acct-export.mk', firstName: 'R', lastName: 'O', role: 'readonly' })).cookie;
  const post = async (url: string, payload: unknown = {}) => {
    const res = await t.app.inject({ method: 'POST', url, headers: { cookie }, payload });
    if (res.statusCode >= 300) throw new Error(`${url} → ${res.body}`);
    return res.json();
  };
  const rates = (await t.app.inject({ method: 'GET', url: '/api/tax-rates', headers: { cookie } })).json();
  const vatId = rates.rows.find((r: { rateBp: number }) => r.rateBp === 1800).id;
  const owner = await post('/api/contacts', { firstName: 'Ана', lastName: 'Анева' });
  const building = await post('/api/buildings', { name: 'Илинденска 7', address: 'Илинденска 7', city: 'Скопје', postalCode: '1000' });
  buildingId = building.id;
  await post(`/api/buildings/${buildingId}/units`, { label: '1', kind: 'apartment', areaM2: 60, ownerContactId: owner.id });
  const service = await post('/api/services', { name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 100000, taxRateId: vatId, appliesTo: ['apartment'] });
  await post(`/api/buildings/${buildingId}/services`, { serviceId: service.id, startsPeriod: '2026-01' });
  const period = await post(`/api/buildings/${buildingId}/periods`, { period: '2026-09' });
  await post(`/api/buildings/${buildingId}/periods/${period.id}/generate`);
  await post(`/api/buildings/${buildingId}/periods/${period.id}/publish`);
  await post(`/api/buildings/${buildingId}/reserve-fund/expenses`, {
    fund: 'regular', description: 'Струја', amountMinor: 40000, paidAt: new Date().toISOString(),
  });
  const slots: [string, string, string][] = [
    ['owner_receivable', '1200', 'Побарувања'], ['revenue_service', '7400', 'Приходи од услуги'],
    ['revenue_management_fee', '7410', 'Приходи од управување'], ['revenue_reserve_fund', '7420', 'Резервен фонд'],
    ['vat_output', '4700', 'ДДВ на излез'], ['cash_regular', '1000', 'Редовна сметка'],
    ['cash_reserve', '1001', 'Резервна сметка'], ['expense_default', '4000', 'Трошоци'], ['opening_balance', '9000', 'Почетна состојба'],
  ];
  for (const [slot, code, name] of slots) {
    await t.app.inject({ method: 'PUT', url: `/api/account-codes/${slot}`, headers: { cookie }, payload: { code, name } });
  }
});
afterAll(async () => { await t.close(); });

const WINDOW = { from: '2026-01-01', to: '2027-01-01' };

describe('POST /api/accounting/export', () => {
  it('is refused to a readonly user', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/accounting/export', headers: { cookie: readonlyCookie }, payload: WINDOW });
    expect(res.statusCode).toBe(403);
  });

  it('files a zip as a document and hands back its id', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/accounting/export', headers: { cookie }, payload: { ...WINDOW, buildingId } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.debitMinor).toBe(body.creditMinor);
    expect(body.entryCount).toBe(2);
    expect(body.fileName).toBe('smetkovodstvo-2026-01-01-2027-01-01.zip');

    const download = await t.app.inject({ method: 'GET', url: `/api/documents/${body.documentId}/download`, headers: { cookie } });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('application/zip');

    const files = unzipSync(new Uint8Array(download.rawPayload));
    expect(Object.keys(files).sort()).toEqual(['README.txt', 'bruto-bilans.csv', 'dnevnik.csv']);

    const journal = strFromU8(files['dnevnik.csv']!);
    expect(journal.charCodeAt(0)).toBe(0xfeff); // the BOM Excel needs for a `;` file in Macedonian
    const [header, ...lines] = journal.slice(1).trim().split('\n');
    expect(header).toBe('ставка;датум;период;конто;назив;должи;побарува;опис;зграда;партнер;извор;извор-ид');
    // Entry order is by civil day then refType, and both events are dated today, so find the rows
    // by their account rather than by position: the figures are the point, not the sequence.
    const cells = lines.map((l) => l.split(';'));
    const receivable = cells.find((c) => c[3] === '1200')!;
    expect([receivable[2], receivable[4], receivable[5], receivable[6]]).toEqual(['2026-09', 'Побарувања', '1.180,00', '0,00']);
    expect(cells.some((c) => c[3] === '4000' && c[4] === 'Трошоци' && c[5] === '400,00')).toBe(true);

    const trial = strFromU8(files['bruto-bilans.csv']!).slice(1).trim().split('\n');
    expect(trial[0]).toBe('конто;назив;должи;побарува;разлика');
    expect(trial.at(-1)).toBe('ВКУПНО;;1.580,00;1.580,00;0,00');

    const readme = strFromU8(files['README.txt']!);
    expect(readme).toContain('Организација: Firma acct-export');
    expect(readme).toContain('Зграда: Илинденска 7');
    expect(readme).toContain('Ставки: 2');
    expect(readme).toContain('Должи: 1.580,00');
    expect(readme).toContain('Побарува: 1.580,00');
    expect(readme).toContain('Корекции од претходни периоди: 0');
  });

  it('refuses while the chart is incomplete, naming every missing slot', async () => {
    const other = await registerTenant(t.app, 'acct-export-2');
    const res = await t.app.inject({ method: 'POST', url: '/api/accounting/export', headers: { cookie: other.cookie }, payload: WINDOW });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('chart_incomplete');
    expect(res.json().error.details.missing).toHaveLength(9);
  });

  it('writes an audit row naming the document', async () => {
    const rows = await t.db.query.auditLogs.findMany({});
    expect(rows.some((r) => r.action === 'accounting.export')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @domar/api test -- accounting-export`
Expected: FAIL — `POST /api/accounting/export` returns 404.

- [ ] **Step 3: Write the CSV/zip builder**

Create `apps/api/src/resources/accounting/export.ts`:

```ts
import { csvCell, type Journal, type JournalEntry } from '@domar/domain';
import { strToU8, zipSync } from 'fflate';

/** Excel on a Macedonian Windows reads a `;` file as columns only when a BOM says it is UTF-8. */
const BOM = '﻿';

function csv(header: string[], rows: (string | number)[][]): string {
  const line = (xs: (string | number)[]) => xs.map((x) => csvCell(String(x))).join(';');
  return `${BOM}${[line(header), ...rows.map(line)].join('\n')}\n`;
}

/**
 * Minor units as a decimal with a comma and a thousands dot, which is what a `;` file means in this
 * locale. Integer arithmetic only: the money has been in minor units the whole way here (spec §8).
 */
export function money(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${whole},${String(abs % 100).padStart(2, '0')}`;
}

export interface AccountingExportMeta {
  tenantName: string;
  buildingName: string | null;
  from: string;
  to: string;
  createdAt: Date;
}

const JOURNAL_HEADER = ['ставка', 'датум', 'период', 'конто', 'назив', 'должи', 'побарува', 'опис', 'зграда', 'партнер', 'извор', 'извор-ид'];

function journalRows(entries: JournalEntry[]): (string | number)[][] {
  return entries.flatMap((e) => e.lines.map((l) => [
    e.no, e.date, e.period, l.code, l.name, money(l.debitMinor), money(l.creditMinor),
    l.description, e.buildingName, e.counterparty, e.sourceType, e.sourceId,
  ]));
}

/**
 * The accountant's zip (spec §6): the journal, the trial balance that proves it balances, the
 * prior-period adjustments when there are any, and a README they can check at a glance.
 */
export function buildAccountingExport(journal: Journal, meta: AccountingExportMeta): Buffer {
  const t = journal.totals;
  const files: Record<string, Uint8Array> = {
    'dnevnik.csv': strToU8(csv(JOURNAL_HEADER, journalRows(journal.entries))),
    'bruto-bilans.csv': strToU8(csv(
      ['конто', 'назив', 'должи', 'побарува', 'разлика'],
      [
        ...journal.trialBalance.map((r) => [r.code, r.name, money(r.debitMinor), money(r.creditMinor), money(r.differenceMinor)]),
        ['ВКУПНО', '', money(t.debitMinor), money(t.creditMinor), money(t.debitMinor - t.creditMinor)],
      ],
    )),
    'README.txt': strToU8([
      `Организација: ${meta.tenantName}`,
      `Зграда: ${meta.buildingName ?? 'сите'}`,
      `Период: ${meta.from} — ${meta.to} (крајот не е вклучен)`,
      `Изготвено: ${meta.createdAt.toISOString()}`,
      `Ставки: ${t.entryCount}`,
      `Редови: ${t.lineCount}`,
      `Должи: ${money(t.debitMinor)}`,
      `Побарува: ${money(t.creditMinor)}`,
      `Разлика: ${money(t.debitMinor - t.creditMinor)}`,
      `Корекции од претходни периоди: ${journal.adjustments.length}`,
      `Затворени периоди во овој извоз: ${journal.closedPeriods.length ? journal.closedPeriods.join(', ') : 'нема'}`,
      '',
      'Датотеките се UTF-8 со BOM и раздвојувач „;“.',
      '',
    ].join('\n')),
  };
  // Present only when there are any, so an empty file never suggests something was missed (spec §6).
  if (journal.adjustments.length > 0) {
    files['korekcii.csv'] = strToU8(csv(
      [...JOURNAL_HEADER, 'затворен-период'],
      journal.adjustments.flatMap((e) => e.lines.map((l) => [
        e.no, e.date, e.period, l.code, l.name, money(l.debitMinor), money(l.creditMinor),
        l.description, e.buildingName, e.counterparty, e.sourceType, e.sourceId, e.closedPeriod ? 'да' : 'не',
      ])),
    ));
  }
  return Buffer.from(zipSync(files, { level: 6 }));
}
```

- [ ] **Step 4: Write the service**

Create `apps/api/src/resources/accounting/service.ts`:

```ts
import type { Db } from '@domar/db';
import { writeAudit } from '../../audit.js';
import type { DocumentStore } from '../../documents/store.js';
import type { TenantContext } from '../../tenant-context.js';
import { createDocumentFromBuffer } from '../documents/repo.js';
import { buildJournalFor } from './data.js';
import { buildAccountingExport } from './export.js';

export interface AccountingRuntime {
  documents: DocumentStore;
  log: { warn(obj: unknown, msg: string): void };
}

export interface AccountingExportInput {
  from: string;
  to: string;
  buildingId?: string | undefined;
}

/**
 * One transaction: the zip is built before anything is filed, and a failure anywhere takes the
 * document row *and* its bytes back with it — the same shape `resources/reports/service.ts` uses,
 * because a file with no row is an orphan nothing reaches.
 */
export async function exportAccounting(db: Db, ctx: TenantContext, input: AccountingExportInput, rt: AccountingRuntime) {
  return db.transaction(async (tx) => {
    const { journal, buildingName, tenantName } = await buildJournalFor(tx, ctx, {
      from: new Date(`${input.from}T00:00:00.000Z`),
      to: new Date(`${input.to}T00:00:00.000Z`),
      ...(input.buildingId ? { buildingId: input.buildingId } : {}),
    });
    const createdAt = new Date();
    const zip = buildAccountingExport(journal, { tenantName, buildingName, from: input.from, to: input.to, createdAt });
    const fileName = `smetkovodstvo-${input.from}-${input.to}.zip`;
    const document = await createDocumentFromBuffer(tx, ctx, rt.documents, {
      // `other`, not `report`: the portal shows owners reports of their building, and a journal of
      // the whole organization is for the accountant, never for a resident.
      buildingId: input.buildingId ?? null, kind: 'other',
      title: `Сметководствен извоз ${input.from} — ${input.to}`,
      fileName, mime: 'application/zip', content: zip,
    });
    try {
      await writeAudit(tx, ctx, {
        action: 'accounting.export', entityType: 'document', entityId: document.id,
        after: {
          from: input.from, to: input.to, buildingId: input.buildingId ?? null, documentId: document.id,
          entryCount: journal.totals.entryCount, adjustmentCount: journal.adjustments.length,
          debitMinor: journal.totals.debitMinor, creditMinor: journal.totals.creditMinor,
          closedPeriods: journal.closedPeriods,
        },
      });
      return {
        documentId: document.id, fileName,
        entryCount: journal.totals.entryCount, adjustmentCount: journal.adjustments.length,
        debitMinor: journal.totals.debitMinor, creditMinor: journal.totals.creditMinor,
      };
    } catch (err) {
      try {
        await rt.documents.remove(document.storageKey);
      } catch (removeErr) {
        rt.log.warn({ err: removeErr, documentId: document.id }, 'accounting export rolled back but its file could not be removed');
      }
      throw err;
    }
  });
}
```

- [ ] **Step 5: Add the schema and the route**

Append to `apps/api/src/resources/accounting/schema.ts`:

```ts
export const accountingExportBody = z.object({
  from: dateOnly, to: dateOnly, buildingId: z.string().uuid().optional(),
});
export const accountingExportOut = z.object({
  documentId: z.string(), fileName: z.string(), entryCount: z.number(), adjustmentCount: z.number(),
  debitMinor: z.number(), creditMinor: z.number(),
});
```

In `apps/api/src/resources/accounting/routes.ts`, inside `accountingRoutes`:

```ts
  app.post('/export', {
    preHandler: requireRole(...WRITE_ROLES),
    schema: { body: accountingExportBody, response: { 201: accountingExportOut } },
  }, async (req, reply) => reply.status(201).send(await exportAccounting(req.db, req.ctx!, req.body, {
    documents: app.documents, log: app.log,
  })));
```

with the added imports `import { exportAccounting } from './service.js';` and the two new schema names.

- [ ] **Step 6: Run the test and watch it pass**

Run: `pnpm --filter @domar/api test -- accounting-export`
Expected: PASS, 4 cases.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm typecheck
git add apps/api/src/resources/accounting apps/api/test/accounting-export.test.ts
git commit -m "feat(api): file the accounting export as a zip of ;-CSVs"
```

---

### Task 6: Closing and reopening a period

**Files:**
- Create: `apps/api/src/resources/accounting/periods.ts`
- Modify: `apps/api/src/resources/accounting/schema.ts` (period params + list/close responses)
- Modify: `apps/api/src/resources/accounting/routes.ts` (three routes)
- Test: `apps/api/test/accounting-periods.test.ts`

**Interfaces:**
- Consumes: `schema.accountingPeriods` (Task 1); `buildJournalFor` (Task 4); `periodStartDate`, `nextPeriod` from `@domar/domain`; `tenantPack` from `../reports/data.js`.
- Produces:
  - `listAccountingPeriods(db: Db, ctx: TenantContext): Promise<{ rows: AccountingPeriodRow[] }>` where each row carries `closedByName: string | null`
  - `closeAccountingPeriod(db: Db, ctx: TenantContext, period: string): Promise<AccountingPeriodRow>`
  - `reopenAccountingPeriod(db: Db, ctx: TenantContext, period: string): Promise<void>`
  - `GET /api/accounting/periods`, `POST /api/accounting/periods/:period/close`, `DELETE /api/accounting/periods/:period`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/accounting-periods.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaffUser, registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
let cookie: string;
let readonlyCookie: string;
let buildingId: string;
let periodId: string;

beforeAll(async () => {
  t = await createTestApp();
  const reg = await registerTenant(t.app, 'acct-periods');
  cookie = reg.cookie;
  readonlyCookie = (await createStaffUser(t.app, cookie, 'acct-periods', { email: 'r@acct-periods.mk', firstName: 'R', lastName: 'O', role: 'readonly' })).cookie;
  const post = async (url: string, payload: unknown = {}) => {
    const res = await t.app.inject({ method: 'POST', url, headers: { cookie }, payload });
    if (res.statusCode >= 300) throw new Error(`${url} → ${res.body}`);
    return res.json();
  };
  const rates = (await t.app.inject({ method: 'GET', url: '/api/tax-rates', headers: { cookie } })).json();
  const vatId = rates.rows.find((r: { rateBp: number }) => r.rateBp === 1800).id;
  const owner = await post('/api/contacts', { firstName: 'Петар', lastName: 'Петров' });
  const building = await post('/api/buildings', { name: 'Македонија 3', address: 'Македонија 3', city: 'Скопје', postalCode: '1000' });
  buildingId = building.id;
  await post(`/api/buildings/${buildingId}/units`, { label: '1', kind: 'apartment', areaM2: 40, ownerContactId: owner.id });
  const service = await post('/api/services', { name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 100000, taxRateId: vatId, appliesTo: ['apartment'] });
  await post(`/api/buildings/${buildingId}/services`, { serviceId: service.id, startsPeriod: '2026-01' });
  const period = await post(`/api/buildings/${buildingId}/periods`, { period: '2026-09' });
  periodId = period.id;
  await post(`/api/buildings/${buildingId}/periods/${periodId}/generate`);
  await post(`/api/buildings/${buildingId}/periods/${periodId}/publish`);
  const slots: [string, string, string][] = [
    ['owner_receivable', '1200', 'Побарувања'], ['revenue_service', '7400', 'Приходи од услуги'],
    ['revenue_management_fee', '7410', 'Приходи од управување'], ['revenue_reserve_fund', '7420', 'Резервен фонд'],
    ['vat_output', '4700', 'ДДВ на излез'], ['cash_regular', '1000', 'Редовна сметка'],
    ['cash_reserve', '1001', 'Резервна сметка'], ['expense_default', '4000', 'Трошоци'], ['opening_balance', '9000', 'Почетна состојба'],
  ];
  for (const [slot, code, name] of slots) {
    await t.app.inject({ method: 'PUT', url: `/api/account-codes/${slot}`, headers: { cookie }, payload: { code, name } });
  }
});
afterAll(async () => { await t.close(); });

const thisPeriod = () => new Date().toISOString().slice(0, 7);

describe('closing a period', () => {
  it('is refused to a readonly user', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/accounting/periods/${thisPeriod()}/close`, headers: { cookie: readonlyCookie } });
    expect(res.statusCode).toBe(403);
  });

  it('records the totals, who closed it and when', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/accounting/periods/${thisPeriod()}/close`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const row = res.json();
    expect(row.period).toBe(thisPeriod());
    expect(row.debitTotalMinor).toBe(row.creditTotalMinor);
    expect(row.debitTotalMinor).toBe(118000);
    expect(row.entryCount).toBe(1);
    expect(row.closedAt).toBeTruthy();
    expect(row.closedByName).toBe('O acct-periods');
  });

  it('adds no refusal anywhere else: a payment into the closed period still records', async () => {
    const invoices = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}`, headers: { cookie } })).json();
    const res = await t.app.inject({
      method: 'POST', url: `/api/invoices/${invoices.rows[0].id}/payments`, headers: { cookie },
      payload: { amountMinor: 18000, method: 'cash', paidAt: new Date().toISOString() },
    });
    expect(res.statusCode).toBe(201);
  });

  it('re-closing rewrites the totals rather than adding a second row', async () => {
    const again = await t.app.inject({ method: 'POST', url: `/api/accounting/periods/${thisPeriod()}/close`, headers: { cookie } });
    expect(again.statusCode).toBe(200);
    expect(again.json().entryCount).toBe(2);
    expect(again.json().debitTotalMinor).toBe(136000);
    const list = await t.app.inject({ method: 'GET', url: '/api/accounting/periods', headers: { cookie } });
    expect(list.json().rows).toHaveLength(1);
  });

  it('audits both the close and the reopen', async () => {
    const del = await t.app.inject({ method: 'DELETE', url: `/api/accounting/periods/${thisPeriod()}`, headers: { cookie } });
    expect(del.statusCode).toBe(204);
    const list = await t.app.inject({ method: 'GET', url: '/api/accounting/periods', headers: { cookie } });
    expect(list.json().rows).toEqual([]);
    const rows = await t.db.query.auditLogs.findMany({});
    expect(rows.filter((r) => r.action === 'accounting.period_close')).toHaveLength(2);
    expect(rows.filter((r) => r.action === 'accounting.period_reopen')).toHaveLength(1);
  });

  it('reopening a period that was never closed is a 404', async () => {
    const res = await t.app.inject({ method: 'DELETE', url: '/api/accounting/periods/2019-01', headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a malformed period', async () => {
    expect((await t.app.inject({ method: 'POST', url: '/api/accounting/periods/2026-13/close', headers: { cookie } })).statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @domar/api test -- accounting-periods`
Expected: FAIL — the close route is 404.

- [ ] **Step 3: Write the period repo**

Create `apps/api/src/resources/accounting/periods.ts`:

```ts
import { type Db, schema } from '@domar/db';
import { nextPeriod, periodStartDate } from '@domar/domain';
import { and, asc, eq } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { tenantPack } from '../reports/data.js';
import { buildJournalFor } from './data.js';

const AP = schema.accountingPeriods; const U = schema.users;
export type AccountingPeriodRow = typeof AP.$inferSelect;

export async function listAccountingPeriods(db: Db, ctx: TenantContext) {
  const rows = await db.select({ p: AP, firstName: U.firstName, lastName: U.lastName }).from(AP)
    .leftJoin(U, eq(U.id, AP.closedBy))
    .where(eq(AP.tenantId, ctx.tenantId))
    .orderBy(asc(AP.period));
  return {
    rows: rows.map((r) => ({
      ...r.p,
      closedByName: r.firstName ? `${r.firstName} ${r.lastName}`.trim() : null,
    })),
  };
}

/**
 * Advisory, not a lock (spec §5). Closing writes down what the month said when it was filed and
 * refuses nothing anywhere else; a posting that arrives afterwards comes back in the next export's
 * prior-period adjustments, which is what lets an accountant trust the file they already posted.
 * Re-closing is allowed and rewrites the totals, with who and when in the audit trail.
 */
export async function closeAccountingPeriod(db: Db, ctx: TenantContext, period: string) {
  return db.transaction(async (tx) => {
    const { tenant } = await tenantPack(tx, ctx);
    const { journal } = await buildJournalFor(tx, ctx, {
      from: periodStartDate(period, tenant.timezone),
      to: periodStartDate(nextPeriod(period), tenant.timezone),
    });
    const [before] = await tx.select().from(AP).where(and(eq(AP.tenantId, ctx.tenantId), eq(AP.period, period))).limit(1);
    const values = {
      closedAt: new Date(), closedBy: ctx.userId,
      debitTotalMinor: journal.totals.debitMinor, creditTotalMinor: journal.totals.creditMinor,
      entryCount: journal.totals.entryCount,
    };
    const [row] = await tx.insert(AP).values({ tenantId: ctx.tenantId, period, ...values })
      .onConflictDoUpdate({ target: [AP.tenantId, AP.period], set: { ...values, updatedAt: new Date() } }).returning();
    await writeAudit(tx, ctx, { action: 'accounting.period_close', entityType: 'accounting_period', entityId: row!.id, before: before ?? null, after: row });
    return row!;
  });
}

export async function reopenAccountingPeriod(db: Db, ctx: TenantContext, period: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [before] = await tx.delete(AP).where(and(eq(AP.tenantId, ctx.tenantId), eq(AP.period, period))).returning();
    if (!before) throw notFound('Accounting period');
    await writeAudit(tx, ctx, { action: 'accounting.period_reopen', entityType: 'accounting_period', entityId: before.id, before, after: null });
  });
}
```

- [ ] **Step 4: Add the schema and the routes**

Append to `apps/api/src/resources/accounting/schema.ts`:

```ts
export const accountingPeriodParam = z.object({ period: periodStr });
export const accountingPeriodOut = z.object({
  id: z.string(), period: z.string(), closedAt: z.date().or(z.string()), closedBy: z.string().nullable(),
  closedByName: z.string().nullable(),
  debitTotalMinor: z.number(), creditTotalMinor: z.number(), entryCount: z.number(),
});
export const accountingPeriodListOut = z.object({ rows: z.array(accountingPeriodOut) });
```

with `import { periodStr } from '../common.js';` at the top of the file. `closeAccountingPeriod` returns the raw row, which has no `closedByName`, so the route adds it:

In `apps/api/src/resources/accounting/routes.ts`, inside `accountingRoutes`:

```ts
  app.get('/periods', { schema: { response: { 200: accountingPeriodListOut } } }, async (req) =>
    listAccountingPeriods(req.db, req.ctx!));

  app.post('/periods/:period/close', {
    preHandler: requireRole(...WRITE_ROLES),
    schema: { params: accountingPeriodParam, response: { 200: accountingPeriodOut } },
  }, async (req) => {
    const row = await closeAccountingPeriod(req.db, req.ctx!, req.params.period);
    const { rows } = await listAccountingPeriods(req.db, req.ctx!);
    return rows.find((r) => r.id === row.id)!;
  });

  app.delete('/periods/:period', {
    preHandler: requireRole(...WRITE_ROLES),
    schema: { params: accountingPeriodParam },
  }, async (req, reply) => {
    await reopenAccountingPeriod(req.db, req.ctx!, req.params.period);
    return reply.status(204).send();
  });
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `pnpm --filter @domar/api test -- accounting-periods`
Expected: PASS, 7 cases.

- [ ] **Step 6: Run the whole API suite, typecheck and commit**

Run: `pnpm --filter @domar/api test`
Expected: PASS — in particular `payments.test.ts`, `invoicing.test.ts` and `reserve-fund.test.ts` are untouched, which is the proof that closing a period added no refusal.

```bash
pnpm typecheck
git add apps/api/src/resources/accounting apps/api/test/accounting-periods.test.ts
git commit -m "feat(api): close and reopen an accounting period, advisory only"
```

---

### Task 7: The Accounting page

**Files:**
- Create: `apps/web/src/pages/AccountingPage.vue`
- Modify: `apps/web/src/router/index.ts` (one child route)
- Modify: `apps/web/src/layouts/AppShell.vue:12-15` (one nav entry)
- Modify: `apps/web/src/api/types.ts` (five interfaces)
- Modify: `apps/web/src/i18n/mk.ts` and `apps/web/src/i18n/en.ts` (the `accounting` block)
- Test: `apps/web/test/AccountingPage.test.ts`

**Interfaces:**
- Consumes the API of Tasks 3–6: `GET /api/account-codes` → `{ rows, missing }`, `PUT /api/account-codes/:slot`, `GET /api/accounting/preview?from&to&buildingId`, `POST /api/accounting/export`, `GET /api/accounting/periods`, `POST /api/accounting/periods/:period/close`, `DELETE /api/accounting/periods/:period`.
- Produces the `data-test` hooks Task 8's e2e spec drives: `accounting-missing`, `account-code-<slot>-code`, `account-code-<slot>-name`, `account-code-<slot>-save`, `accounting-from`, `accounting-to`, `accounting-building`, `accounting-preview`, `accounting-balanced`, `accounting-unbalanced`, `trial-row`, `accounting-total-debit`, `accounting-total-credit`, `accounting-export`, `accounting-export-download`, `accounting-period`, `accounting-close`, `accounting-period-row`, `accounting-reopen`, `page-error`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/AccountingPage.test.ts`:

```ts
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api/client';
import { i18n, messages } from '@/i18n';
import AccountingPage from '@/pages/AccountingPage.vue';

const flush = () => new Promise((r) => setTimeout(r, 0));

const CHART = {
  rows: [{ id: 'a1', slot: 'owner_receivable', code: '1200', name: 'Побарувања', isActive: true }],
  missing: ['revenue_service', 'vat_output'],
};
const PREVIEW = {
  from: '2026-09-01', to: '2026-10-01', buildingName: null,
  trialBalance: [
    { code: '1200', name: 'Побарувања', debitMinor: 118000, creditMinor: 0, differenceMinor: 118000 },
    { code: '7400', name: 'Приходи', debitMinor: 0, creditMinor: 100000, differenceMinor: -100000 },
    { code: '4700', name: 'ДДВ', debitMinor: 0, creditMinor: 18000, differenceMinor: -18000 },
  ],
  totals: { debitMinor: 118000, creditMinor: 118000, entryCount: 1, lineCount: 3 },
  adjustmentCount: 0, closedPeriods: [], balanced: true,
};

beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
});

function mountPage() {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/api/account-codes') return CHART as never;
    if (path === '/api/accounting/periods') return { rows: [] } as never;
    if (path === '/api/accounting/preview') return PREVIEW as never;
    if (path === '/api/buildings') return { rows: [{ id: 'b1', name: 'Партизанска 1' }] } as never;
    throw new Error(`unexpected GET ${path}`);
  });
  return mount(AccountingPage, { global: { plugins: [i18n] } });
}

describe('AccountingPage', () => {
  it('names every unmapped slot so the manager knows why the export is blocked', async () => {
    const w = mountPage();
    await flush();
    const text = w.get('[data-test=accounting-missing]').text();
    expect(text).toContain(messages.mk.accounting.slots.revenue_service);
    expect(text).toContain(messages.mk.accounting.slots.vat_output);
  });

  it('saves one slot through PUT /api/account-codes/:slot', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({ id: 'a2', slot: 'vat_output', code: '4700', name: 'ДДВ', isActive: true } as never);
    const w = mountPage();
    await flush();
    await w.get('[data-test=account-code-vat_output-code]').setValue('4700');
    await w.get('[data-test=account-code-vat_output-name]').setValue('ДДВ на излез');
    await w.get('[data-test=account-code-vat_output-save]').trigger('click');
    await flush();
    expect(put).toHaveBeenCalledWith('/api/account-codes/vat_output', { code: '4700', name: 'ДДВ на излез' });
  });

  it('shows a balanced trial balance in minor-unit-faithful money', async () => {
    const w = mountPage();
    await flush();
    await w.get('[data-test=accounting-from]').setValue('2026-09-01');
    await w.get('[data-test=accounting-to]').setValue('2026-10-01');
    await w.get('[data-test=accounting-preview]').trigger('click');
    await flush();
    expect(w.findAll('[data-test=trial-row]')).toHaveLength(3);
    expect(w.get('[data-test=accounting-total-debit]').text()).toBe('1.180,00 ден.');
    expect(w.find('[data-test=accounting-balanced]').exists()).toBe(true);
    expect(w.find('[data-test=accounting-unbalanced]').exists()).toBe(false);
  });

  it('turns red when the trial balance does not close', async () => {
    const w = mountPage();
    await flush();
    vi.spyOn(api, 'get').mockResolvedValue({ ...PREVIEW, totals: { ...PREVIEW.totals, creditMinor: 117000 }, balanced: false } as never);
    await w.get('[data-test=accounting-preview]').trigger('click');
    await flush();
    expect(w.find('[data-test=accounting-unbalanced]').exists()).toBe(true);
    expect(w.find('[data-test=accounting-export]').attributes('disabled')).toBeDefined();
  });

  it('shows the chart_incomplete error in Macedonian', async () => {
    const w = mountPage();
    await flush();
    vi.spyOn(api, 'get').mockRejectedValue(Object.assign(new Error('x'), { code: 'chart_incomplete' }));
    await w.get('[data-test=accounting-preview]').trigger('click');
    await flush();
    expect(w.get('[data-test=page-error]').text()).toBe(messages.mk.accounting.errors.chart_incomplete);
  });

  it('closes a period and offers to reopen it', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      id: 'ap1', period: '2026-09', closedAt: '2026-10-01T09:00:00.000Z', closedBy: 'u1', closedByName: 'Ана',
      debitTotalMinor: 118000, creditTotalMinor: 118000, entryCount: 1,
    } as never);
    const w = mountPage();
    await flush();
    await w.get('[data-test=accounting-period]').setValue('2026-09');
    await w.get('[data-test=accounting-close]').trigger('click');
    await flush();
    expect(post).toHaveBeenCalledWith('/api/accounting/periods/2026-09/close');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @domar/web test -- AccountingPage`
Expected: FAIL — `Failed to resolve import "@/pages/AccountingPage.vue"`.

- [ ] **Step 3: Add the i18n block — Macedonian first**

In `apps/web/src/i18n/mk.ts`, add after the `reports: { … },` block:

```ts
  accounting: {
    title: 'Сметководство',
    chart: 'Контен план',
    chartHint: 'Внесете ги вашите конта. Извозот не се изготвува додека некое конто недостасува.',
    slot: 'Позиција', code: 'Конто', name: 'Назив', save: 'Зачувај', saved: 'Зачувано.',
    missing: 'Недостасуваат конта: {slots}',
    complete: 'Контниот план е целосен.',
    slots: {
      owner_receivable: 'Побарувања од сопственици',
      revenue_service: 'Приходи од услуги',
      revenue_management_fee: 'Приходи од управување',
      revenue_reserve_fund: 'Приходи за резервен фонд',
      vat_output: 'ДДВ на излез',
      cash_regular: 'Сметка — редовен фонд',
      cash_reserve: 'Сметка — резервен фонд',
      expense_default: 'Трошоци (основно конто)',
      opening_balance: 'Почетна состојба',
    },
    window: 'Период на извозот', from: 'Од', to: 'До (не се вклучува)', building: 'Зграда', allBuildings: 'Сите згради',
    preview: 'Пресметај', trialBalance: 'Бруто биланс',
    account: 'Конто', debit: 'Должи', credit: 'Побарува', difference: 'Разлика', total: 'Вкупно',
    entries: 'Ставки', lines: 'Редови', adjustments: 'Корекции од претходни периоди',
    balanced: 'Билансот се затвора.',
    unbalanced: 'Билансот НЕ се затвора — извозот е блокиран.',
    export: 'Изготви извоз (zip)', exported: 'Извозот е зачуван меѓу документите.', download: 'Преземи',
    periods: 'Затворени периоди', period: 'Период', close: 'Затвори период', reopen: 'Отвори повторно',
    closedAt: 'Затворен на', closedBy: 'Затворил', entryCount: 'Ставки',
    closeHint: 'Затворањето ништо не забранува: подоцнежна уплата за затворен месец се евидентира како и досега и излегува во следниот извоз како корекција.',
    errors: {
      chart_incomplete: 'Контниот план не е целосен — пополнете ги сите конта.',
      unbalanced_entry: 'Една ставка не се затвора; извозот е запрен.',
      unbalanced_file: 'Извозот не се затвора; ништо не е зачувано.',
      unknown_source: 'Во главната книга има запис што извозот не го препознава.',
      invalid_window: 'Крајот на периодот мора да биде по неговиот почеток.',
      not_found: 'Записот не е пронајден.',
      forbidden: 'Немате право да менувате сметководствени податоци.',
      validation: 'Проверете ги внесените податоци.',
      generic: 'Настана грешка. Обидете се повторно.',
    },
  },
```

In `apps/web/src/i18n/en.ts`, add the same block at the same position, with the same keys:

```ts
  accounting: {
    title: 'Accounting',
    chart: 'Chart of accounts',
    chartHint: 'Enter your own account codes. The export will not run while any of them is missing.',
    slot: 'Slot', code: 'Code', name: 'Name', save: 'Save', saved: 'Saved.',
    missing: 'Unmapped accounts: {slots}',
    complete: 'The chart of accounts is complete.',
    slots: {
      owner_receivable: 'Owner receivables',
      revenue_service: 'Service revenue',
      revenue_management_fee: 'Management fee revenue',
      revenue_reserve_fund: 'Reserve fund revenue',
      vat_output: 'Output VAT',
      cash_regular: 'Account — regular fund',
      cash_reserve: 'Account — reserve fund',
      expense_default: 'Expenses (default account)',
      opening_balance: 'Opening balance',
    },
    window: 'Export window', from: 'From', to: 'To (exclusive)', building: 'Building', allBuildings: 'All buildings',
    preview: 'Calculate', trialBalance: 'Trial balance',
    account: 'Account', debit: 'Debit', credit: 'Credit', difference: 'Difference', total: 'Total',
    entries: 'Entries', lines: 'Lines', adjustments: 'Prior-period adjustments',
    balanced: 'The trial balance closes.',
    unbalanced: 'The trial balance does NOT close — the export is blocked.',
    export: 'Build export (zip)', exported: 'The export has been filed under documents.', download: 'Download',
    periods: 'Closed periods', period: 'Period', close: 'Close period', reopen: 'Reopen',
    closedAt: 'Closed at', closedBy: 'Closed by', entryCount: 'Entries',
    closeHint: 'Closing forbids nothing: a later payment for a closed month is recorded as before and comes back in the next export as an adjustment.',
    errors: {
      chart_incomplete: 'The chart of accounts is incomplete — map every account.',
      unbalanced_entry: 'An entry does not balance; the export was stopped.',
      unbalanced_file: 'The export does not balance; nothing was saved.',
      unknown_source: 'The ledger holds a record the export does not recognise.',
      invalid_window: 'The end of the window must come after its start.',
      not_found: 'Not found.',
      forbidden: 'You are not allowed to change accounting data.',
      validation: 'Check the values you entered.',
      generic: 'Something went wrong. Try again.',
    },
  },
```

Also add the nav label to both files, inside the existing `nav: { … }` object: `accounting: 'Сметководство',` in `mk.ts` and `accounting: 'Accounting',` in `en.ts`.

- [ ] **Step 4: Add the API types**

Append to `apps/web/src/api/types.ts`:

```ts
export type AccountSlot =
  | 'owner_receivable' | 'revenue_service' | 'revenue_management_fee' | 'revenue_reserve_fund'
  | 'vat_output' | 'cash_regular' | 'cash_reserve' | 'expense_default' | 'opening_balance';
export interface AccountCode { id: string; slot: AccountSlot; code: string; name: string; isActive: boolean }
export interface AccountCodeList { rows: AccountCode[]; missing: AccountSlot[] }
export interface TrialBalanceRow { code: string; name: string; debitMinor: number; creditMinor: number; differenceMinor: number }
export interface AccountingPreview {
  from: string; to: string; buildingName: string | null;
  trialBalance: TrialBalanceRow[];
  totals: { debitMinor: number; creditMinor: number; entryCount: number; lineCount: number };
  adjustmentCount: number; closedPeriods: string[]; balanced: boolean;
}
export interface AccountingExport {
  documentId: string; fileName: string; entryCount: number; adjustmentCount: number; debitMinor: number; creditMinor: number;
}
export interface AccountingPeriod {
  id: string; period: string; closedAt: string; closedBy: string | null; closedByName: string | null;
  debitTotalMinor: number; creditTotalMinor: number; entryCount: number;
}
```

- [ ] **Step 5: Write the page**

Create `apps/web/src/pages/AccountingPage.vue`:

```vue
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, API_BASE, ApiError } from '@/api/client';
import type { AccountCode, AccountCodeList, AccountingExport, AccountingPeriod, AccountingPreview, AccountSlot, Building } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import { swallow } from '@/composables/useResource';
import { formatDateTime, formatMoney } from '@/utils/money';

const SLOTS: AccountSlot[] = [
  'owner_receivable', 'revenue_service', 'revenue_management_fee', 'revenue_reserve_fund',
  'vat_output', 'cash_regular', 'cash_reserve', 'expense_default', 'opening_balance',
];

const { t, te } = useI18n();
const chart = ref<AccountCodeList>({ rows: [], missing: [] });
const draft = ref<Record<string, { code: string; name: string }>>(Object.fromEntries(SLOTS.map((s) => [s, { code: '', name: '' }])));
const buildings = ref<Building[]>([]);
const periods = ref<AccountingPeriod[]>([]);
const preview = ref<AccountingPreview | null>(null);
const exported = ref<AccountingExport | null>(null);
const from = ref('');
const to = ref('');
const buildingId = ref('');
const period = ref('');
const saved = ref('');
const error = ref('');

const missingNames = computed(() => chart.value.missing.map((s) => t(`accounting.slots.${s}`)).join(', '));
const downloadUrl = computed(() => (exported.value ? `${API_BASE}/api/documents/${exported.value.documentId}/download` : ''));

function fail(e: unknown) {
  const code = e instanceof ApiError ? e.code : (e as { code?: string }).code ?? 'generic';
  error.value = te(`accounting.errors.${code}`) ? t(`accounting.errors.${code}`) : t('accounting.errors.generic');
}

async function loadChart() {
  chart.value = await api.get<AccountCodeList>('/api/account-codes');
  for (const row of chart.value.rows) draft.value[row.slot] = { code: row.code, name: row.name };
}
async function loadPeriods() { periods.value = (await api.get<{ rows: AccountingPeriod[] }>('/api/accounting/periods')).rows; }

onMounted(() => {
  swallow(loadChart());
  swallow(loadPeriods());
  swallow(api.get<{ rows: Building[] }>('/api/buildings').then((r) => { buildings.value = r.rows; }));
});

async function saveSlot(slot: AccountSlot) {
  error.value = ''; saved.value = '';
  try {
    const row = await api.put<AccountCode>(`/api/account-codes/${slot}`, { code: draft.value[slot]!.code, name: draft.value[slot]!.name });
    saved.value = row.slot;
    await loadChart();
  } catch (e) { fail(e); }
}

async function runPreview() {
  error.value = ''; preview.value = null;
  try {
    preview.value = await api.get<AccountingPreview>('/api/accounting/preview', {
      from: from.value, to: to.value, ...(buildingId.value ? { buildingId: buildingId.value } : {}),
    });
  } catch (e) { fail(e); }
}

async function runExport() {
  error.value = ''; exported.value = null;
  try {
    exported.value = await api.post<AccountingExport>('/api/accounting/export', {
      from: from.value, to: to.value, ...(buildingId.value ? { buildingId: buildingId.value } : {}),
    });
  } catch (e) { fail(e); }
}

async function closePeriod() {
  error.value = '';
  try { await api.post<AccountingPeriod>(`/api/accounting/periods/${period.value}/close`); await loadPeriods(); } catch (e) { fail(e); }
}
async function reopenPeriod(p: string) {
  error.value = '';
  try { await api.del(`/api/accounting/periods/${p}`); await loadPeriods(); } catch (e) { fail(e); }
}
</script>
<template>
  <div class="space-y-6">
    <h1 class="text-2xl font-semibold">{{ t('accounting.title') }}</h1>
    <p v-if="error" class="text-sm text-red-600" data-test="page-error">{{ error }}</p>

    <section>
      <h2 class="mb-2 text-lg font-semibold">{{ t('accounting.chart') }}</h2>
      <p class="mb-2 text-sm text-slate-600">{{ t('accounting.chartHint') }}</p>
      <p v-if="chart.missing.length" class="mb-2 text-sm text-red-600" data-test="accounting-missing">
        {{ t('accounting.missing', { slots: missingNames }) }}
      </p>
      <p v-else class="mb-2 text-sm text-green-700" data-test="accounting-complete">{{ t('accounting.complete') }}</p>
      <div v-for="slot in SLOTS" :key="slot" class="mb-2 grid grid-cols-4 items-end gap-2">
        <span class="text-sm">{{ t(`accounting.slots.${slot}`) }}</span>
        <AppInput v-model="draft[slot]!.code" :label="t('accounting.code')" :data-test="`account-code-${slot}-code`" />
        <AppInput v-model="draft[slot]!.name" :label="t('accounting.name')" :data-test="`account-code-${slot}-name`" />
        <AppButton :data-test="`account-code-${slot}-save`" @click="saveSlot(slot)">{{ t('accounting.save') }}</AppButton>
      </div>
      <p v-if="saved" class="text-sm text-green-700" data-test="account-code-saved">{{ t('accounting.saved') }}</p>
    </section>

    <section>
      <h2 class="mb-2 text-lg font-semibold">{{ t('accounting.window') }}</h2>
      <div class="mb-3 grid grid-cols-4 items-end gap-2">
        <AppInput v-model="from" type="date" :label="t('accounting.from')" data-test="accounting-from" />
        <AppInput v-model="to" type="date" :label="t('accounting.to')" data-test="accounting-to" />
        <label class="text-sm">{{ t('accounting.building') }}
          <select v-model="buildingId" class="mt-1 w-full rounded border p-2" data-test="accounting-building">
            <option value="">{{ t('accounting.allBuildings') }}</option>
            <option v-for="b in buildings" :key="b.id" :value="b.id">{{ b.name }}</option>
          </select>
        </label>
        <AppButton data-test="accounting-preview" @click="runPreview">{{ t('accounting.preview') }}</AppButton>
      </div>

      <template v-if="preview">
        <p v-if="preview.balanced" class="mb-2 text-sm text-green-700" data-test="accounting-balanced">{{ t('accounting.balanced') }}</p>
        <p v-else class="mb-2 rounded bg-red-50 p-2 text-sm font-semibold text-red-700" data-test="accounting-unbalanced">{{ t('accounting.unbalanced') }}</p>
        <table class="w-full text-sm">
          <thead>
            <tr><th class="text-left">{{ t('accounting.account') }}</th><th class="text-left">{{ t('accounting.name') }}</th>
            <th class="text-right">{{ t('accounting.debit') }}</th><th class="text-right">{{ t('accounting.credit') }}</th><th class="text-right">{{ t('accounting.difference') }}</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in preview.trialBalance" :key="row.code" data-test="trial-row">
              <td>{{ row.code }}</td><td>{{ row.name }}</td>
              <td class="text-right">{{ formatMoney(row.debitMinor) }}</td>
              <td class="text-right">{{ formatMoney(row.creditMinor) }}</td>
              <td class="text-right">{{ formatMoney(row.differenceMinor) }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr class="font-semibold">
              <td colspan="2">{{ t('accounting.total') }}</td>
              <td class="text-right" data-test="accounting-total-debit">{{ formatMoney(preview.totals.debitMinor) }}</td>
              <td class="text-right" data-test="accounting-total-credit">{{ formatMoney(preview.totals.creditMinor) }}</td>
              <td class="text-right">{{ formatMoney(preview.totals.debitMinor - preview.totals.creditMinor) }}</td>
            </tr>
          </tfoot>
        </table>
        <p class="mt-2 text-sm text-slate-600">
          {{ t('accounting.entries') }}: {{ preview.totals.entryCount }} ·
          {{ t('accounting.lines') }}: {{ preview.totals.lineCount }} ·
          {{ t('accounting.adjustments') }}: {{ preview.adjustmentCount }}
        </p>
        <div class="mt-3 flex items-center gap-3">
          <AppButton :disabled="!preview.balanced" data-test="accounting-export" @click="runExport">{{ t('accounting.export') }}</AppButton>
          <template v-if="exported">
            <span class="text-sm text-green-700" data-test="accounting-exported">{{ t('accounting.exported') }}</span>
            <a class="text-sm underline" :href="downloadUrl" data-test="accounting-export-download">{{ t('accounting.download') }}</a>
          </template>
        </div>
      </template>
    </section>

    <section>
      <h2 class="mb-2 text-lg font-semibold">{{ t('accounting.periods') }}</h2>
      <p class="mb-2 text-sm text-slate-600">{{ t('accounting.closeHint') }}</p>
      <div class="mb-3 flex items-end gap-2">
        <AppInput v-model="period" :label="t('accounting.period')" placeholder="2026-09" data-test="accounting-period" />
        <AppButton data-test="accounting-close" @click="closePeriod">{{ t('accounting.close') }}</AppButton>
      </div>
      <DataTable
        :columns="[{ key: 'period', label: t('accounting.period') }, { key: 'entryCount', label: t('accounting.entryCount') }, { key: 'closedByName', label: t('accounting.closedBy') }]"
        :rows="periods"
      >
        <template #actions="{ row }">
          <span class="mr-3 text-sm" data-test="accounting-period-row">{{ formatDateTime(row.closedAt) }} · {{ formatMoney(row.debitTotalMinor) }}</span>
          <AppButton variant="secondary" data-test="accounting-reopen" @click="reopenPeriod(row.period)">{{ t('accounting.reopen') }}</AppButton>
        </template>
      </DataTable>
    </section>
  </div>
</template>
```

If `AppInput` does not forward `type` or `placeholder`, use a plain `<input v-model=… :data-test=…>` for those three fields rather than changing the shared component.

- [ ] **Step 6: Add the route and the nav entry**

In `apps/web/src/router/index.ts`, inside the `/app` children, after the `payments` line:

```ts
        { path: 'accounting', component: () => import('@/pages/AccountingPage.vue') },
```

In `apps/web/src/layouts/AppShell.vue`, add to the nav array after the `/app/payments` entry:

```ts
  { to: '/app/accounting', key: 'nav.accounting' },
```

- [ ] **Step 7: Run the web tests and watch them pass**

Run: `pnpm --filter @domar/web test -- AccountingPage LoginPage`
Expected: PASS — `AccountingPage` (6 cases) and the `mk and en define the same keys` case in `LoginPage.test.ts`, which is the check that catches a key added to one locale only.

- [ ] **Step 8: Typecheck, lint and commit**

```bash
pnpm typecheck
pnpm lint
git add apps/web/src/pages/AccountingPage.vue apps/web/src/router/index.ts apps/web/src/layouts/AppShell.vue apps/web/src/api/types.ts apps/web/src/i18n apps/web/test/AccountingPage.test.ts
git commit -m "feat(web): the accounting page — chart, trial balance, export and closes"
```

---

### Task 8: The end-to-end run

**Files:**
- Create: `e2e/tests/accounting.spec.ts`

**Interfaces:**
- Consumes everything above through the browser and the seeded API: `PUT /api/account-codes/:slot`, `GET /api/accounting/preview`, `POST /api/accounting/export`, `POST /api/accounting/periods/:period/close`, and the `data-test` hooks listed in Task 7.
- Produces: nothing other code imports.

- [ ] **Step 1: Write the spec**

Create `e2e/tests/accounting.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

const API = 'http://localhost:3001';
const slug = `e2e-acct-${Date.now().toString(36)}`;
const password = 'correct-horse-1';

test('a manager maps the chart, sees a balanced trial balance, exports the zip and closes the month', async ({ page }) => {
  await page.goto('/register');
  await page.getByTestId('orgName').fill('Е2Е Сметководство');
  await page.getByTestId('slug').fill(slug);
  await page.getByTestId('firstName').fill('Ана');
  await page.getByTestId('lastName').fill('Тест');
  await page.getByTestId('email').fill(`ana@${slug}.mk`);
  await page.getByTestId('password').fill(password);
  await page.getByRole('button', { name: /Отвори сметка|Create account/ }).click();
  await expect(page).toHaveURL(/\/app$/);

  const post = async (path: string, data: unknown = {}) => {
    const res = await page.request.post(`${API}${path}`, { data });
    expect(res.status(), `${path} → ${await res.text()}`).toBeLessThan(300);
    return res.json();
  };
  const taxRates = await (await page.request.get(`${API}/api/tax-rates`)).json();
  const vatId = taxRates.rows.find((r: { rateBp: number }) => r.rateBp === 1800).id;
  const owner = await post('/api/contacts', { firstName: 'Марко', lastName: 'Марков' });
  const building = await post('/api/buildings', { name: 'Вардарска 9', address: 'Вардарска 9', city: 'Скопје', postalCode: '1000' });
  await post(`/api/buildings/${building.id}/units`, { label: '1', kind: 'apartment', areaM2: 50, ownerContactId: owner.id });
  const service = await post('/api/services', { name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 100000, taxRateId: vatId, appliesTo: ['apartment'] });
  await post(`/api/buildings/${building.id}/services`, { serviceId: service.id, startsPeriod: '2026-01' });
  const period = await post(`/api/buildings/${building.id}/periods`, { period: '2026-09' });
  await post(`/api/buildings/${building.id}/periods/${period.id}/generate`);
  await post(`/api/buildings/${building.id}/periods/${period.id}/publish`);
  const invoices = await (await page.request.get(`${API}/api/invoices?buildingId=${building.id}`)).json();
  await post(`/api/invoices/${invoices.rows[0].id}/payments`, { amountMinor: 118000, method: 'bank', paidAt: new Date().toISOString() });

  // An unmapped chart is called out by name, and nothing can be exported yet.
  await page.goto('/app/accounting');
  await expect(page.getByTestId('accounting-missing')).toContainText('Побарувања од сопственици');
  await expect(page.getByTestId('accounting-missing')).toContainText('ДДВ на излез');

  const slots: [string, string, string][] = [
    ['owner_receivable', '1200', 'Побарувања'], ['revenue_service', '7400', 'Приходи од услуги'],
    ['revenue_management_fee', '7410', 'Приходи од управување'], ['revenue_reserve_fund', '7420', 'Резервен фонд'],
    ['vat_output', '4700', 'ДДВ на излез'], ['cash_regular', '1000', 'Редовна сметка'],
    ['cash_reserve', '1001', 'Резервна сметка'], ['expense_default', '4000', 'Трошоци'], ['opening_balance', '9000', 'Почетна состојба'],
  ];
  for (const [slot, code, name] of slots) {
    await page.getByTestId(`account-code-${slot}-code`).fill(code);
    await page.getByTestId(`account-code-${slot}-name`).fill(name);
    await page.getByTestId(`account-code-${slot}-save`).click();
  }
  await expect(page.getByTestId('accounting-complete')).toBeVisible();

  // The window the manager hands the accountant: a full year, so today's postings are inside it.
  await page.getByTestId('accounting-from').fill('2026-01-01');
  await page.getByTestId('accounting-to').fill('2027-01-01');
  await page.getByTestId('accounting-preview').click();
  await expect(page.getByTestId('accounting-balanced')).toBeVisible();
  await expect(page.getByTestId('accounting-total-debit')).toHaveText('2.360,00 ден.');
  await expect(page.getByTestId('accounting-total-credit')).toHaveText('2.360,00 ден.');
  await expect(page.getByTestId('trial-row')).toHaveCount(4);

  // The zip is filed as a document and the link the page shows really serves it.
  await page.getByTestId('accounting-export').click();
  await expect(page.getByTestId('accounting-exported')).toBeVisible();
  const href = await page.getByTestId('accounting-export-download').getAttribute('href');
  const zip = await page.request.get(href!);
  expect(zip.status()).toBe(200);
  expect(zip.headers()['content-type']).toBe('application/zip');
  expect((await zip.body()).byteLength).toBeGreaterThan(200);

  // Closing this month records it, and a later payment for it is still recordable — no new refusal.
  const thisMonth = new Date().toISOString().slice(0, 7);
  await page.getByTestId('accounting-period').fill(thisMonth);
  await page.getByTestId('accounting-close').click();
  await expect(page.getByTestId('accounting-period-row')).toHaveCount(1);
  const late = await page.request.post(`${API}/api/invoices/${invoices.rows[0].id}/payments`, {
    data: { amountMinor: 1000, method: 'cash', paidAt: new Date().toISOString() },
  });
  expect(late.status()).toBe(201);

  await page.getByTestId('accounting-reopen').click();
  await expect(page.getByTestId('accounting-period-row')).toHaveCount(0);
});
```

- [ ] **Step 2: Run it and watch it fail if anything above is incomplete**

Run: `pnpm e2e -- accounting`
Expected: PASS end to end. If `accounting-total-debit` disagrees, print the preview JSON (`await (await page.request.get(`${API}/api/accounting/preview?from=2026-01-01&to=2027-01-01`)).json()`) and fix the expectation to the real figure rather than loosening the assertion — the point of this test is that the number is exact.

- [ ] **Step 3: Run everything**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm e2e
```
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add e2e/tests/accounting.spec.ts
git commit -m "test(e2e): the accountant's monthly file, chart to zip to close"
```

---

## Self-review against the spec

| Spec | Where it lands |
|---|---|
| §3 chart of accounts, nine slots, unique per tenant | Task 1 (`account_codes`), Task 2 (`ACCOUNT_SLOTS`), Task 3 (`PUT /api/account-codes/:slot`) |
| §3 `suppliers.account_code_id` instead of a category taxonomy | Task 1 (column), Task 3 (validation), Task 2 + Task 4 (the expense account override) |
| §3 refuses to run while a slot is unmapped, naming every one | Task 2 `missingSlots`, Task 3 `requireChart` → 409 `chart_incomplete`, Task 4 and 5 tests, Task 7 `accounting-missing` |
| §4 the six derivations, line-kind mapping, integer minor units | Task 2 `buildJournal`, exhaustively tested without a database |
| §4 no rounding account; fail loudly instead of a plug | Task 2 `JournalError('unbalanced_entry')` with entry and difference |
| §5 `accounting_periods` with totals and `closed_by` | Task 1 (table), Task 6 (close/reopen, re-close rewrites) |
| §5 close adds no refusal anywhere | Task 6's `a payment into the closed period still records` case, the untouched API suite, and the e2e late payment |
| §5 prior-period adjustments with the real arrival date | Task 4's late-arrival selection (`booked_at` before the window, `created_at` inside it), Task 2's `adjustments`, Task 5's `korekcii.csv` |
| §6 zip of `;`-CSV with a BOM, `fflate`, stored as a document | Task 5, copying `resources/reports/export.ts`; downloaded through the existing `/api/documents/:id/download` |
| §6 the four files and their columns | Task 5 `buildAccountingExport`, asserted column by column in `accounting-export.test.ts` |
| §7 the six endpoints and their roles | Tasks 3–6 |
| §7 one Accounting page, `readonly` reads, red when unbalanced | Task 7 |
| §8 every invariant | Global Constraints above; the balance invariant is Task 2, tenant scoping and audit rows are Tasks 3–6, "reader only" is guaranteed by no import of `addPosting`/`addPostings` anywhere in `resources/accounting/` |

**Nothing in the spec is left without a task.** Two judgement calls the spec left open, resolved here and worth a reviewer's eye:

1. **Which late postings are adjustments.** The spec says a posting that lands in a closed period comes back in the next export. Task 4 implements the slightly wider and safer rule — `booked_at` **before** the window and `created_at` **inside** it — so a late posting for an *open* prior period is reported too rather than silently dropped. `korekcii.csv` carries a `затворен-период` column saying which of them fell in a period that had already been closed.
2. **What the trial balance covers.** It aggregates every entry in the file, journal and adjustments alike, since the accountant posts all of them; the README prints the two counts separately.
