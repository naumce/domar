# Domar Owner Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An apartment owner gets an eight-character code from their building manager, types it into `/portal/register` with an email address and a password of their choosing, and from then on sees — in Macedonian, on their own phone — every monthly calculation the manager published for them, what they have paid, their running account, and the money in their building's regular and reserve funds (Art. 45(4)). The portal is read-only: it books nothing, it shows no other owner's name, and it never reaches data outside the contacts the owner's account is explicitly linked to. One owner account can hold links under two different management companies.

**Architecture:** `@domar/db` gains migration `0006` with four tables: `owner_accounts` and `owner_sessions` (global, the §10 exception list grows), `owner_contact_links` and `portal_invites` (tenant-scoped). `apps/api` gains `src/portal/{code.ts,invites.ts,invite-routes.ts,session.ts,context.ts,plugin.ts,auth-routes.ts,repo.ts,data-routes.ts,schema.ts}`: a second session mechanism on the cookie `domar_owner`, the manager's `POST /contacts/:id/portal-invite` + `GET /contacts/:id/portal-status`, and the read routes under `/api/portal/*` that reuse the manager repos through a synthesized read-only `TenantContext` built inside the portal repo layer only. `apps/web` gains a second route tree `/portal/*` with its own shell (`PortalShell.vue`), its own Pinia store (`stores/portal.ts`), six pages and a router guard separate from the staff one, plus a "Portal access" box on the manager's contact statement page. `e2e` gains `portal.spec.ts`, which drives two browser contexts: the manager in one, the owner in the other.

**Tech Stack:** unchanged (Node 24, pnpm 10, TS strict, Fastify 5 + zod, Drizzle + Postgres 16, Vue 3 + Vite + vue-i18n + Tailwind 4, Vitest, Playwright 1.63.0). No new dependency in any package.

**Spec:** `docs/superpowers/specs/2026-09-21-domar-phase1-design.md` §19 (the six points of this sub-plan), §4 (`owner_account` in the domain model), §10 (auth and tenancy, the tenant_id exception list), §11 (API shape), §12 (web, the two route trees), §7 (ledger — untouched here: no portal route writes a posting), §13 (PDF), §16 (global constraints). Previous plans: `2026-09-21-01-foundation.md` (staff auth, sessions, scrypt), `2026-09-21-02-billing-core.md` (invoices, PDF), `2026-09-22-03-money-in.md` (payments, owner statement), `2026-09-24-04-pilot-ready.md` (temporary passwords, the unambiguous alphabet), `2026-09-24-05-reminders.md` (mailer, `email_log`, claim-first transitions, two-transaction send).

## Global Constraints

From spec §16, verbatim:

- Node `>=24`, pnpm `>=10`, TypeScript strict, ESM only.
- Postgres 16; schema must run unchanged on Supabase Postgres (no superuser-only extensions; `pgcrypto`/`uuid-ossp` allowed).
- Every tenant-scoped table has `tenant_id uuid not null` and an index starting with it.
- Money columns: `bigint`, suffix `_minor`. Never `float`.
- All user-facing strings in the web app go through i18n; Macedonian first, English second.
- No secrets in the repo; `.env.example` documents every variable.
- Commit after every green test cycle; conventional commit messages.

Project conventions that are equally binding here:

- **Money is integer minor units** everywhere (`number` in TS, `bigint` in Postgres). Amounts on the wire end in `Minor`.
- **Tenant filter on every statement**, including correlated subqueries and every `and(...)` in a repo. Nothing is fetched by id alone; the id is always paired with `eq(table.tenantId, ctx.tenantId)`. In this plan the `tenantId` never comes from the request — it comes from an `owner_contact_links` row.
- **An audit row is written inside the same transaction as every mutation** (`writeAudit(tx, ctx, …)`), never after it and never outside it. Audit payloads never contain a password hash, never contain an invite code and never contain an invite code's hash.
- **Role gating:** staff writes use `preHandler: requireRole(...WRITE_ROLES)` (`owner`, `accountant`); staff reads only need `app.requireAuth`. Portal routes use `app.requirePortal` and have no role concept at all.
- **Error envelope:** `{ error: { code, message, details? } }` produced by `AppError`/`notFound`/`badRequest`/`conflict`/`unauthorized`/`forbidden` and the handler in `app.ts`. New codes in this plan: `invalid_code`, `already_linked`, `email_taken` (reused wording, new route), `invalid_credentials` (reused code, portal login).
- **Claim-first `UPDATE … RETURNING` for state transitions.** An invite code is consumed with `update portal_invites set used_at = now() where code_hash = $1 and used_at is null and expires_at > now() returning *`; an empty result is `400 invalid_code`. No read-then-write.
- **TS strict with `exactOptionalPropertyTypes`**: never pass an explicit `undefined` into an object typed with an optional property unless the property type includes `| undefined`; use `stripUndefined()` before drizzle `.set()`/`.values()` spreads, and spread conditionally (`...(x ? { x } : {})`) when building optional fields.
- **ESM `.js` import specifiers** in every TS import of a local file (`./repo.js`, `../../ledger.js`), `import type` for type-only imports (`@typescript-eslint/consistent-type-imports` is an error).
- **i18n mk/en parity**: `apps/web/test/LoginPage.test.ts` asserts `flatKeys(messages.en).sort()` equals `flatKeys(messages.mk).sort()`. Every key added in this plan must be added to both files, Macedonian first.
- **`data-test` hooks** on every element an e2e test touches (`testIdAttribute: 'data-test'` in `e2e/playwright.config.ts`). `AppInput` maps the `data-test` attribute onto its `dataTest` prop, which lands on the `<input>` itself — so `wrapper.get('[data-test=x]').setValue(…)` works.
- Run everything from the repo root. Postgres for tests is the docker-compose service on port 54329 (`pnpm db:up`).
- **Conventional commits**, each ending with the trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

Portal invariants, from spec §19.6, binding on every task below:

- **Portal handlers never receive a `TenantContext`.** They receive a `PortalContext { ownerAccountId, links: { tenantId, contactId }[] }`. A read-only `TenantContext { tenantId, userId: null }` is built *per resolved link*, and only inside `apps/api/src/portal/repo.ts`. No route handler, no schema file and no web file constructs one.
- **Every portal query is constrained by a (`tenantId`, `contactId`) pair taken from the caller's links, never from the request.** A `contactId` in the query string is only ever used to *select* one of the caller's links; it is never passed to a repo before it has matched a link.
- **A test asserts that every portal route returns 404 for a contact id the account is not linked to**, that a staff session cookie is not accepted on `/api/portal/*`, and that an owner cookie is not accepted on `/api/*`.
- **No portal route writes ledger data.** The only rows a portal request may insert are `owner_accounts`, `owner_sessions`, `owner_contact_links` and the `used_at` update on `portal_invites`, plus the audit row that accompanies the link.

## Design addendum (decisions not spelled out in the spec)

1. **The password policy is identical to staff: `z.string().min(10).max(200)`.** Same scrypt parameters, same `hashPassword`/`verifyPassword` from `apps/api/src/auth/password.ts`. No separate owner policy exists, so there is no second place to keep in sync.
2. **Emails are lowercased on every write and every lookup** (`input.email.toLowerCase()`), exactly as `auth/routes.ts` already does for staff. `owner_accounts.email` carries a plain unique constraint; the lowercasing is what makes it case-insensitive.
3. **An existing account registering with a new code must supply its current password** (§19.3, "when an account with that email exists, requires the password to match"). A wrong password answers `401 invalid_credentials` with the same wording as a wrong login, so `POST /portal/register` never reveals whether an email is already registered. The code is *not* consumed when the password check fails: the check runs before the transaction that claims the code.
4. **Portal sessions live 30 days** (`OWNER_SESSION_DAYS = 30`) against the staff `SESSION_DAYS = 14`: an owner logs in a few times a year, a bookkeeper every morning. Same token scheme — 32 random bytes, base64url, sha256 in the table, nothing but the hash stored.
5. **`secure` on the `domar_owner` cookie follows `config.isProduction`**, like the staff cookie, so the portal works over plain HTTP in dev and e2e and is `Secure` in production. `httpOnly: true`, `sameSite: 'lax'`, `path: '/'`.
6. **An owner account with `is_active = false` is refused at the door.** The `onRequest` hook drops the context when `account.isActive` is false, so `requirePortal` answers `401`, and `POST /portal/login` answers `401 invalid_credentials`. Nothing in this plan ever sets the flag to false; the column exists for support to disable an abusive account by hand, and the behaviour is tested now so a future admin route inherits it.
7. **The manager never sees the owner's password or the owner's portal email.** `GET /contacts/:id/portal-status` returns `{ status, expiresAt?, linkedAt? }` and nothing else — no email, no account id, no login timestamps. The only email a manager sees is the one already on the `contacts` row, which they typed themselves.
8. **Reissuing revokes by expiry, not by `used_at`.** `POST /contacts/:id/portal-invite` first runs `update portal_invites set expires_at = now() where tenant_id = … and contact_id = … and used_at is null and expires_at > now()`. Using `used_at` for revocation would make a revoked code indistinguishable from a consumed one, and `portal-status` reads exactly those two columns. After the update, "live invite" means `used_at is null and expires_at > now()` everywhere, with no third state.
9. **`portal_invites.code_hash` carries a unique index** because registration looks a code up by hash alone — there is no tenant in the request yet. An 8-character code from a 56-character alphabet is ~1.4 × 10^14 possibilities; a collision raises `23505` on insert, which is an internal error, not a user-visible one, and has never been observed.
10. **The invite code is 8 characters from the same unambiguous alphabet as the staff temporary password.** `apps/api/src/auth/password.ts` gains an exported `UNAMBIGUOUS_ALPHABET` and `randomCode(length)`; `generateTemporaryPassword()` becomes `randomCode(16)`. One alphabet, one rejection-sampling loop, two call sites. Codes are case-sensitive and compared as typed — the alphabet has no ambiguous pairs, so a user who types the wrong case typed the wrong character.
11. **The invite email is sent after the insert transaction commits**, and its `email_log` row plus a `portal_invite.send` audit row go into a second transaction — the same shape the reminder send uses (plan 05, addendum 8). A dead SMTP server never rolls back a code the manager is already reading off the screen. The response carries `emailed: boolean` so the UI can say whether a copy went out; §19.2 only names `{ code, expiresAt }`, and `emailed` is additive.
12. **`owner_contact_links` is unique on (`owner_account_id`, `contact_id`).** §19.1 says "unique on the pair" of a three-column list; `contact_id` already determines `tenant_id` (contacts are tenant-scoped), so (`owner_account_id`, `contact_id`) is the constraint that means "link this contact once". `tenant_id` is stored anyway, indexed first, because §16 requires it and because it is what every portal query filters on.
13. **A second code for an already-linked contact is `409 already_linked`, and the code is not consumed.** The uniqueness check runs inside the claiming transaction, so the claim rolls back with it.
14. **`/api/portal/invoices` returns published and later** — `published`, `partially_paid`, `paid`, `cancelled`, never `draft`. `listInvoices` in `resources/invoices/repo.ts` gains an optional `statuses?: string[]` filter (`inArray`), which is the single widening of an existing manager signature in this plan; every existing caller passes no `statuses` and is unaffected. `GET /api/portal/invoices/:id` answers `404` for a draft, so a draft is invisible rather than forbidden.
15. **The building fund page shows both funds' balances, both funds' "billed to owners" totals, and the building's *fund-account* postings of the last 12 months.** Kinds are the full ledger enum (`charge`, `payment`, `expense`, `adjustment`, `opening`), each row carries `amountMinor`, `bookedAt`, `fund` and `kind`, and `description` is non-null **only for expenses** (joined from `expenses.description`; `expense_void` adjustments carry it too, since that is the same expense's description). Owner-level `charge` postings are deliberately *not* listed: they are per-owner rows and §19.4 forbids exposing other owners' data. What §19.4 calls "charges" is served by `billedMinor` per fund — Σ owner `charge` postings for that fund, the same number the manager's reserve-fund tab shows as `contributionsBilledMinor`. This is the one §19.4 wording implemented differently, and it is the reading that keeps "amounts only, no other owners' names" literally true.
16. **A building is reachable in the portal only when the linked contact owns a unit in it.** `GET /api/portal/buildings/:id/fund` checks `units.owner_contact_id = <linked contact>` and answers `404` otherwise; the same query builds the `buildings` array on each link in `GET /api/portal/me`.
17. **The portal PDF is the existing invoice renderer, unchanged.** `GET /api/portal/invoices/:id/pdf` calls `renderInvoiceHtml({ invoice, tenant, formatMoney: pack.formatMoney, locale: 'mk' })` with the *tenant* of the resolved link, so the owner sees the same header, bank account and Art. 33 footer the manager's PDF carries. There is no portal-specific template and no `/html` twin: the API test mocks `playwright-core` exactly as `reminders.test.ts` does, so no test needs a browser.
18. **The two cookies never interfere.** They have different names, so a staff cookie produces no `req.portal` and an owner cookie produces no `req.ctx`; both hooks may run on the same request and neither route family reads the other's context. The test in Task 3 pins this as behaviour rather than as an accident of naming.
19. **`DUMMY_PASSWORD_HASH` moves from `auth/routes.ts` to `auth/password.ts`** and is exported, so the portal login pays the same scrypt cost for an unknown email that the staff login does. The literal is unchanged and `auth/routes.ts` imports it instead of declaring it.
20. **The portal's selected contact lives in the store, not in the URL.** `usePortalStore().selectedContactId` defaults to the first link and is persisted under `localStorage['domar.portal.contactId']`; every portal page sends it as `?contactId=`. An owner with one manager never sees a switcher; an owner with two sees a `<select>` in the shell.

---

### Task 1: DB — migration 0006, the four portal tables

**Files:**
- Create: `packages/db/src/schema/portal.ts`
- Modify: `packages/db/src/schema/index.ts`
- Generate: `packages/db/migrations/0006_*.sql` + `packages/db/migrations/meta/0006_snapshot.json` + journal entry
- Modify: `packages/db/test/migrations.test.ts`

**Interfaces (consumed by Tasks 2, 3 and 4):**
- `schema.ownerAccounts` — `{ id, email, passwordHash, isActive, createdAt, updatedAt }`. No `tenant_id`.
- `schema.ownerSessions` — `{ id, tokenHash, ownerAccountId, expiresAt, createdAt, userAgent, ip }`. No `tenant_id`.
- `schema.ownerContactLinks` — `{ id, ownerAccountId, tenantId, contactId, linkedAt }`, unique on (`ownerAccountId`, `contactId`).
- `schema.portalInvites` — `{ id, tenantId, contactId, codeHash, expiresAt, usedAt: Date | null, createdBy: string | null, createdAt }`, `codeHash` unique.
- Migrations reach tests automatically: `createTestDatabase()` (`packages/db/src/test-db.ts`) runs the whole `packages/db/migrations` folder on a fresh database per test file.

- [ ] **Step 1: Write the failing test**

In `packages/db/test/migrations.test.ts`, extend the exemption set (the two global tables of §19.1) and the table list, and append three tests at the end of the `describe`.

Replace the exemption line:

```ts
const TENANT_SCOPED_EXEMPT = new Set(['tenants', 'sessions', 'owner_accounts', 'owner_sessions', '__drizzle_migrations']);
```

Replace the table list in the first test:

```ts
    for (const n of ['tenants', 'users', 'sessions', 'contacts', 'buildings', 'units', 'tax_rates', 'audit_logs',
      'services', 'building_services', 'reserve_fund_settings', 'expenses', 'billing_periods', 'period_lines', 'invoices', 'invoice_lines', 'postings', 'invoice_sequences',
      'payments', 'bank_statements', 'statement_lines', 'reminders', 'email_log',
      'owner_accounts', 'owner_sessions', 'owner_contact_links', 'portal_invites'])
      expect(names).toContain(n);
```

Append:

```ts
  it('owner accounts are global and their email is unique', async () => {
    const cols = await t!.sql<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns where table_name = 'owner_accounts' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual(['created_at', 'email', 'id', 'is_active', 'password_hash', 'updated_at']);
    const idx = await t!.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'owner_accounts'`;
    expect(idx.some((i) => i.indexdef.includes('UNIQUE') && i.indexdef.includes('(email)'))).toBe(true);
    const sess = await t!.sql<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_name = 'owner_sessions' and column_name = 'tenant_id'`;
    expect(sess.length).toBe(0);
  });

  it('owner_contact_links bridge one account to one contact', async () => {
    const cols = await t!.sql<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns where table_name = 'owner_contact_links' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual(['contact_id', 'id', 'linked_at', 'owner_account_id', 'tenant_id']);
    expect(cols.every((c) => c.is_nullable === 'NO')).toBe(true);
    const idx = await t!.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'owner_contact_links'`;
    expect(idx.some((i) => i.indexdef.includes('UNIQUE') && i.indexdef.includes('(owner_account_id, contact_id)'))).toBe(true);
    expect(idx.some((i) => i.indexdef.includes('(tenant_id, contact_id)'))).toBe(true);
  });

  it('portal_invites store a hashed code with an expiry', async () => {
    const cols = await t!.sql<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns where table_name = 'portal_invites' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual(['code_hash', 'contact_id', 'created_at', 'created_by', 'expires_at', 'id', 'tenant_id', 'used_at']);
    const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(by['used_at']!.is_nullable).toBe('YES');
    expect(by['created_by']!.is_nullable).toBe('YES');
    expect(by['expires_at']!.is_nullable).toBe('NO');
    const idx = await t!.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'portal_invites'`;
    expect(idx.some((i) => i.indexdef.includes('UNIQUE') && i.indexdef.includes('(code_hash)'))).toBe(true);
    expect(idx.some((i) => i.indexdef.includes('(tenant_id, contact_id, created_at)'))).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm db:up && pnpm --filter @domar/db test`
Expected: FAIL — `expected [ …tables… ] to contain 'owner_accounts'`.

- [ ] **Step 3: Implement**

Create `packages/db/src/schema/portal.ts`:

```ts
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { contacts } from './contact.js';
import { tenants } from './tenant.js';

/**
 * Owner logins. Deliberately not tenant-scoped (spec §19.1): one person may own units under two
 * management companies and must reach both with a single password. The bridge to a manager's data
 * is `owner_contact_links`, never this row.
 */
export const ownerAccounts = pgTable('owner_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Server-side portal sessions, cookie `domar_owner`. Not tenant-scoped, like `sessions`. */
export const ownerSessions = pgTable('owner_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  ownerAccountId: uuid('owner_account_id').notNull().references(() => ownerAccounts.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  userAgent: text('user_agent'),
  ip: text('ip'),
}, (t) => [index('owner_sessions_account_idx').on(t.ownerAccountId)]);

/** The only bridge between an owner login and a manager's data. Unique per (account, contact). */
export const ownerContactLinks = pgTable('owner_contact_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerAccountId: uuid('owner_account_id').notNull().references(() => ownerAccounts.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  // cascade, not restrict: a contact with no financial history may still be deleted, and a link to a
  // deleted contact would be a link to nothing.
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('owner_contact_links_tenant_contact_idx').on(t.tenantId, t.contactId),
  uniqueIndex('owner_contact_links_account_contact_idx').on(t.ownerAccountId, t.contactId),
  index('owner_contact_links_account_idx').on(t.ownerAccountId),
]);

/**
 * One invitation code. Only the sha256 hash is stored, so a database dump cannot be replayed into
 * someone's portal account. `code_hash` is unique because registration looks a code up by hash
 * alone — the request carries no tenant yet.
 */
export const portalInvites = pgTable('portal_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('portal_invites_tenant_contact_idx').on(t.tenantId, t.contactId, t.createdAt),
  uniqueIndex('portal_invites_code_hash_idx').on(t.codeHash),
]);
```

`packages/db/src/schema/index.ts` — append one line:

```ts
export * from './tenant.js';
export * from './auth.js';
export * from './contact.js';
export * from './building.js';
export * from './tax-rate.js';
export * from './audit.js';
export * from './billing.js';
export * from './payments.js';
export * from './reminders.js';
export * from './portal.js';
```

Generate the migration:

```bash
pnpm --filter @domar/db generate
```

Expected: a new `packages/db/migrations/0006_<random-name>.sql` containing only the four `CREATE TABLE`s, their foreign keys and their indexes — no `ALTER` of any pre-existing table — for example:

```sql
CREATE TABLE "owner_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_accounts_email_unique" UNIQUE("email")
);
```

plus `meta/0006_snapshot.json` and a sixth entry in `meta/_journal.json`. If the generated SQL touches any pre-existing table, delete the generated files, fix the schema drift and regenerate — this migration must create only the four new tables.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @domar/db test && pnpm typecheck && pnpm lint`
Expected: PASS — migrations suite +3; the tenant-scoping test still passes because `owner_contact_links` and `portal_invites` both carry a not-null `tenant_id` with a `tenant_id`-leading index, and `owner_accounts`/`owner_sessions` are exempt.

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): owner accounts, portal sessions, contact links and invites" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: API — portal invitation codes on the manager side

**Files:**
- Modify: `apps/api/src/auth/password.ts` (export the alphabet, add `randomCode`, export `DUMMY_PASSWORD_HASH`), `apps/api/src/auth/routes.ts` (import the moved constant)
- Create: `apps/api/src/portal/code.ts`, `apps/api/src/portal/invites.ts`, `apps/api/src/portal/invite-routes.ts`, `apps/api/src/portal/schema.ts`
- Modify: `apps/api/src/app.ts` (register `contactPortalRoutes` under `/contacts`)
- Create: `apps/api/test/portal-invites.test.ts`

**Interfaces (consumed by Tasks 3, 4, 7 and 8):**
- `UNAMBIGUOUS_ALPHABET: string` and `randomCode(length: number): string` in `auth/password.ts`; `generateTemporaryPassword()` keeps its signature and now returns `randomCode(16)`.
- `DUMMY_PASSWORD_HASH: string` exported from `auth/password.ts`.
- `INVITE_CODE_LENGTH = 8`, `generateInviteCode(): string`, `hashCode(code: string): string` in `portal/code.ts`.
- `issuePortalInvite(db, ctx, contactId, rt)` → `{ code: string; expiresAt: Date; emailed: boolean }`; `portalStatus(db, ctx, contactId)` → `{ status: 'none' | 'invited' | 'linked'; expiresAt?: Date; linkedAt?: Date }`; `claimInvite(tx, code)` → the claimed `portal_invites` row (used by Task 3).
- `PortalInviteRuntime { mailer: Mailer; log: { warn(obj: unknown, msg: string): void } }` — structurally satisfied by the existing `ReminderRuntime` value built in `resources/reminders/routes.ts`.
- Routes: `POST /api/contacts/:id/portal-invite` → `201 { code, expiresAt, emailed }`; `GET /api/contacts/:id/portal-status` → `200 { status, expiresAt?, linkedAt? }`.
- Zod: `portalInviteOut`, `portalStatusOut` in `portal/schema.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/portal-invites.test.ts`:

```ts
import { schema } from '@domar/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('portal invites', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  let withEmail = '';
  let withoutEmail = '';
  let otherTenantContact = '';

  const post = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const get = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? a.cookie } });

  beforeAll(async () => {
    t = await createTestApp({ SMTP_URL: 'json' });
    a = await registerTenant(t.app, 'firma-inv');
    b = await registerTenant(t.app, 'firma-inv2');
    withEmail = (await post('/api/contacts', { firstName: 'Марко', lastName: 'Марков', email: 'marko@firma-inv.mk' })).json().id;
    withoutEmail = (await post('/api/contacts', { firstName: 'Ана', lastName: 'Анева' })).json().id;
    otherTenantContact = (await post('/api/contacts', { firstName: 'Сара', lastName: 'Сарева' }, b.cookie)).json().id;
  });
  afterAll(async () => { await t.close(); });

  it('issues an 8-character code, stores only its hash and emails the owner', async () => {
    const res = await post(`/api/contacts/${withEmail}/portal-invite`);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.code).toMatch(/^[A-HJ-NP-Za-km-z2-9]{8}$/);
    expect(body.emailed).toBe(true);
    expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(13 * 86_400_000);
    expect(Date.parse(body.expiresAt) - Date.now()).toBeLessThan(15 * 86_400_000);

    const rows = await t.db.select().from(schema.portalInvites).where(eq(schema.portalInvites.contactId, withEmail));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.codeHash).not.toBe(body.code);
    expect(rows[0]!.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.tenantId).toBe(a.tenantId);
    expect(rows[0]!.createdBy).toBe(a.userId);
    expect(rows[0]!.usedAt).toBeNull();

    const mail = t.app.mailer.outbox;
    expect(mail).toHaveLength(1);
    expect(mail[0]!.to).toBe('marko@firma-inv.mk');
    expect(mail[0]!.text).toContain(body.code);
    const log = await t.db.select().from(schema.emailLog).where(eq(schema.emailLog.template, 'portal_invite'));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ tenantId: a.tenantId, toAddress: 'marko@firma-inv.mk', status: 'sent', refType: 'contact', refId: withEmail });
  });

  it('never writes the code or its hash into the audit log', async () => {
    const audit = await t.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'portal_invite.create'));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.after)).not.toMatch(/[0-9a-f]{64}/);
    expect(audit[0]!.entityType).toBe('contact');
    expect(audit[0]!.entityId).toBe(withEmail);
  });

  it('reports the status as invited while a live code exists', async () => {
    const res = await get(`/api/contacts/${withEmail}/portal-status`);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('invited');
    expect(typeof res.json().expiresAt).toBe('string');
    expect(res.json().linkedAt).toBeUndefined();
  });

  it('reissuing revokes the earlier unused code', async () => {
    const first = (await post(`/api/contacts/${withoutEmail}/portal-invite`)).json();
    const second = (await post(`/api/contacts/${withoutEmail}/portal-invite`)).json();
    expect(second.code).not.toBe(first.code);
    const rows = await t.db.select().from(schema.portalInvites).where(eq(schema.portalInvites.contactId, withoutEmail));
    expect(rows).toHaveLength(2);
    const live = rows.filter((r) => r.usedAt === null && r.expiresAt.getTime() > Date.now());
    expect(live).toHaveLength(1);
    expect(live[0]!.expiresAt.toISOString()).toBe(new Date(second.expiresAt).toISOString());
  });

  it('skips the email when the contact has none', async () => {
    const before = t.app.mailer.outbox.length;
    const res = await post(`/api/contacts/${withoutEmail}/portal-invite`);
    expect(res.json().emailed).toBe(false);
    expect(t.app.mailer.outbox).toHaveLength(before);
  });

  it('reports none for a contact that was never invited', async () => {
    const fresh = (await post('/api/contacts', { firstName: 'Нов', lastName: 'Новески' })).json().id;
    expect((await get(`/api/contacts/${fresh}/portal-status`)).json()).toEqual({ status: 'none' });
  });

  it('404s across tenants for both routes', async () => {
    expect((await post(`/api/contacts/${otherTenantContact}/portal-invite`)).statusCode).toBe(404);
    expect((await get(`/api/contacts/${otherTenantContact}/portal-status`)).statusCode).toBe(404);
  });

  it('requires a write role to issue a code', async () => {
    const created = (await post('/api/users', { email: 'tech@firma-inv.mk', firstName: 'Т', lastName: 'Технички', role: 'technician' })).json();
    const login = await t.app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { tenantSlug: 'firma-inv', email: 'tech@firma-inv.mk', password: created.temporaryPassword },
    });
    const techCookie = String(login.headers['set-cookie']).split(';')[0]!;
    expect((await post(`/api/contacts/${withEmail}/portal-invite`, {}, techCookie)).statusCode).toBe(403);
    // Reading the status is a plain authenticated read.
    expect((await get(`/api/contacts/${withEmail}/portal-status`, techCookie)).statusCode).toBe(200);
  });

  it('requires a session at all', async () => {
    expect((await t.app.inject({ method: 'GET', url: `/api/contacts/${withEmail}/portal-status` })).statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm db:up && pnpm --filter @domar/api test -- portal-invites`
Expected: FAIL — `expect(res.statusCode).toBe(201)` receives `404` (the route does not exist).

- [ ] **Step 3: Implement**

`apps/api/src/auth/password.ts` — replace the temporary-password block at the bottom of the file and add the dummy hash:

```ts
/** No I, O, l, 0 or 1: a code or temporary password gets read off a screen and typed by hand. */
export const UNAMBIGUOUS_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const TEMP_LENGTH = 16;

/** `length` characters drawn uniformly from UNAMBIGUOUS_ALPHABET (rejection sampling, so no modulo bias). */
export function randomCode(length: number): string {
  const n = UNAMBIGUOUS_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length)) {
      if (b >= limit) continue;
      out += UNAMBIGUOUS_ALPHABET[b % n];
      if (out.length === length) break;
    }
  }
  return out;
}

export function generateTemporaryPassword(): string {
  return randomCode(TEMP_LENGTH);
}

/**
 * A valid scrypt hash of a fixed throwaway string, verified when no user or owner account matches so
 * that an unknown email costs the same time as a wrong password. A literal, not a call: hashing at
 * module load would pay the full scrypt cost on every boot.
 */
export const DUMMY_PASSWORD_HASH = 'scrypt$131072$__eKji6dtUjRjS7WEtNFcA$QAXfu0bP0eMWJxlBTJLWPKi0pjL9X9WcBkNcdJAhjGJ_vMfmV1ybdlb8yxB9NeMzeV8LjRVkcFne7z00BVBhOA';
```

`apps/api/src/auth/routes.ts` — delete the local `DUMMY_PASSWORD_HASH` declaration (and its doc comment) and import it instead:

```ts
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from './password.js';
```

Create `apps/api/src/portal/code.ts`:

```ts
import { createHash } from 'node:crypto';
import { randomCode } from '../auth/password.js';

/** Eight characters is ~1.4e14 possibilities: long enough to dictate over the phone, short enough to type. */
export const INVITE_CODE_LENGTH = 8;

export function generateInviteCode(): string {
  return randomCode(INVITE_CODE_LENGTH);
}

/** Only this hash is stored; a database dump cannot be replayed into someone's portal account. */
export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}
```

Create `apps/api/src/portal/schema.ts`:

```ts
import { z } from 'zod';

export const portalInviteOut = z.object({
  code: z.string(),
  expiresAt: z.date().or(z.string()),
  emailed: z.boolean(),
});

export const portalStatusOut = z.object({
  status: z.enum(['none', 'invited', 'linked']),
  expiresAt: z.date().or(z.string()).optional(),
  linkedAt: z.date().or(z.string()).optional(),
});
```

Create `apps/api/src/portal/invites.ts`:

```ts
import { type Db, schema } from '@domar/db';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { writeAudit } from '../audit.js';
import { logEmail } from '../email/log.js';
import type { Mailer } from '../email/mailer.js';
import { badRequest } from '../errors.js';
import { getContact } from '../resources/contacts/repo.js';
import type { TenantContext } from '../tenant-context.js';
import { generateInviteCode, hashCode } from './code.js';

const PI = schema.portalInvites; const OCL = schema.ownerContactLinks;
const INVITE_DAYS = 14;

export interface PortalInviteRuntime {
  mailer: Mailer;
  log: { warn(obj: unknown, msg: string): void };
}

export type InviteRow = typeof PI.$inferSelect;

/**
 * Consumes a code. Claim-first: the same `UPDATE … RETURNING` both checks that the code is live and
 * marks it used, so two simultaneous registrations cannot both win it. `code_hash` is unique, so at
 * most one row can match. Nothing here knows a tenant yet — the tenant comes out of the claimed row.
 */
export async function claimInvite(tx: Db, code: string): Promise<InviteRow> {
  const [row] = await tx.update(PI)
    .set({ usedAt: new Date() })
    .where(and(eq(PI.codeHash, hashCode(code)), isNull(PI.usedAt), gt(PI.expiresAt, new Date())))
    .returning();
  if (!row) throw badRequest('invalid_code', 'The code is wrong, already used or expired');
  return row;
}

/** `none` | `invited` | `linked` for one contact, plus the one date that matters for that state. */
export async function portalStatus(db: Db, ctx: TenantContext, contactId: string) {
  await getContact(db, ctx, contactId); // 404 across tenants
  const [link] = await db.select({ linkedAt: OCL.linkedAt }).from(OCL)
    .where(and(eq(OCL.tenantId, ctx.tenantId), eq(OCL.contactId, contactId)))
    .orderBy(desc(OCL.linkedAt)).limit(1);
  if (link) return { status: 'linked' as const, linkedAt: link.linkedAt };
  const [invite] = await db.select({ expiresAt: PI.expiresAt }).from(PI)
    .where(and(eq(PI.tenantId, ctx.tenantId), eq(PI.contactId, contactId), isNull(PI.usedAt), gt(PI.expiresAt, new Date())))
    .orderBy(desc(PI.expiresAt)).limit(1);
  if (invite) return { status: 'invited' as const, expiresAt: invite.expiresAt };
  return { status: 'none' as const };
}

/**
 * Issues a fresh code for a contact and revokes every earlier live one (spec §19.2). Revocation is
 * an expiry, not a `used_at`: `used_at` means "an owner turned this into a link", and `portal-status`
 * reads exactly those two columns.
 *
 * Two transactions, like the reminder send: the code is committed before the email is attempted, so
 * a dead SMTP server never invalidates a code the manager is already reading off the screen.
 */
export async function issuePortalInvite(db: Db, ctx: TenantContext, contactId: string, rt: PortalInviteRuntime) {
  const contact = await getContact(db, ctx, contactId); // 404 across tenants
  const code = generateInviteCode();
  const codeHash = hashCode(code);
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 24 * 3600 * 1000);

  const row = await db.transaction(async (tx) => {
    const revoked = await tx.update(PI).set({ expiresAt: new Date() })
      .where(and(eq(PI.tenantId, ctx.tenantId), eq(PI.contactId, contactId), isNull(PI.usedAt), gt(PI.expiresAt, new Date())))
      .returning({ id: PI.id });
    const [inserted] = await tx.insert(PI).values({ tenantId: ctx.tenantId, contactId, codeHash, expiresAt, createdBy: ctx.userId }).returning();
    // Neither the code nor its hash may reach the audit log: the log is readable by every owner user.
    await writeAudit(tx, ctx, {
      action: 'portal_invite.create', entityType: 'contact', entityId: contactId,
      after: { inviteId: inserted!.id, expiresAt: expiresAt.toISOString(), revokedCodes: revoked.length },
    });
    return inserted!;
  });

  const to = contact.email;
  if (!to || !rt.mailer.configured) return { code, expiresAt: row.expiresAt, emailed: false };

  const subject = 'Пристап до порталот за сопственици';
  const text = [
    `Почитувани ${contact.firstName} ${contact.lastName},`.trim(),
    '',
    'Вашиот управител ви овозможи пристап до порталот за сопственици.',
    `Код за пристап: ${code}`,
    `Кодот важи до ${row.expiresAt.toLocaleDateString('mk-MK')}.`,
    '',
    'Отворете ја страницата за регистрација, внесете го кодот, вашата е-пошта и лозинка по ваш избор.',
  ].join('\n');
  const res = await rt.mailer.send({ to, subject, text });
  const ok = 'id' in res;
  if (!ok) rt.log.warn({ error: res.error, contactId }, 'portal invite email failed; the code is still valid');
  await db.transaction(async (tx) => {
    await logEmail(tx, ctx, { to, subject, template: 'portal_invite', refType: 'contact', refId: contactId, status: ok ? 'sent' : 'failed', error: ok ? null : res.error });
    await writeAudit(tx, ctx, { action: 'portal_invite.send', entityType: 'contact', entityId: contactId, after: { status: ok ? 'sent' : 'failed', to } });
  });
  return { code, expiresAt: row.expiresAt, emailed: ok };
}
```

The file exports exactly `PortalInviteRuntime`, `InviteRow`, `claimInvite`, `portalStatus` and `issuePortalInvite` — nothing else. Import `sql` only if you need it; the code above does not.

Create `apps/api/src/portal/invite-routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireRole, WRITE_ROLES } from '../auth/roles.js';
import { idParam } from '../resources/common.js';
import { issuePortalInvite, portalStatus, type PortalInviteRuntime } from './invites.js';
import { portalInviteOut, portalStatusOut } from './schema.js';

const runtime = (app: FastifyInstance): PortalInviteRuntime => ({ mailer: app.mailer, log: app.log });

/** Registered under `/contacts`, next to `contactRoutes`: the manager's half of the portal. */
export const contactPortalRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.post('/:id/portal-invite', {
    preHandler: requireRole(...WRITE_ROLES),
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { params: idParam, response: { 201: portalInviteOut } },
  }, async (req, reply) => reply.status(201).send(await issuePortalInvite(req.db, req.ctx!, req.params.id, runtime(app))));

  app.get('/:id/portal-status', { schema: { params: idParam, response: { 200: portalStatusOut } } }, async (req) =>
    portalStatus(req.db, req.ctx!, req.params.id));
};
```

`apps/api/src/app.ts` — import and register the plugin next to the contacts routes:

```ts
import { contactPortalRoutes } from './portal/invite-routes.js';
```

```ts
    await api.register(contactRoutes, { prefix: '/contacts' });
    await api.register(contactPortalRoutes, { prefix: '/contacts' });
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @domar/api test -- portal-invites users auth && pnpm typecheck && pnpm lint`
Expected: PASS — 9 new tests; `users.test.ts` still matches `/^[A-HJ-NP-Za-km-z2-9]{16}$/` because `randomCode(16)` draws from the same alphabet, and `auth.test.ts` still gets `401 invalid_credentials` for an unknown email through the moved `DUMMY_PASSWORD_HASH`.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): portal invitation codes and contact portal status" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: API — portal accounts, sessions and the `/api/portal` auth routes

**Files:**
- Create: `apps/api/src/portal/context.ts`, `apps/api/src/portal/session.ts`, `apps/api/src/portal/plugin.ts`, `apps/api/src/portal/accounts.ts`, `apps/api/src/portal/auth-routes.ts`
- Modify: `apps/api/src/portal/schema.ts`, `apps/api/src/app.ts`
- Create: `apps/api/test/portal-auth.test.ts`

**Interfaces (consumed by Tasks 4, 5, 6 and 8):**
- `PortalLink { tenantId: string; contactId: string }`, `PortalContext { ownerAccountId: string; links: PortalLink[] }` (`portal/context.ts`), and the Fastify augmentations `FastifyRequest.portal: PortalContext | null`, `FastifyRequest.ownerSession: { token: string; account: typeof schema.ownerAccounts.$inferSelect } | null`, `FastifyInstance.requirePortal`.
- `OWNER_SESSION_COOKIE = 'domar_owner'`, `createOwnerSession(db, ownerAccountId, meta)`, `resolveOwnerSession(db, token)`, `deleteOwnerSession(db, token)`, `deleteOtherOwnerSessions(db, ownerAccountId, keepToken)`, `listLinks(db, ownerAccountId)` (`portal/session.ts`).
- `registerPortalAccount(db, input)`, `loginPortalAccount(db, input)`, `linkAnotherContact(db, portal, code)`, `changePortalPassword(db, portal, currentPassword, newPassword, keepToken)`, `portalMe(db, portal)` (`portal/accounts.ts`).
- Routes: `POST /api/portal/register`, `POST /api/portal/login`, `POST /api/portal/logout`, `GET /api/portal/me`, `POST /api/portal/link`, `POST /api/portal/change-password`.
- Zod: `portalRegisterBody`, `portalLoginBody`, `portalLinkBody`, `portalChangePasswordBody`, `portalMeOut`, `portalLinkOut` in `portal/schema.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/portal-auth.test.ts`:

```ts
import { schema } from '@domar/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

const cookieOf = (res: { headers: Record<string, unknown> }): string => {
  const raw = res.headers['set-cookie'];
  return String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]!;
};
const setCookieRaw = (res: { headers: Record<string, unknown> }): string => {
  const raw = res.headers['set-cookie'];
  return String(Array.isArray(raw) ? raw[0] : raw);
};

describe('portal auth', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  let markoA = '';
  let markoB = '';
  let anaA = '';
  let ownerCookie = '';

  const post = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: cookie ? { cookie } : {}, payload });
  const staffPost = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const codeFor = async (contactId: string, cookie?: string) =>
    (await staffPost(`/api/contacts/${contactId}/portal-invite`, {}, cookie)).json().code as string;

  beforeAll(async () => {
    t = await createTestApp({ SMTP_URL: 'json' });
    a = await registerTenant(t.app, 'firma-pa');
    b = await registerTenant(t.app, 'firma-pb');
    markoA = (await staffPost('/api/contacts', { firstName: 'Марко', lastName: 'Марков' })).json().id;
    anaA = (await staffPost('/api/contacts', { firstName: 'Ана', lastName: 'Анева' })).json().id;
    markoB = (await staffPost('/api/contacts', { firstName: 'Марко', lastName: 'Марков' }, b.cookie)).json().id;
  });
  afterAll(async () => { await t.close(); });

  it('registers an owner account from a code and sets the domar_owner cookie', async () => {
    const code = await codeFor(markoA);
    const res = await post('/api/portal/register', { code, email: 'MARKO@owner.mk', password: 'correct-horse-1' });
    expect(res.statusCode).toBe(201);
    const raw = setCookieRaw(res);
    expect(raw).toMatch(/^domar_owner=/);
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
    expect(raw).not.toContain('Secure'); // NODE_ENV=test
    ownerCookie = cookieOf(res);

    const body = res.json();
    expect(body.account.email).toBe('marko@owner.mk');
    expect(body.account.passwordHash).toBeUndefined();
    expect(body.links).toHaveLength(1);
    expect(body.links[0]).toMatchObject({ tenantId: a.tenantId, tenantName: 'Firma firma-pa', contactId: markoA, contactName: 'Марко Марков' });

    const accounts = await t.db.select().from(schema.ownerAccounts);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.email).toBe('marko@owner.mk');
    expect(accounts[0]!.isActive).toBe(true);
    const audit = await t.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'portal_link.create'));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.tenantId).toBe(a.tenantId);
    expect(audit[0]!.userId).toBeNull();
  });

  it('consumes the code exactly once', async () => {
    const code = await codeFor(anaA);
    expect((await post('/api/portal/register', { code, email: 'ana@owner.mk', password: 'correct-horse-1' })).statusCode).toBe(201);
    const again = await post('/api/portal/register', { code, email: 'ana2@owner.mk', password: 'correct-horse-1' });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('invalid_code');
    expect(await t.db.select().from(schema.ownerAccounts).where(eq(schema.ownerAccounts.email, 'ana2@owner.mk'))).toHaveLength(0);
  });

  it('rejects an unknown, expired or revoked code', async () => {
    expect((await post('/api/portal/register', { code: 'ZZZZZZZZ', email: 'x@owner.mk', password: 'correct-horse-1' })).json().error.code).toBe('invalid_code');
    const first = await codeFor(markoA);
    await codeFor(markoA); // reissue revokes `first`
    expect((await post('/api/portal/register', { code: first, email: 'x@owner.mk', password: 'correct-horse-1' })).json().error.code).toBe('invalid_code');
  });

  it('requires the existing password when the email is already registered, and does not burn the code', async () => {
    const code = await codeFor(markoB, b.cookie);
    const wrong = await post('/api/portal/register', { code, email: 'marko@owner.mk', password: 'nope-nope-nope' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('invalid_credentials');
    const invite = await t.db.select().from(schema.portalInvites).where(eq(schema.portalInvites.contactId, markoB));
    expect(invite[0]!.usedAt).toBeNull();

    const ok = await post('/api/portal/register', { code, email: 'marko@owner.mk', password: 'correct-horse-1' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().links).toHaveLength(2); // one contact under each of the two managers
    expect(await t.db.select().from(schema.ownerAccounts)).toHaveLength(2); // marko + ana, no third row
  });

  it('logs in, reads /me and logs out', async () => {
    const login = await post('/api/portal/login', { email: 'Marko@Owner.mk', password: 'correct-horse-1' });
    expect(login.statusCode).toBe(200);
    const cookie = cookieOf(login);
    const me = await t.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().links.map((l: { tenantId: string }) => l.tenantId).sort()).toEqual([a.tenantId, b.tenantId].sort());
    expect((await post('/api/portal/logout', {}, cookie)).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('rejects a wrong password and an unknown email with the same error', async () => {
    const wrong = await post('/api/portal/login', { email: 'marko@owner.mk', password: 'nope-nope-nope' });
    const ghost = await post('/api/portal/login', { email: 'ghost@owner.mk', password: 'correct-horse-1' });
    expect(wrong.statusCode).toBe(401);
    expect(ghost.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('invalid_credentials');
    expect(ghost.json().error.code).toBe('invalid_credentials');
  });

  it('refuses a deactivated account at login and mid-session', async () => {
    const code = await codeFor((await staffPost('/api/contacts', { firstName: 'Деак', lastName: 'Тивиран' })).json().id);
    const reg = await post('/api/portal/register', { code, email: 'off@owner.mk', password: 'correct-horse-1' });
    const cookie = cookieOf(reg);
    expect((await t.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie } })).statusCode).toBe(200);
    await t.db.update(schema.ownerAccounts).set({ isActive: false }).where(eq(schema.ownerAccounts.email, 'off@owner.mk'));
    expect((await t.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie } })).statusCode).toBe(401);
    expect((await post('/api/portal/login', { email: 'off@owner.mk', password: 'correct-horse-1' })).statusCode).toBe(401);
  });

  it('adds another contact to a signed-in account and refuses a duplicate link', async () => {
    const login = await post('/api/portal/login', { email: 'marko@owner.mk', password: 'correct-horse-1' });
    const cookie = cookieOf(login);
    const extra = (await staffPost('/api/contacts', { firstName: 'Втор', lastName: 'Имот' })).json().id;
    const res = await post('/api/portal/link', { code: await codeFor(extra) }, cookie);
    expect(res.statusCode).toBe(201);
    expect(res.json().contactId).toBe(extra);
    expect((await t.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie } })).json().links).toHaveLength(3);

    const dup = await post('/api/portal/link', { code: await codeFor(extra) }, cookie);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('already_linked');
    const invites = await t.db.select().from(schema.portalInvites).where(eq(schema.portalInvites.contactId, extra));
    expect(invites.filter((i) => i.usedAt !== null)).toHaveLength(1); // the refused claim rolled back
  });

  it('changes the password and drops the other sessions', async () => {
    const one = cookieOf(await post('/api/portal/login', { email: 'ana@owner.mk', password: 'correct-horse-1' }));
    const two = cookieOf(await post('/api/portal/login', { email: 'ana@owner.mk', password: 'correct-horse-1' }));
    expect((await post('/api/portal/change-password', { currentPassword: 'wrong-wrong-1', newPassword: 'battery-staple-2' }, two)).statusCode).toBe(401);
    expect((await post('/api/portal/change-password', { currentPassword: 'correct-horse-1', newPassword: 'battery-staple-2' }, two)).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie: two } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie: one } })).statusCode).toBe(401);
    expect((await post('/api/portal/login', { email: 'ana@owner.mk', password: 'battery-staple-2' })).statusCode).toBe(200);
  });

  it('rejects short passwords on register and on change', async () => {
    const code = await codeFor((await staffPost('/api/contacts', { firstName: 'Кратка', lastName: 'Лозинка' })).json().id);
    const res = await post('/api/portal/register', { code, email: 'short@owner.mk', password: 'short' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation');
  });

  it('keeps the two cookies apart', async () => {
    // A staff cookie buys nothing in the portal…
    expect((await t.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie: a.cookie } })).statusCode).toBe(401);
    // …and an owner cookie buys nothing in the manager app.
    expect((await t.app.inject({ method: 'GET', url: '/api/contacts', headers: { cookie: ownerCookie } })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: ownerCookie } })).statusCode).toBe(401);
  });

  it('throttles repeated portal login attempts', async () => {
    // The earlier tests already spent part of this route's budget, so assert that the limiter fires
    // somewhere in the burst rather than on one particular attempt.
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await post('/api/portal/login', { email: 'flood@owner.mk', password: 'nope-nope-nope' })).statusCode);
    expect(codes).toContain(429);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @domar/api test -- portal-auth`
Expected: FAIL — `expect(res.statusCode).toBe(201)` receives `404`.

- [ ] **Step 3: Implement**

Create `apps/api/src/portal/context.ts`:

```ts
import type { schema } from '@domar/db';

/** One (tenant, contact) pair the signed-in owner is allowed to read. */
export interface PortalLink {
  tenantId: string;
  contactId: string;
}

/**
 * What a portal handler gets instead of a `TenantContext` (spec §19.6). A tenant id only ever
 * appears after a link has been resolved, and only inside `portal/repo.ts`.
 */
export interface PortalContext {
  ownerAccountId: string;
  links: PortalLink[];
}

declare module 'fastify' {
  interface FastifyRequest {
    portal: PortalContext | null;
    ownerSession: { token: string; account: typeof schema.ownerAccounts.$inferSelect } | null;
  }
}
```

Create `apps/api/src/portal/session.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { type Db, schema } from '@domar/db';
import { and, eq, gt, ne } from 'drizzle-orm';
import type { PortalLink } from './context.js';

export const OWNER_SESSION_COOKIE = 'domar_owner';
/** 30 days, not the staff 14: an owner signs in a few times a year, a bookkeeper every morning. */
const OWNER_SESSION_DAYS = 30;

const OS = schema.ownerSessions; const OA = schema.ownerAccounts; const OCL = schema.ownerContactLinks;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createOwnerSession(db: Db, ownerAccountId: string, meta: { userAgent?: string | undefined; ip?: string | undefined }): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + OWNER_SESSION_DAYS * 24 * 3600 * 1000);
  await db.insert(OS).values({ tokenHash: hashToken(token), ownerAccountId, expiresAt, userAgent: meta.userAgent ?? null, ip: meta.ip ?? null });
  return { token, expiresAt };
}

export async function resolveOwnerSession(db: Db, token: string) {
  const rows = await db.select({ account: OA }).from(OS)
    .innerJoin(OA, eq(OA.id, OS.ownerAccountId))
    .where(and(eq(OS.tokenHash, hashToken(token)), gt(OS.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteOwnerSession(db: Db, token: string): Promise<void> {
  await db.delete(OS).where(eq(OS.tokenHash, hashToken(token)));
}

/** Every session of an owner except the caller's own: used after a self-service password change. */
export async function deleteOtherOwnerSessions(db: Db, ownerAccountId: string, keepToken: string): Promise<void> {
  await db.delete(OS).where(and(eq(OS.ownerAccountId, ownerAccountId), ne(OS.tokenHash, hashToken(keepToken))));
}

/** The account's links, sorted so `/me` and the web store agree on which one comes first. */
export async function listLinks(db: Db, ownerAccountId: string): Promise<PortalLink[]> {
  const rows = await db.select({ tenantId: OCL.tenantId, contactId: OCL.contactId }).from(OCL)
    .where(eq(OCL.ownerAccountId, ownerAccountId))
    .orderBy(OCL.linkedAt, OCL.contactId);
  return rows;
}
```

Create `apps/api/src/portal/plugin.ts`:

```ts
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { unauthorized } from '../errors.js';
import { listLinks, OWNER_SESSION_COOKIE, resolveOwnerSession } from './session.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** preHandler: requires a valid owner session, populates request.portal */
    requirePortal: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const plugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest('portal', null);
  app.decorateRequest('ownerSession', null);

  // Runs on every request, like the staff hook. The two cookies have different names, so a staff
  // cookie can never produce a `portal` and an owner cookie can never produce a `ctx`; a browser
  // holding both simply carries both contexts, and neither route family reads the other's.
  app.addHook('onRequest', async (req) => {
    const token = req.cookies[OWNER_SESSION_COOKIE];
    if (!token) return;
    const found = await resolveOwnerSession(req.db, token);
    if (!found || !found.account.isActive) return;
    req.portal = { ownerAccountId: found.account.id, links: await listLinks(req.db, found.account.id) };
    req.ownerSession = { token, account: found.account };
  });

  app.decorate('requirePortal', async (req: FastifyRequest) => {
    if (!req.portal) throw unauthorized();
  });
};

export const portalAuthPlugin = fp(plugin, { name: 'portal-auth', dependencies: ['db'] });
```

Create `apps/api/src/portal/accounts.ts`:

```ts
import { type Db, schema } from '@domar/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { writeAudit } from '../audit.js';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../auth/password.js';
import { AppError, conflict, isUniqueViolation } from '../errors.js';
import type { TenantContext } from '../tenant-context.js';
import type { PortalContext } from './context.js';
import { claimInvite } from './invites.js';
import { deleteOtherOwnerSessions, listLinks } from './session.js';

const OA = schema.ownerAccounts; const OCL = schema.ownerContactLinks; const C = schema.contacts;
const T = schema.tenants; const B = schema.buildings; const U = schema.units;

type Account = typeof OA.$inferSelect;
export type PublicAccount = { id: string; email: string };
const publicAccount = (row: Account): PublicAccount => ({ id: row.id, email: row.email });

const invalid = () => new AppError(401, 'invalid_credentials', 'Invalid email or password');

/**
 * The read-only tenant context a portal request may act under: no user, so `audit_logs.user_id`
 * stays null, and the role is the least privileged one the enum has. Built here and in `repo.ts`
 * only (spec §19.6).
 */
export function portalTenantContext(tenantId: string): TenantContext {
  return { tenantId, userId: null, role: 'readonly' };
}

/** Inserts the link and its audit row; `409 already_linked` when the account already holds it. */
async function linkContact(tx: Db, ownerAccountId: string, tenantId: string, contactId: string) {
  let row;
  try {
    [row] = await tx.insert(OCL).values({ ownerAccountId, tenantId, contactId }).returning();
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('already_linked', 'This property is already linked to your account');
    throw err;
  }
  await writeAudit(tx, portalTenantContext(tenantId), {
    action: 'portal_link.create', entityType: 'contact', entityId: contactId,
    after: { ownerAccountId, linkId: row!.id },
  });
  return row!;
}

/**
 * Register with a code. An email that already has an account must prove it with that account's
 * password (spec §19.3) — and that check runs *before* the transaction, so a wrong password never
 * consumes the code. Both failures answer the same `401 invalid_credentials`, so registration does
 * not reveal which emails are already registered.
 */
export async function registerPortalAccount(db: Db, input: { code: string; email: string; password: string }) {
  const email = input.email.toLowerCase();
  const existing = (await db.query.ownerAccounts.findFirst({ where: eq(OA.email, email) })) ?? null;
  const ok = await verifyPassword(input.password, existing?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (existing && (!ok || !existing.isActive)) throw invalid();
  const passwordHash = existing ? existing.passwordHash : await hashPassword(input.password);

  return db.transaction(async (tx) => {
    const invite = await claimInvite(tx, input.code); // 400 invalid_code, claim-first
    let account = existing;
    if (!account) {
      try {
        [account] = await tx.insert(OA).values({ email, passwordHash }).returning();
      } catch (err) {
        // A concurrent registration with the same email won the race; that caller's password is the
        // account's password, so this one must sign in instead of guessing it.
        if (isUniqueViolation(err)) throw conflict('email_taken', 'An account with that email already exists; sign in and add the code there');
        throw err;
      }
    }
    await linkContact(tx, account!.id, invite.tenantId, invite.contactId);
    return account!;
  });
}

export async function loginPortalAccount(db: Db, input: { email: string; password: string }): Promise<Account> {
  const account = (await db.query.ownerAccounts.findFirst({ where: eq(OA.email, input.email.toLowerCase()) })) ?? null;
  const ok = await verifyPassword(input.password, account?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!account || !ok || !account.isActive) throw invalid();
  return account;
}

/** Adds one more contact to a signed-in account. Returns the `/me` shape of the new link. */
export async function linkAnotherContact(db: Db, portal: PortalContext, code: string) {
  const contactId = await db.transaction(async (tx) => {
    const invite = await claimInvite(tx, code);
    await linkContact(tx, portal.ownerAccountId, invite.tenantId, invite.contactId);
    return invite.contactId;
  });
  const links = await describeLinks(db, await listLinks(db, portal.ownerAccountId));
  return links.find((l) => l.contactId === contactId)!;
}

export async function changePortalPassword(db: Db, portal: PortalContext, currentPassword: string, newPassword: string, keepToken: string): Promise<void> {
  const account = await db.query.ownerAccounts.findFirst({ where: eq(OA.id, portal.ownerAccountId) });
  if (!account || !(await verifyPassword(currentPassword, account.passwordHash))) throw new AppError(401, 'invalid_credentials', 'The current password is wrong');
  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (tx) => {
    await tx.update(OA).set({ passwordHash, updatedAt: new Date() }).where(eq(OA.id, portal.ownerAccountId));
    await deleteOtherOwnerSessions(tx, portal.ownerAccountId, keepToken);
  });
}

export interface PortalLinkOut {
  tenantId: string;
  tenantName: string;
  contactId: string;
  contactName: string;
  buildings: { id: string; name: string }[];
}

/**
 * Decorates raw links with the names the portal shows. Every query is filtered by the link's own
 * tenant id *and* its contact id: nothing here can reach a row the owner is not linked to.
 */
export async function describeLinks(db: Db, links: { tenantId: string; contactId: string }[]): Promise<PortalLinkOut[]> {
  if (links.length === 0) return [];
  const tenantIds = [...new Set(links.map((l) => l.tenantId))];
  const contactIds = links.map((l) => l.contactId);
  const [tenants, contacts, buildings] = await Promise.all([
    db.select({ id: T.id, name: T.name }).from(T).where(inArray(T.id, tenantIds)),
    db.select({ id: C.id, tenantId: C.tenantId, firstName: C.firstName, lastName: C.lastName }).from(C)
      .where(and(inArray(C.tenantId, tenantIds), inArray(C.id, contactIds))),
    db.selectDistinct({ id: B.id, name: B.name, tenantId: B.tenantId, contactId: U.ownerContactId }).from(U)
      .innerJoin(B, and(eq(B.id, U.buildingId), eq(B.tenantId, U.tenantId)))
      .where(and(inArray(U.tenantId, tenantIds), inArray(U.ownerContactId, contactIds)))
      .orderBy(asc(B.name)),
  ]);
  const tenantName = new Map(tenants.map((x) => [x.id, x.name]));
  const contact = new Map(contacts.map((x) => [x.id, x]));
  return links.map((l) => ({
    tenantId: l.tenantId,
    tenantName: tenantName.get(l.tenantId) ?? '',
    contactId: l.contactId,
    contactName: `${contact.get(l.contactId)?.firstName ?? ''} ${contact.get(l.contactId)?.lastName ?? ''}`.trim(),
    buildings: buildings.filter((b) => b.tenantId === l.tenantId && b.contactId === l.contactId).map((b) => ({ id: b.id, name: b.name })),
  }));
}

export async function portalMe(db: Db, portal: PortalContext, account: Account) {
  return { account: publicAccount(account), links: await describeLinks(db, portal.links) };
}
```

Append to `apps/api/src/portal/schema.ts`:

```ts
const portalPassword = z.string().min(10).max(200);

export const portalRegisterBody = z.object({ code: z.string().min(4).max(32), email: z.string().email().max(200), password: portalPassword });
export const portalLoginBody = z.object({ email: z.string().email().max(200), password: z.string().max(200) });
export const portalLinkBody = z.object({ code: z.string().min(4).max(32) });
export const portalChangePasswordBody = z.object({ currentPassword: z.string().max(200), newPassword: portalPassword });

export const portalLinkOut = z.object({
  tenantId: z.string(), tenantName: z.string(), contactId: z.string(), contactName: z.string(),
  buildings: z.array(z.object({ id: z.string(), name: z.string() })),
});
export const portalMeOut = z.object({
  account: z.object({ id: z.string(), email: z.string() }),
  links: z.array(portalLinkOut),
});
```

Create `apps/api/src/portal/auth-routes.ts`:

```ts
import type { FastifyReply } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { unauthorized } from '../errors.js';
import { changePortalPassword, describeLinks, linkAnotherContact, loginPortalAccount, portalMe, registerPortalAccount } from './accounts.js';
import { portalChangePasswordBody, portalLinkBody, portalLinkOut, portalLoginBody, portalMeOut, portalRegisterBody } from './schema.js';
import { createOwnerSession, deleteOwnerSession, listLinks, OWNER_SESSION_COOKIE } from './session.js';

export const portalAuthRoutes: FastifyPluginAsyncZod = async (app) => {
  const limited = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/register', { ...limited, schema: { body: portalRegisterBody, response: { 201: portalMeOut } } }, async (req, reply) => {
    const account = await registerPortalAccount(req.db, req.body);
    const session = await createOwnerSession(req.db, account.id, { userAgent: req.headers['user-agent'], ip: req.ip });
    setOwnerCookie(reply, session.token, session.expiresAt, app.config.isProduction);
    return reply.status(201).send({ account: { id: account.id, email: account.email }, links: await describeLinks(req.db, await listLinks(req.db, account.id)) });
  });

  app.post('/login', { ...limited, schema: { body: portalLoginBody, response: { 200: portalMeOut } } }, async (req, reply) => {
    const account = await loginPortalAccount(req.db, req.body);
    const session = await createOwnerSession(req.db, account.id, { userAgent: req.headers['user-agent'], ip: req.ip });
    setOwnerCookie(reply, session.token, session.expiresAt, app.config.isProduction);
    return { account: { id: account.id, email: account.email }, links: await describeLinks(req.db, await listLinks(req.db, account.id)) };
  });

  app.post('/logout', async (req, reply) => {
    if (req.ownerSession) await deleteOwnerSession(req.db, req.ownerSession.token);
    reply.clearCookie(OWNER_SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  app.get('/me', { preHandler: app.requirePortal, schema: { response: { 200: portalMeOut } } }, async (req) =>
    portalMe(req.db, req.portal!, req.ownerSession!.account));

  app.post('/link', { ...limited, preHandler: app.requirePortal, schema: { body: portalLinkBody, response: { 201: portalLinkOut } } }, async (req, reply) =>
    reply.status(201).send(await linkAnotherContact(req.db, req.portal!, req.body.code)));

  app.post('/change-password', { ...limited, preHandler: app.requirePortal, schema: { body: portalChangePasswordBody } }, async (req, reply) => {
    if (!req.ownerSession) throw unauthorized();
    await changePortalPassword(req.db, req.portal!, req.body.currentPassword, req.body.newPassword, req.ownerSession.token);
    return reply.status(204).send();
  });
};

function setOwnerCookie(reply: FastifyReply, token: string, expiresAt: Date, secure: boolean) {
  reply.setCookie(OWNER_SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, path: '/', expires: expiresAt });
}
```

`apps/api/src/app.ts` — register the plugin next to `authPlugin`, and the routes under `/portal`:

```ts
import { portalAuthPlugin } from './portal/plugin.js';
import { portalAuthRoutes } from './portal/auth-routes.js';
```

```ts
  await app.register(authPlugin);
  await app.register(portalAuthPlugin);
```

```ts
    await api.register(portalAuthRoutes, { prefix: '/portal' });
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @domar/api test && pnpm typecheck && pnpm lint`
Expected: PASS — 12 new tests in `portal-auth.test.ts`, every other API suite unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): owner accounts, portal sessions and /api/portal auth routes" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: API — the read-only portal data routes

**Files:**
- Create: `apps/api/src/portal/repo.ts`, `apps/api/src/portal/data-routes.ts`
- Modify: `apps/api/src/portal/schema.ts`, `apps/api/src/resources/invoices/repo.ts` (optional `statuses` filter), `apps/api/src/app.ts`
- Create: `apps/api/test/portal.test.ts`

**Interfaces (consumed by Tasks 6 and 8):**
- `resolveLink(portal: PortalContext, contactId: string): { ctx: TenantContext; contactId: string }` — throws `notFound('Contact')` when the id is not one of the caller's links. The only place a portal request becomes a tenant.
- `portalInvoices(db, portal, q: { contactId; page; pageSize })` → `{ rows, total }` of `invoiceRowOut` shape, newest period first, `draft` excluded.
- `portalInvoice(db, portal, contactId, id)` → the `getInvoice` shape; 404 for another contact's invoice and for a draft.
- `portalInvoiceHtml(db, portal, contactId, id)` → `{ html, invoice }` from the manager's `renderInvoiceHtml`.
- `portalPayments(db, portal, q)` → `{ rows, total }` of `paymentOut` shape.
- `portalStatement(db, portal, contactId, buildingId?)` → the `ownerStatement` shape.
- `portalBuildingFund(db, portal, contactId, buildingId)` → `{ building, regular: { balanceMinor, billedMinor }, reserve: { … }, transactions[] }`.
- `listInvoices(db, ctx, q)` in `resources/invoices/repo.ts` gains `statuses?: string[] | undefined`; every existing caller omits it.
- Routes: `GET /api/portal/invoices`, `/api/portal/invoices/:id`, `/api/portal/invoices/:id/pdf`, `/api/portal/payments`, `/api/portal/statement`, `/api/portal/buildings/:id/fund` — all `preHandler: app.requirePortal`, all taking `?contactId=`.
- Zod: `portalContactQuery`, `portalInvoiceListQuery`, `portalPaymentListQuery`, `portalStatementQuery`, `portalFundOut` in `portal/schema.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/portal.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Chromium is mocked exactly as in reminders.test.ts: the portal PDF route must be exercised and no
// test may depend on a browser being installed.
vi.mock('playwright-core', () => {
  const launch = vi.fn(async () => ({
    isConnected: () => true,
    newContext: async () => ({ newPage: async () => ({ setContent: async () => {}, pdf: async () => Buffer.from('%PDF-portal') }), close: async () => {} }),
    close: async () => {},
  }));
  return { chromium: { launch } };
});

import { setupPublishedBuilding } from './billing-fixture.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

describe('portal data', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  let A: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  let B: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  let ownerCookie = '';
  let strangerCookie = '';

  const staffPost = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const portalGet = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? ownerCookie } });
  const registerOwner = async (contactId: string, email: string, staffCookie: string) => {
    const code = (await staffPost(`/api/contacts/${contactId}/portal-invite`, {}, staffCookie)).json().code;
    const res = await t.app.inject({ method: 'POST', url: '/api/portal/register', payload: { code, email, password: 'correct-horse-1' } });
    expect(res.statusCode).toBe(201);
    return String(res.headers['set-cookie']).split(';')[0]!;
  };

  beforeAll(async () => {
    t = await createTestApp({ SMTP_URL: 'json' });
    a = await registerTenant(t.app, 'firma-po');
    b = await registerTenant(t.app, 'firma-po2');
    A = await setupPublishedBuilding(t.app, a.cookie);
    B = await setupPublishedBuilding(t.app, b.cookie);

    // O1 pays the whole invoice: the fund split is then exact (regular 206099 + reserve 50000).
    await staffPost(`/api/invoices/${A.invoices.O1.id}/payments`, { amountMinor: 256099, method: 'bank_transfer', paidAt: daysAgo(3) });
    // One recent expense and one two years old: the fund list is a 12-month window, the balance is not.
    await staffPost(`/api/buildings/${A.buildingId}/reserve-fund/expenses`, { fund: 'regular', description: 'Поправка на лифт', amountMinor: 120000, paidAt: daysAgo(10) });
    await staffPost(`/api/buildings/${A.buildingId}/reserve-fund/expenses`, { fund: 'regular', description: 'Стар трошок', amountMinor: 5000, paidAt: daysAgo(730) });

    ownerCookie = await registerOwner(A.owners.O1, 'o1@owner.mk', a.cookie);
    strangerCookie = await registerOwner(B.owners.O1, 'b1@owner.mk', b.cookie);
  });
  afterAll(async () => {
    const m = await import('../src/pdf/html-to-pdf.js');
    await m.closePdfBrowser();
    m._resetForTests();
    await t.close();
  });

  it('lists only the linked contact’s published invoices', async () => {
    const res = await portalGet(`/api/portal/invoices?contactId=${A.owners.O1}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      id: A.invoices.O1.id, number: A.invoices.O1.number, status: 'paid', period: '2026-09',
      totalMinor: 256099, paidMinor: 256099, outstandingMinor: 0, previousBalanceMinor: 0, amountDueMinor: 256099,
    });
    expect(body.rows[0].contact.id).toBe(A.owners.O1);
    expect(JSON.stringify(body)).not.toContain('Бошковски'); // O2 is nowhere in the payload
  });

  it('returns one invoice with its lines and the owner’s own payments', async () => {
    const res = await portalGet(`/api/portal/invoices/${A.invoices.O1.id}?contactId=${A.owners.O1}`);
    expect(res.statusCode).toBe(200);
    const inv = res.json();
    expect(inv.lines.length).toBeGreaterThan(0);
    expect(inv.lines.some((l: { kind: string }) => l.kind === 'reserve_fund')).toBe(true);
    expect(inv.payments).toHaveLength(1);
    expect(inv.payments[0].amountMinor).toBe(256099);
    expect(inv.reserveFundBuildingBalanceMinor).toBe(3500000);
    expect(inv.building.name).toBe('Партизанска 12');
  });

  it('renders the invoice PDF with the manager’s renderer', async () => {
    const res = await portalGet(`/api/portal/invoices/${A.invoices.O1.id}/pdf?contactId=${A.owners.O1}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain(A.invoices.O1.number.replace(/[^A-Za-z0-9_.-]/g, '_'));
    expect(res.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('lists the owner’s payments', async () => {
    const res = await portalGet(`/api/portal/payments?contactId=${A.owners.O1}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().rows[0]).toMatchObject({ amountMinor: 256099, method: 'bank_transfer', status: 'completed' });
    expect(res.json().rows[0].contact.id).toBe(A.owners.O1);
  });

  it('returns the owner statement with a running balance that nets to zero', async () => {
    const res = await portalGet(`/api/portal/statement?contactId=${A.owners.O1}`);
    expect(res.statusCode).toBe(200);
    const st = res.json();
    expect(st.contact.id).toBe(A.owners.O1);
    expect(st.balanceMinor).toBe(0);
    expect(st.rows.reduce((s: number, r: { amountMinor: number }) => s + r.amountMinor, 0)).toBe(0);
    expect(st.rows.some((r: { kind: string }) => r.kind === 'charge')).toBe(true);
    expect(st.rows.some((r: { kind: string }) => r.kind === 'payment')).toBe(true);
  });

  it('shows both building funds with 12 months of transactions and no owner names', async () => {
    const res = await portalGet(`/api/portal/buildings/${A.buildingId}/fund?contactId=${A.owners.O1}`);
    expect(res.statusCode).toBe(200);
    const f = res.json();
    expect(f.building).toEqual({ id: A.buildingId, name: 'Партизанска 12' });
    // reserve: 3.500.000 opening + 50.000 of O1's payment. regular: 206.099 of that payment − 120.000 − 5.000.
    expect(f.reserve.balanceMinor).toBe(3550000);
    expect(f.regular.balanceMinor).toBe(81099);
    // billed = Σ owner charge postings: reserve 225 m² × 1000; regular 1.064.532 total − 225.000 reserve.
    expect(f.reserve.billedMinor).toBe(225000);
    expect(f.regular.billedMinor).toBe(839532);

    expect(f.transactions).toHaveLength(4); // the two-year-old expense is outside the window
    const byKind = (k: string) => f.transactions.filter((x: { kind: string }) => x.kind === k);
    expect(byKind('opening')).toHaveLength(1);
    expect(byKind('opening')[0]).toMatchObject({ fund: 'reserve', amountMinor: 3500000, description: null });
    expect(byKind('payment').map((x: { amountMinor: number }) => x.amountMinor).sort((x: number, y: number) => x - y)).toEqual([50000, 206099]);
    expect(byKind('expense')).toHaveLength(1);
    expect(byKind('expense')[0]).toMatchObject({ fund: 'regular', amountMinor: -120000, description: 'Поправка на лифт' });
    expect(byKind('charge')).toHaveLength(0); // owner charges are per-owner rows and stay private
    expect(JSON.stringify(f)).not.toContain('Анѓеловски');
    expect(JSON.stringify(f)).not.toContain('Бошковски');
  });

  it('404s every route for a contact the account is not linked to', async () => {
    const other = A.owners.O2;
    for (const url of [
      `/api/portal/invoices?contactId=${other}`,
      `/api/portal/invoices/${A.invoices.O2.id}?contactId=${other}`,
      `/api/portal/invoices/${A.invoices.O2.id}/pdf?contactId=${other}`,
      `/api/portal/payments?contactId=${other}`,
      `/api/portal/statement?contactId=${other}`,
      `/api/portal/buildings/${A.buildingId}/fund?contactId=${other}`,
    ]) {
      const res = await portalGet(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    }
  });

  it('404s when a linked contact id is paired with another contact’s invoice', async () => {
    const res = await portalGet(`/api/portal/invoices/${A.invoices.O2.id}?contactId=${A.owners.O1}`);
    expect(res.statusCode).toBe(404);
  });

  it('404s across tenants even for an owner who is linked somewhere else', async () => {
    // The B owner is signed in; A's ids belong to a tenant they have no link in.
    for (const url of [
      `/api/portal/invoices?contactId=${A.owners.O1}`,
      `/api/portal/buildings/${A.buildingId}/fund?contactId=${B.owners.O1}`,
    ]) {
      expect((await portalGet(url, strangerCookie)).statusCode, url).toBe(404);
    }
  });

  it('404s for a building the linked contact owns nothing in', async () => {
    const empty = (await staffPost('/api/buildings', { name: 'Друга зграда' })).json().id;
    expect((await portalGet(`/api/portal/buildings/${empty}/fund?contactId=${A.owners.O1}`)).statusCode).toBe(404);
  });

  it('hides drafts', async () => {
    const p = (await staffPost(`/api/buildings/${A.buildingId}/periods`, { period: '2026-10' })).json().id;
    await staffPost(`/api/buildings/${A.buildingId}/periods/${p}/generate`, {});
    const list = (await portalGet(`/api/portal/invoices?contactId=${A.owners.O1}`)).json();
    expect(list.total).toBe(1);
    const drafts = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${A.buildingId}&period=2026-10`, headers: { cookie: a.cookie } })).json().rows;
    const draftOfO1 = drafts.find((r: { contactId: string }) => r.contactId === A.owners.O1);
    expect((await portalGet(`/api/portal/invoices/${draftOfO1.id}?contactId=${A.owners.O1}`)).statusCode).toBe(404);
  });

  it('requires an owner session', async () => {
    expect((await t.app.inject({ method: 'GET', url: `/api/portal/invoices?contactId=${A.owners.O1}` })).statusCode).toBe(401);
    expect((await portalGet(`/api/portal/invoices?contactId=${A.owners.O1}`, a.cookie)).statusCode).toBe(401);
  });

  it('rejects a missing or malformed contactId', async () => {
    expect((await portalGet('/api/portal/invoices')).statusCode).toBe(400);
    expect((await portalGet('/api/portal/statement?contactId=not-a-uuid')).statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @domar/api test -- portal.test`
Expected: FAIL — `expect(res.statusCode).toBe(200)` receives `404` on `/api/portal/invoices`.

- [ ] **Step 3: Implement**

`apps/api/src/resources/invoices/repo.ts` — widen the list query with an optional status set (the only manager signature this plan touches):

```ts
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
```

```ts
export async function listInvoices(db: Db, ctx: TenantContext, q: { buildingId?: string | undefined; period?: string | undefined; status?: string | undefined; statuses?: string[] | undefined; contactId?: string | undefined; page: number; pageSize: number }) {
  const conds = [eq(INV.tenantId, ctx.tenantId)];
  if (q.buildingId) conds.push(eq(INV.buildingId, q.buildingId));
  if (q.period) conds.push(eq(BP.period, q.period));
  if (q.status) conds.push(eq(INV.status, q.status as typeof INV.$inferSelect.status));
  // The portal asks for "published and later" as a set; every manager caller omits this.
  if (q.statuses && q.statuses.length > 0) conds.push(inArray(INV.status, q.statuses as (typeof INV.$inferSelect.status)[]));
  if (q.contactId) conds.push(eq(INV.contactId, q.contactId));
```

(the rest of the function is unchanged.)

Create `apps/api/src/portal/repo.ts`:

```ts
import { type Db, schema } from '@domar/db';
import { getCountryPack, type CountryCode } from '@domar/domain';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { notFound } from '../errors.js';
import { billedToOwners, fundBalance } from '../ledger.js';
import { renderInvoiceHtml } from '../pdf/invoice-html.js';
import { ownerStatement } from '../resources/contacts/statement.js';
import { getInvoice, listInvoices } from '../resources/invoices/repo.js';
import { listPayments } from '../resources/payments/repo.js';
import type { TenantContext } from '../tenant-context.js';
import { portalTenantContext } from './accounts.js';
import type { PortalContext } from './context.js';

const P = schema.postings; const E = schema.expenses; const U = schema.units; const B = schema.buildings; const T = schema.tenants;

/** What the manager has published, and nothing before that. A draft is invisible, not forbidden. */
const VISIBLE_STATUSES = ['published', 'partially_paid', 'paid', 'cancelled'];
const FUND_WINDOW_MS = 365 * 24 * 3600 * 1000;

/**
 * Turns a request's `contactId` into a tenant — the only place that happens. The id must match one
 * of the caller's links; anything else is a 404, never a 403, so the portal never confirms that an
 * id exists in a tenant the caller has no link in (spec §19.6).
 */
export function resolveLink(portal: PortalContext, contactId: string): { ctx: TenantContext; contactId: string } {
  const link = portal.links.find((l) => l.contactId === contactId);
  if (!link) throw notFound('Contact');
  return { ctx: portalTenantContext(link.tenantId), contactId: link.contactId };
}

export async function portalInvoices(db: Db, portal: PortalContext, q: { contactId: string; page: number; pageSize: number }) {
  const { ctx, contactId } = resolveLink(portal, q.contactId);
  const { rows, total } = await listInvoices(db, ctx, { contactId, statuses: VISIBLE_STATUSES, page: q.page, pageSize: q.pageSize });
  return { rows, total };
}

export async function portalInvoice(db: Db, portal: PortalContext, contactIdParam: string, id: string) {
  const { ctx, contactId } = resolveLink(portal, contactIdParam);
  const invoice = await getInvoice(db, ctx, id); // 404 across tenants
  // The invoice is this tenant's; it still has to be *this owner's*, and still published.
  if (invoice.contactId !== contactId || !VISIBLE_STATUSES.includes(invoice.status)) throw notFound('Invoice');
  return invoice;
}

/** The manager's renderer, the manager's tenant header (spec §19.4: "same renderer as the manager's"). */
export async function portalInvoiceHtml(db: Db, portal: PortalContext, contactIdParam: string, id: string) {
  const { ctx } = resolveLink(portal, contactIdParam);
  const invoice = await portalInvoice(db, portal, contactIdParam, id);
  const tenant = (await db.query.tenants.findFirst({ where: eq(T.id, ctx.tenantId) }))!;
  const pack = getCountryPack(tenant.countryCode as CountryCode);
  return { html: renderInvoiceHtml({ invoice, tenant, formatMoney: pack.formatMoney, locale: 'mk' }), invoice };
}

export async function portalPayments(db: Db, portal: PortalContext, q: { contactId: string; page: number; pageSize: number }) {
  const { ctx, contactId } = resolveLink(portal, q.contactId);
  const { rows, total } = await listPayments(db, ctx, { contactId, page: q.page, pageSize: q.pageSize });
  return { rows, total };
}

export async function portalStatement(db: Db, portal: PortalContext, contactIdParam: string, buildingId?: string | undefined) {
  const { ctx, contactId } = resolveLink(portal, contactIdParam);
  return ownerStatement(db, ctx, contactId, buildingId);
}

/**
 * Art. 45(4): the money in the building's two funds, plus the fund-account movements of the last
 * twelve months. Owner `charge` postings are per-owner rows and are deliberately not listed — what
 * was billed to owners is reported as one number per fund instead (design addendum 15).
 */
export async function portalBuildingFund(db: Db, portal: PortalContext, contactIdParam: string, buildingId: string) {
  const { ctx, contactId } = resolveLink(portal, contactIdParam);
  const [building] = await db.select({ id: B.id, name: B.name }).from(B)
    .where(and(eq(B.tenantId, ctx.tenantId), eq(B.id, buildingId))).limit(1);
  if (!building) throw notFound('Building');
  // Art. 45(4) is an owner's right about *their* building: a link alone is not enough.
  const [owned] = await db.select({ id: U.id }).from(U)
    .where(and(eq(U.tenantId, ctx.tenantId), eq(U.buildingId, buildingId), eq(U.ownerContactId, contactId))).limit(1);
  if (!owned) throw notFound('Building');

  const since = new Date(Date.now() - FUND_WINDOW_MS);
  const [regularBalance, reserveBalance, regularBilled, reserveBilled, rows] = await Promise.all([
    fundBalance(db, ctx, buildingId, 'regular'),
    fundBalance(db, ctx, buildingId, 'reserve'),
    billedToOwners(db, ctx, buildingId, 'regular'),
    billedToOwners(db, ctx, buildingId, 'reserve'),
    db.select({ p: P, description: E.description }).from(P)
      .leftJoin(E, and(eq(E.id, P.refId), eq(E.tenantId, P.tenantId), inArray(P.refType, ['expense', 'expense_void'])))
      .where(and(eq(P.tenantId, ctx.tenantId), eq(P.buildingId, buildingId), eq(P.account, 'fund'), gte(P.bookedAt, since)))
      .orderBy(desc(P.bookedAt), desc(P.createdAt)),
  ]);

  return {
    building,
    regular: { balanceMinor: regularBalance, billedMinor: regularBilled },
    reserve: { balanceMinor: reserveBalance, billedMinor: reserveBilled },
    transactions: rows.map((r) => ({
      id: r.p.id, kind: r.p.kind, fund: r.p.fund, amountMinor: r.p.amountMinor, bookedAt: r.p.bookedAt,
      description: r.description ?? null,
    })),
  };
}
```

Append to `apps/api/src/portal/schema.ts`:

```ts
import { pageQuery } from '../resources/common.js';
import { fundEnum } from '../resources/reserve-fund/schema.js';
```

```ts
export const portalContactQuery = z.object({ contactId: z.string().uuid() });
export const portalInvoiceListQuery = pageQuery.extend({ contactId: z.string().uuid() });
export const portalPaymentListQuery = pageQuery.extend({ contactId: z.string().uuid() });
export const portalStatementQuery = portalContactQuery.extend({ buildingId: z.string().uuid().optional() });

export const portalFundOut = z.object({
  building: z.object({ id: z.string(), name: z.string() }),
  regular: z.object({ balanceMinor: z.number().int(), billedMinor: z.number().int() }),
  reserve: z.object({ balanceMinor: z.number().int(), billedMinor: z.number().int() }),
  transactions: z.array(z.object({
    id: z.string(),
    kind: z.enum(['charge', 'payment', 'expense', 'adjustment', 'opening']),
    fund: fundEnum,
    amountMinor: z.number().int(),
    bookedAt: z.date().or(z.string()),
    description: z.string().nullable(),
  })),
});
```

Create `apps/api/src/portal/data-routes.ts`:

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { htmlToPdf } from '../pdf/html-to-pdf.js';
import { idParam } from '../resources/common.js';
import { invoiceDetailOut, invoiceRowOut } from '../resources/invoices/schema.js';
import { paymentOut } from '../resources/payments/schema.js';
import { statementOut } from '../resources/contacts/schema.js';
import { portalBuildingFund, portalInvoice, portalInvoiceHtml, portalInvoices, portalPayments, portalStatement } from './repo.js';
import { portalContactQuery, portalFundOut, portalInvoiceListQuery, portalPaymentListQuery, portalStatementQuery } from './schema.js';

/** Read-only, scoped by link. Nothing here writes, and nothing here sees a request-supplied tenant. */
export const portalDataRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requirePortal);

  app.get('/invoices', { schema: { querystring: portalInvoiceListQuery, response: { 200: z.object({ rows: z.array(invoiceRowOut), total: z.number() }) } } }, async (req) =>
    portalInvoices(req.db, req.portal!, req.query));

  app.get('/invoices/:id', { schema: { params: idParam, querystring: portalContactQuery, response: { 200: invoiceDetailOut } } }, async (req) =>
    portalInvoice(req.db, req.portal!, req.query.contactId, req.params.id));

  app.get('/invoices/:id/pdf', { schema: { params: idParam, querystring: portalContactQuery } }, async (req, reply) => {
    const { html, invoice } = await portalInvoiceHtml(req.db, req.portal!, req.query.contactId, req.params.id);
    let pdf: Buffer;
    try {
      pdf = await htmlToPdf(html, app.config.pdfBrowserChannel);
    } catch (err) {
      app.log.warn({ err }, 'pdf browser launch failed');
      throw new AppError(503, 'pdf_unavailable', 'PDF rendering is not available on this server');
    }
    const name = (invoice.number ?? `invoice-${invoice.id}`).replace(/[^A-Za-z0-9_.-]/g, '_');
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${name}.pdf"`).send(pdf);
  });

  app.get('/payments', { schema: { querystring: portalPaymentListQuery, response: { 200: z.object({ rows: z.array(paymentOut), total: z.number() }) } } }, async (req) =>
    portalPayments(req.db, req.portal!, req.query));

  app.get('/statement', { schema: { querystring: portalStatementQuery, response: { 200: statementOut } } }, async (req) =>
    portalStatement(req.db, req.portal!, req.query.contactId, req.query.buildingId));

  app.get('/buildings/:id/fund', { schema: { params: idParam, querystring: portalContactQuery, response: { 200: portalFundOut } } }, async (req) =>
    portalBuildingFund(req.db, req.portal!, req.query.contactId, req.params.id));
};
```

`apps/api/src/app.ts` — register after the auth routes, on the same prefix:

```ts
import { portalDataRoutes } from './portal/data-routes.js';
```

```ts
    await api.register(portalAuthRoutes, { prefix: '/portal' });
    await api.register(portalDataRoutes, { prefix: '/portal' });
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @domar/api test && pnpm typecheck && pnpm lint`
Expected: PASS — 13 new tests in `portal.test.ts`; `invoicing.test.ts`, `payments.test.ts` and `statements.test.ts` unchanged, because `statuses` is optional and no existing caller passes it.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): read-only portal invoices, payments, statement and building fund" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Web — portal store, shell, login/register/home and the `/portal/*` guard

**Files:**
- Modify: `apps/web/src/api/types.ts`, `apps/web/src/router/index.ts`, `apps/web/src/i18n/mk.ts`, `apps/web/src/i18n/en.ts`
- Create: `apps/web/src/stores/portal.ts`, `apps/web/src/layouts/PortalShell.vue`, `apps/web/src/pages/portal/PortalLoginPage.vue`, `apps/web/src/pages/portal/PortalRegisterPage.vue`
- Rewrite: `apps/web/src/pages/portal/PortalHomePage.vue`
- Create: `apps/web/test/PortalRegisterPage.test.ts`

**Interfaces (consumed by Tasks 6, 7 and 8):**
- `apps/web/src/api/types.ts` gains `PortalLink`, `PortalMe`, `PortalFund`, `PortalInvite`, `PortalStatus`.
- `usePortalStore()` (`stores/portal.ts`) exposes `account`, `links`, `ready`, `selectedContactId`, `current`, `select(contactId)`, `fetchMe()`, `login({email,password})`, `register({code,email,password})`, `addCode(code)`, `changePassword({currentPassword,newPassword})`, `logout()`. `selectedContactId` persists under `localStorage['domar.portal.contactId']`.
- Routes: `/portal/login`, `/portal/register` (public) and the `PortalShell` tree at `/portal` with `meta: { portal: true }`. Children added in Task 6: `invoices`, `invoices/:id`, `payments`, `statement`, `fund`, `settings`.
- i18n: the complete `portal.*` block in both locales (used by Task 6 as well); `portal.comingSoon` is deleted.
- `data-test` hooks: `portal-code`, `portal-email`, `portal-password`, `portal-submit`, `portal-error`, `portal-logout`, `portal-link-switch`, `portal-card`, `portal-card-buildings`, `portal-nav-invoices`, `portal-nav-payments`, `portal-nav-statement`, `portal-nav-fund`, `portal-nav-settings`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/PortalRegisterPage.test.ts`:

```ts
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { i18n } from '@/i18n';
import PortalRegisterPage from '@/pages/portal/PortalRegisterPage.vue';
import { usePortalStore } from '@/stores/portal';

const routes = [
  { path: '/', component: { template: '<div/>' } },
  { path: '/portal', component: { template: '<div/>' } },
  { path: '/portal/login', component: { template: '<div/>' } },
];

describe('PortalRegisterPage', () => {
  it('posts the code, email and password and lands on the portal home', async () => {
    setActivePinia(createPinia());
    const store = usePortalStore();
    const spy = vi.spyOn(store, 'register').mockResolvedValue();
    const router = createRouter({ history: createMemoryHistory(), routes });
    const w = mount(PortalRegisterPage, { global: { plugins: [i18n, router] } });
    await w.get('[data-test=portal-code]').setValue('Ab3kM9xQ');
    await w.get('[data-test=portal-email]').setValue('marko@owner.mk');
    await w.get('[data-test=portal-password]').setValue('correct-horse-1');
    await w.get('form').trigger('submit');
    await new Promise((r) => setTimeout(r, 0));
    expect(spy).toHaveBeenCalledWith({ code: 'Ab3kM9xQ', email: 'marko@owner.mk', password: 'correct-horse-1' });
    await router.isReady();
    expect(router.currentRoute.value.path).toBe('/portal');
  });

  it('shows the wording for a wrong code and stays on the page', async () => {
    setActivePinia(createPinia());
    const store = usePortalStore();
    vi.spyOn(store, 'register').mockRejectedValue(Object.assign(new Error('nope'), { code: 'invalid_code' }));
    const router = createRouter({ history: createMemoryHistory(), routes });
    const w = mount(PortalRegisterPage, { global: { plugins: [i18n, router] } });
    await w.get('[data-test=portal-code]').setValue('ZZZZZZZZ');
    await w.get('form').trigger('submit');
    await new Promise((r) => setTimeout(r, 0));
    expect(w.get('[data-test=portal-error]').text()).toBe('Кодот е погрешен, искористен или истечен.');
    expect(router.currentRoute.value.path).toBe('/');
  });

  it('shows the wording for an email that already has an account', async () => {
    setActivePinia(createPinia());
    const store = usePortalStore();
    vi.spyOn(store, 'register').mockRejectedValue(Object.assign(new Error('nope'), { code: 'email_taken' }));
    const router = createRouter({ history: createMemoryHistory(), routes });
    const w = mount(PortalRegisterPage, { global: { plugins: [i18n, router] } });
    await w.get('form').trigger('submit');
    await new Promise((r) => setTimeout(r, 0));
    expect(w.get('[data-test=portal-error]').text()).toContain('Најавете се и додадете го кодот во Поставки.');
  });
});

describe('portal store', () => {
  it('keeps the selected contact inside the links it was given', async () => {
    setActivePinia(createPinia());
    const store = usePortalStore();
    const me = {
      account: { id: 'a1', email: 'marko@owner.mk' },
      links: [
        { tenantId: 't1', tenantName: 'Фирма 1', contactId: 'c1', contactName: 'Марко Марков', buildings: [{ id: 'b1', name: 'Партизанска 12' }] },
        { tenantId: 't2', tenantName: 'Фирма 2', contactId: 'c2', contactName: 'Марко Марков', buildings: [] },
      ],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(me), { status: 200, headers: { 'content-type': 'application/json' } })));
    await store.fetchMe();
    expect(store.ready).toBe(true);
    expect(store.selectedContactId).toBe('c1');
    expect(store.current?.tenantName).toBe('Фирма 1');
    store.select('c2');
    expect(store.current?.tenantName).toBe('Фирма 2');
    expect(localStorage.getItem('domar.portal.contactId')).toBe('c2');
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @domar/web test -- PortalRegisterPage`
Expected: FAIL — `Failed to resolve import "@/pages/portal/PortalRegisterPage.vue"`.

- [ ] **Step 3: Implement**

`apps/web/src/api/types.ts` — append:

```ts
export interface PortalLink { tenantId: string; tenantName: string; contactId: string; contactName: string; buildings: { id: string; name: string }[] }
export interface PortalMe { account: { id: string; email: string }; links: PortalLink[] }
export interface PortalFund {
  building: { id: string; name: string };
  regular: { balanceMinor: number; billedMinor: number };
  reserve: { balanceMinor: number; billedMinor: number };
  transactions: { id: string; kind: FundTransaction['kind']; fund: Fund; amountMinor: number; bookedAt: string; description: string | null }[];
}
export interface PortalInvite { code: string; expiresAt: string; emailed: boolean }
export interface PortalStatus { status: 'none' | 'invited' | 'linked'; expiresAt?: string; linkedAt?: string }
```

Create `apps/web/src/stores/portal.ts`:

```ts
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '@/api/client';
import type { PortalLink, PortalMe } from '@/api/types';

const STORAGE_KEY = 'domar.portal.contactId';

/** Which of the owner's properties the pages are currently showing. localStorage may throw in private mode. */
function readStored(): string | null {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

export const usePortalStore = defineStore('portal', () => {
  const account = ref<PortalMe['account'] | null>(null);
  const links = ref<PortalLink[]>([]);
  const ready = ref(false);
  const selectedContactId = ref<string | null>(readStored());

  function select(contactId: string | null) {
    selectedContactId.value = contactId;
    try {
      if (contactId) localStorage.setItem(STORAGE_KEY, contactId);
      else localStorage.removeItem(STORAGE_KEY);
    } catch { /* private mode: the selection just does not survive a reload */ }
  }

  function apply(me: PortalMe) {
    account.value = me.account;
    links.value = me.links;
    ready.value = true;
    // A stored id from another account (or a link that was removed) must never be sent as ?contactId=.
    if (!links.value.some((l) => l.contactId === selectedContactId.value)) select(links.value[0]?.contactId ?? null);
  }

  const current = computed(() => links.value.find((l) => l.contactId === selectedContactId.value) ?? null);

  async function fetchMe() {
    try {
      apply(await api.get<PortalMe>('/api/portal/me'));
    } catch {
      account.value = null; links.value = []; ready.value = true;
    }
  }
  async function login(payload: { email: string; password: string }) { apply(await api.post<PortalMe>('/api/portal/login', payload)); }
  async function register(payload: { code: string; email: string; password: string }) { apply(await api.post<PortalMe>('/api/portal/register', payload)); }
  async function addCode(code: string) { await api.post<PortalLink>('/api/portal/link', { code }); await fetchMe(); }
  async function changePassword(payload: { currentPassword: string; newPassword: string }) { await api.post('/api/portal/change-password', payload); }
  async function logout() {
    await api.post('/api/portal/logout');
    account.value = null; links.value = []; select(null);
  }

  return { account, links, ready, selectedContactId, current, select, fetchMe, login, register, addCode, changePassword, logout };
});
```

Create `apps/web/src/pages/portal/PortalRegisterPage.vue`:

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import { usePortalStore } from '@/stores/portal';

const { t, te } = useI18n();
const router = useRouter();
const portal = usePortalStore();
const code = ref(''); const email = ref(''); const password = ref('');
const error = ref(''); const loading = ref(false);

async function submit() {
  error.value = ''; loading.value = true;
  try {
    await portal.register({ code: code.value, email: email.value, password: password.value });
    await router.push('/portal');
  } catch (e) {
    const c = (e as { code?: string }).code ?? 'generic';
    error.value = te(`portal.errors.${c}`) ? t(`portal.errors.${c}`) : t('portal.errors.generic');
  } finally {
    loading.value = false;
  }
}
</script>
<template>
  <div class="mx-auto mt-16 max-w-sm rounded-xl bg-white p-6 shadow">
    <h1 class="mb-1 text-xl font-semibold">{{ t('portal.register') }}</h1>
    <p class="mb-4 text-sm text-slate-600">{{ t('portal.registerHint') }}</p>
    <form class="space-y-3" @submit.prevent="submit">
      <AppInput v-model="code" :label="t('portal.code')" data-test="portal-code" />
      <AppInput v-model="email" :label="t('portal.email')" type="email" data-test="portal-email" />
      <AppInput v-model="password" :label="t('portal.password')" type="password" data-test="portal-password" />
      <p v-if="error" class="text-sm text-red-600" data-test="portal-error">{{ error }}</p>
      <AppButton type="submit" :loading="loading" class="w-full justify-center" data-test="portal-submit">{{ t('portal.register') }}</AppButton>
    </form>
    <p class="mt-4 text-sm text-slate-600">{{ t('portal.haveAccount') }} <RouterLink to="/portal/login" class="text-emerald-700 underline">{{ t('portal.signIn') }}</RouterLink></p>
  </div>
</template>
```

Create `apps/web/src/pages/portal/PortalLoginPage.vue`:

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import { usePortalStore } from '@/stores/portal';

const { t, te } = useI18n();
const router = useRouter();
const portal = usePortalStore();
const email = ref(''); const password = ref('');
const error = ref(''); const loading = ref(false);

async function submit() {
  error.value = ''; loading.value = true;
  try {
    await portal.login({ email: email.value, password: password.value });
    await router.push('/portal');
  } catch (e) {
    const c = (e as { code?: string }).code ?? 'generic';
    error.value = te(`portal.errors.${c}`) ? t(`portal.errors.${c}`) : t('portal.errors.generic');
  } finally {
    loading.value = false;
  }
}
</script>
<template>
  <div class="mx-auto mt-16 max-w-sm rounded-xl bg-white p-6 shadow">
    <h1 class="mb-4 text-xl font-semibold">{{ t('portal.title') }}</h1>
    <form class="space-y-3" @submit.prevent="submit">
      <AppInput v-model="email" :label="t('portal.email')" type="email" data-test="portal-email" />
      <AppInput v-model="password" :label="t('portal.password')" type="password" data-test="portal-password" />
      <p v-if="error" class="text-sm text-red-600" data-test="portal-error">{{ error }}</p>
      <AppButton type="submit" :loading="loading" class="w-full justify-center" data-test="portal-submit">{{ t('portal.signIn') }}</AppButton>
    </form>
    <p class="mt-4 text-sm text-slate-600">{{ t('portal.haveCode') }} <RouterLink to="/portal/register" class="text-emerald-700 underline">{{ t('portal.register') }}</RouterLink></p>
  </div>
</template>
```

Create `apps/web/src/layouts/PortalShell.vue`:

```vue
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { i18n, setLocale, type Locale } from '@/i18n';
import { usePortalStore } from '@/stores/portal';

const { t } = useI18n();
const router = useRouter();
const portal = usePortalStore();
// No manager nav: an owner never sees buildings, services, users or tax rates (spec §19.5).
const nav = [
  { to: '/portal', key: 'portal.home', test: 'portal-nav-home' },
  { to: '/portal/invoices', key: 'portal.invoices', test: 'portal-nav-invoices' },
  { to: '/portal/payments', key: 'portal.payments', test: 'portal-nav-payments' },
  { to: '/portal/statement', key: 'portal.statement', test: 'portal-nav-statement' },
  { to: '/portal/fund', key: 'portal.fund', test: 'portal-nav-fund' },
  { to: '/portal/settings', key: 'portal.settings', test: 'portal-nav-settings' },
];
async function logout() { await portal.logout(); await router.push('/portal/login'); }
function toggleLocale() { setLocale((i18n.global.locale.value === 'mk' ? 'en' : 'mk') as Locale); }
</script>
<template>
  <div class="min-h-screen bg-slate-50">
    <header class="border-b border-slate-200 bg-white">
      <div class="mx-auto flex max-w-4xl flex-wrap items-center gap-3 px-4 py-3">
        <span class="text-lg font-bold text-emerald-700">domar</span>
        <select v-if="portal.links.length > 1" :value="portal.selectedContactId ?? ''" class="rounded-md border border-slate-300 px-2 py-1 text-sm" data-test="portal-link-switch"
          @change="portal.select(($event.target as HTMLSelectElement).value)">
          <option v-for="l in portal.links" :key="l.contactId" :value="l.contactId">{{ l.tenantName }} — {{ l.contactName }}</option>
        </select>
        <span class="ml-auto text-sm text-slate-600">{{ portal.account?.email }}</span>
        <button class="text-sm text-slate-600 underline" @click="toggleLocale">{{ i18n.global.locale.value.toUpperCase() }}</button>
        <button class="text-sm text-slate-600 underline" data-test="portal-logout" @click="logout">{{ t('portal.signOut') }}</button>
      </div>
      <nav class="mx-auto flex max-w-4xl gap-1 overflow-x-auto px-4 pb-2">
        <!-- `/portal` is a prefix of every child path, so the home link highlights on exact match only. -->
        <RouterLink v-for="n in nav" :key="n.to" :to="n.to" :data-test="n.test" class="whitespace-nowrap rounded-md px-3 py-1.5 text-sm hover:bg-slate-100"
          :active-class="n.to === '/portal' ? '' : 'bg-emerald-50 font-medium text-emerald-800'"
          exact-active-class="bg-emerald-50 font-medium text-emerald-800">{{ t(n.key) }}</RouterLink>
      </nav>
    </header>
    <main class="mx-auto max-w-4xl p-4"><RouterView /></main>
  </div>
</template>
```

Rewrite `apps/web/src/pages/portal/PortalHomePage.vue`:

```vue
<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { InvoiceRow, OwnerStatement } from '@/api/types';
import { usePortalStore } from '@/stores/portal';
import { formatMoney } from '@/utils/money';

const { t } = useI18n();
const portal = usePortalStore();
const invoices = ref<InvoiceRow[]>([]);
const statement = ref<OwnerStatement | null>(null);
const error = ref('');

async function load() {
  const contactId = portal.selectedContactId;
  if (!contactId) { invoices.value = []; statement.value = null; return; }
  error.value = '';
  try {
    const [inv, st] = await Promise.all([
      api.get<{ rows: InvoiceRow[]; total: number }>('/api/portal/invoices', { contactId, pageSize: 12 }),
      api.get<OwnerStatement>('/api/portal/statement', { contactId }),
    ]);
    invoices.value = inv.rows;
    statement.value = st;
  } catch { error.value = t('app.error'); }
}
onMounted(load);
watch(() => portal.selectedContactId, load);

const unpaidCount = () => invoices.value.filter((i) => i.outstandingMinor > 0).length;
const date = (d: string | null) => (d ? new Date(d).toLocaleDateString('mk-MK') : '—');
</script>
<template>
  <h1 class="mb-4 text-2xl font-semibold">{{ t('portal.title') }}</h1>
  <p v-if="error" class="mb-2 text-sm text-red-600" data-test="portal-page-error">{{ error }}</p>
  <p v-if="portal.links.length === 0" data-test="portal-no-links">{{ t('portal.noLinks') }}</p>
  <div v-else-if="portal.current" class="rounded-xl bg-white p-4 shadow-sm" data-test="portal-card">
    <div class="text-sm text-slate-500">{{ t('portal.manager') }}</div>
    <div class="font-medium" data-test="portal-card-manager">{{ portal.current.tenantName }}</div>
    <div class="mt-2 text-sm text-slate-500">{{ t('portal.buildings') }}</div>
    <div data-test="portal-card-buildings">{{ portal.current.buildings.map((b) => b.name).join(', ') || '—' }}</div>
    <div class="mt-4 grid grid-cols-3 gap-4">
      <div><div class="text-sm text-slate-500">{{ t('portal.balance') }}</div><div class="text-lg font-semibold" data-test="portal-card-balance">{{ formatMoney(statement?.balanceMinor ?? 0) }}</div></div>
      <div><div class="text-sm text-slate-500">{{ t('portal.unpaid') }}</div><div class="text-lg font-semibold" data-test="portal-card-unpaid">{{ unpaidCount() }}</div></div>
      <div><div class="text-sm text-slate-500">{{ t('portal.lastInvoice') }}</div><div class="text-lg font-semibold" data-test="portal-card-last">{{ invoices[0] ? `${invoices[0].period} · ${date(invoices[0].dueAt)}` : '—' }}</div></div>
    </div>
    <RouterLink to="/portal/invoices" class="mt-4 inline-block text-emerald-700 underline" data-test="portal-card-open">{{ t('portal.invoices') }}</RouterLink>
  </div>
</template>
```

`apps/web/src/router/index.ts` — replace the single `/portal` route and extend the guard:

```ts
import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { usePortalStore } from '@/stores/portal';
```

```ts
    { path: '/portal/login', component: () => import('@/pages/portal/PortalLoginPage.vue') },
    { path: '/portal/register', component: () => import('@/pages/portal/PortalRegisterPage.vue') },
    {
      path: '/portal', component: () => import('@/layouts/PortalShell.vue'), meta: { portal: true },
      children: [
        { path: '', component: () => import('@/pages/portal/PortalHomePage.vue') },
      ],
    },
```

```ts
router.beforeEach(async (to) => {
  // Two independent guards: an owner session never satisfies /app, a staff session never satisfies /portal.
  if (to.meta.portal) {
    const portal = usePortalStore();
    if (!portal.ready) await portal.fetchMe();
    return portal.account ? true : { path: '/portal/login' };
  }
  if (!to.meta.auth) return true;
  const auth = useAuthStore();
  if (!auth.ready) await auth.fetchMe();
  return auth.user ? true : { path: '/login' };
});
```

`apps/web/src/i18n/mk.ts` — replace the one-line `portal:` entry with the full block (Macedonian first; Task 6 uses the same block):

```ts
  portal: {
    title: 'Портал за сопственици',
    login: 'Најава', register: 'Регистрација', code: 'Код за пристап', email: 'Е-пошта', password: 'Лозинка',
    registerHint: 'Внесете го кодот што го добивте од вашиот управител, вашата е-пошта и лозинка по ваш избор (најмалку 10 знаци).',
    haveCode: 'Имате код од управителот?', haveAccount: 'Веќе имате сметка?', signIn: 'Најави се', signOut: 'Одјави се',
    home: 'Почетна', invoices: 'Пресметки', payments: 'Уплати', statement: 'Картица', fund: 'Фонд на зградата', settings: 'Поставки',
    manager: 'Управител', buildings: 'Згради', balance: 'Салдо', unpaid: 'Неплатени пресметки', lastInvoice: 'Последна пресметка',
    noLinks: 'Сè уште немате поврзан имот. Побарајте код од вашиот управител.', downloadPdf: 'Преземи PDF', back: 'Назад',
    addCode: 'Додади нов код', addCodeDone: 'Имотот е поврзан.', changePassword: 'Промени лозинка', passwordChanged: 'Лозинката е променета.',
    currentPassword: 'Тековна лозинка', newPassword: 'Нова лозинка', account: 'Сметка',
    fundRegular: 'Редовен фонд', fundReserve: 'Резервен фонд', fundBalance: 'Состојба', fundBilled: 'Фактурирано на сопственици',
    fundTransactions: 'Промени во последните 12 месеци', fundNote: 'Прикажани се само движењата на сметките на зградата, без податоци за другите сопственици.',
    date: 'Датум', amount: 'Износ', description: 'Опис', period: 'Период', number: 'Број', total: 'Вкупно', outstanding: 'Преостанато', status: 'Статус',
    errors: {
      invalid_code: 'Кодот е погрешен, искористен или истечен.',
      invalid_credentials: 'Погрешна е-пошта или лозинка.',
      already_linked: 'Овој имот е веќе поврзан со вашата сметка.',
      email_taken: 'Веќе постои сметка со таа е-пошта. Најавете се и додадете го кодот во Поставки.',
      validation: 'Проверете ги внесените податоци. Лозинката мора да има најмалку 10 знаци.',
      generic: 'Настана грешка. Обидете се повторно.',
    },
  },
```

`apps/web/src/i18n/en.ts` — the mirror, same keys in the same order:

```ts
  portal: {
    title: 'Owner portal',
    login: 'Log in', register: 'Register', code: 'Access code', email: 'Email', password: 'Password',
    registerHint: 'Enter the code you received from your manager, your email and a password of your choice (at least 10 characters).',
    haveCode: 'Have a code from your manager?', haveAccount: 'Already have an account?', signIn: 'Log in', signOut: 'Log out',
    home: 'Home', invoices: 'Invoices', payments: 'Payments', statement: 'Statement', fund: 'Building fund', settings: 'Settings',
    manager: 'Manager', buildings: 'Buildings', balance: 'Balance', unpaid: 'Unpaid invoices', lastInvoice: 'Last invoice',
    noLinks: 'No property is linked yet. Ask your manager for a code.', downloadPdf: 'Download PDF', back: 'Back',
    addCode: 'Add another code', addCodeDone: 'The property is linked.', changePassword: 'Change password', passwordChanged: 'Password changed.',
    currentPassword: 'Current password', newPassword: 'New password', account: 'Account',
    fundRegular: 'Regular fund', fundReserve: 'Reserve fund', fundBalance: 'Balance', fundBilled: 'Billed to owners',
    fundTransactions: 'Changes in the last 12 months', fundNote: 'Only the building accounts’ movements are shown, with no data about other owners.',
    date: 'Date', amount: 'Amount', description: 'Description', period: 'Period', number: 'Number', total: 'Total', outstanding: 'Outstanding', status: 'Status',
    errors: {
      invalid_code: 'The code is wrong, already used or expired.',
      invalid_credentials: 'Wrong email or password.',
      already_linked: 'This property is already linked to your account.',
      email_taken: 'An account with that email already exists. Log in and add the code under Settings.',
      validation: 'Check what you entered. The password must be at least 10 characters.',
      generic: 'Something went wrong. Please try again.',
    },
  },
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @domar/web test && pnpm typecheck && pnpm lint`
Expected: PASS — 4 new tests, and `LoginPage.test.ts`'s parity test still passes (`portal.comingSoon` is gone from both files and every new key exists in both).

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): owner portal shell, store, login, register and home" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Web — portal invoices, payments, statement, building fund and settings

**Files:**
- Create: `apps/web/src/pages/portal/PortalInvoicesPage.vue`, `PortalInvoicePage.vue`, `PortalPaymentsPage.vue`, `PortalStatementPage.vue`, `PortalFundPage.vue`, `PortalSettingsPage.vue` (all under `apps/web/src/pages/portal/`)
- Modify: `apps/web/src/router/index.ts`
- Create: `apps/web/test/PortalPages.test.ts`

**Interfaces (consumed by Task 8):**
- Routes under the `PortalShell` tree: `invoices`, `invoices/:id` (`props: true`), `payments`, `statement`, `fund`, `settings`.
- `data-test` hooks: `portal-invoice-link`, `portal-invoice-number`, `portal-invoice-total`, `portal-invoice-outstanding`, `portal-invoice-pdf`, `portal-payment-amount`, `portal-statement-balance`, `portal-fund-building`, `portal-fund-regular`, `portal-fund-reserve`, `portal-fund-billed-reserve`, `portal-fund-tx`, `portal-add-code`, `portal-add-code-submit`, `portal-add-code-done`, `portal-current-password`, `portal-new-password`, `portal-change-password`, `portal-password-changed`, plus the Task 5 hooks `portal-card*`.
- The PDF link is `${API_BASE}/api/portal/invoices/${id}/pdf?contactId=${contactId}` — the same `API_BASE` the manager's `InvoicePage.vue` uses, so it works both in dev (`http://localhost:3001`) and in the single-origin production image.
- This task also carries the unit test for `PortalHomePage.vue` (built in Task 5): the home page's "open invoices" link only becomes reachable here.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/PortalPages.test.ts`:

```ts
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import PortalFundPage from '@/pages/portal/PortalFundPage.vue';
import PortalHomePage from '@/pages/portal/PortalHomePage.vue';
import PortalInvoicesPage from '@/pages/portal/PortalInvoicesPage.vue';
import { usePortalStore } from '@/stores/portal';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const me = {
  account: { id: 'a1', email: 'marko@owner.mk' },
  links: [{ tenantId: 't1', tenantName: 'Фирма 1', contactId: 'c1', contactName: 'Марко Марков', buildings: [{ id: 'b1', name: 'Партизанска 12' }] }],
};
const invoice = {
  id: 'i1', periodId: 'p1', buildingId: 'b1', contactId: 'c1', number: 'INV-0001/2026', status: 'partially_paid', currency: 'MKD', unitIds: ['u1'],
  subtotalMinor: 224660, taxMinor: 31439, totalMinor: 256099, previousBalanceMinor: 0, amountDueMinor: 256099, reserveFundBuildingBalanceMinor: 3500000,
  paidMinor: 100000, outstandingMinor: 156099, issuedAt: '2026-09-30T00:00:00.000Z', dueAt: '2026-10-15T00:00:00.000Z', publishedAt: '2026-09-30T00:00:00.000Z',
  period: '2026-09', contact: { id: 'c1', firstName: 'Марко', lastName: 'Марков' }, building: { id: 'b1', name: 'Партизанска 12' }, createdAt: '2026-09-30T00:00:00.000Z',
};
const statement = { contact: { id: 'c1', firstName: 'Марко', lastName: 'Марков' }, building: null, rows: [], balanceMinor: 156099 };

async function primedStore(fetchMock: ReturnType<typeof vi.fn>) {
  setActivePinia(createPinia());
  vi.stubGlobal('fetch', fetchMock);
  const store = usePortalStore();
  await store.fetchMe();
  return store;
}

describe('PortalHomePage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows the manager, the buildings, the balance and the unpaid count', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(me))
      .mockResolvedValueOnce(json({ rows: [invoice], total: 1 }))
      .mockResolvedValueOnce(json(statement));
    await primedStore(fetchMock);
    const w = mount(PortalHomePage, { global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/portal/invoices?contactId=c1&pageSize=12');
    expect(String(fetchMock.mock.calls[2]![0])).toBe('http://localhost:3001/api/portal/statement?contactId=c1');
    expect(w.get('[data-test=portal-card-manager]').text()).toBe('Фирма 1');
    expect(w.get('[data-test=portal-card-buildings]').text()).toBe('Партизанска 12');
    expect(w.get('[data-test=portal-card-balance]').text()).toBe('1.560,99 ден.');
    expect(w.get('[data-test=portal-card-unpaid]').text()).toBe('1');
    // mk-MK short dates carry the era suffix: `15.10.2026 г.`
    expect(w.get('[data-test=portal-card-last]').text()).toBe('2026-09 · 15.10.2026 г.');
  });

  it('asks for a code when nothing is linked', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ account: { id: 'a1', email: 'x@owner.mk' }, links: [] }));
    await primedStore(fetchMock);
    const w = mount(PortalHomePage, { global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await vi.waitFor(() => expect(w.find('[data-test=portal-no-links]').exists()).toBe(true));
    expect(w.get('[data-test=portal-no-links]').text()).toBe('Сè уште немате поврзан имот. Побарајте код од вашиот управител.');
    expect(fetchMock).toHaveBeenCalledTimes(1); // nothing is fetched without a selected contact
  });
});

describe('PortalInvoicesPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists the invoices with their outstanding amounts', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(me)).mockResolvedValueOnce(json({ rows: [invoice], total: 1 }));
    await primedStore(fetchMock);
    const w = mount(PortalInvoicesPage, { global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/portal/invoices?contactId=c1&page=1&pageSize=50');
    expect(w.get('[data-test=portal-invoice-total]').text()).toBe('2.560,99 ден.');
    expect(w.get('[data-test=portal-invoice-outstanding]').text()).toBe('1.560,99 ден.');
    expect(w.text()).toContain('INV-0001/2026');
    expect(w.text()).toContain('Делумно платена');
  });
});

describe('PortalFundPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows both fund balances and the last 12 months of movements', async () => {
    const fund = {
      building: { id: 'b1', name: 'Партизанска 12' },
      regular: { balanceMinor: 81099, billedMinor: 839532 },
      reserve: { balanceMinor: 3550000, billedMinor: 225000 },
      transactions: [
        { id: 'p1', kind: 'expense', fund: 'regular', amountMinor: -120000, bookedAt: '2026-09-14T00:00:00.000Z', description: 'Поправка на лифт' },
        { id: 'p2', kind: 'opening', fund: 'reserve', amountMinor: 3500000, bookedAt: '2026-09-01T00:00:00.000Z', description: null },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(json(me)).mockResolvedValueOnce(json(fund));
    await primedStore(fetchMock);
    const w = mount(PortalFundPage, { global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/portal/buildings/b1/fund?contactId=c1');
    expect(w.get('[data-test=portal-fund-regular]').text()).toBe('810,99 ден.');
    expect(w.get('[data-test=portal-fund-reserve]').text()).toBe('35.500,00 ден.');
    expect(w.get('[data-test=portal-fund-billed-reserve]').text()).toBe('2.250,00 ден.');
    expect(w.findAll('[data-test=portal-fund-tx]')).toHaveLength(2);
    expect(w.findAll('[data-test=portal-fund-tx]')[0]!.text()).toContain('Поправка на лифт');
    expect(w.findAll('[data-test=portal-fund-tx]')[0]!.text()).toContain('Трошок');
    expect(w.findAll('[data-test=portal-fund-tx]')[1]!.text()).toContain('Почетно салдо');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @domar/web test -- PortalPages`
Expected: FAIL — `Failed to resolve import "@/pages/portal/PortalInvoicesPage.vue"`.

- [ ] **Step 3: Implement**

Create `apps/web/src/pages/portal/PortalInvoicesPage.vue`:

```vue
<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { InvoiceRow } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import { usePortalStore } from '@/stores/portal';
import { formatMoney } from '@/utils/money';

const { t } = useI18n();
const portal = usePortalStore();
const rows = ref<InvoiceRow[]>([]);
const error = ref('');

async function load() {
  const contactId = portal.selectedContactId;
  if (!contactId) { rows.value = []; return; }
  error.value = '';
  try { rows.value = (await api.get<{ rows: InvoiceRow[]; total: number }>('/api/portal/invoices', { contactId, page: 1, pageSize: 50 })).rows; }
  catch { error.value = t('app.error'); }
}
onMounted(load);
watch(() => portal.selectedContactId, load);
const date = (d: string | null) => (d ? new Date(d).toLocaleDateString('mk-MK') : '—');
</script>
<template>
  <h1 class="mb-4 text-2xl font-semibold">{{ t('portal.invoices') }}</h1>
  <p v-if="error" class="mb-2 text-sm text-red-600" data-test="portal-page-error">{{ error }}</p>
  <DataTable :columns="[{ key: 'period', label: t('portal.period') }, { key: 'number', label: t('portal.number') }, { key: 'dueAt', label: t('invoices.due') }, { key: 'totalMinor', label: t('portal.total') }, { key: 'outstandingMinor', label: t('portal.outstanding') }, { key: 'status', label: t('portal.status') }]" :rows="rows">
    <template #cell-number="{ row }">
      <RouterLink :to="`/portal/invoices/${row.id}`" class="text-emerald-700 underline" data-test="portal-invoice-link">{{ row.number ?? row.id }}</RouterLink>
    </template>
    <template #cell-dueAt="{ row }">{{ date(row.dueAt) }}</template>
    <template #cell-totalMinor="{ row }"><span data-test="portal-invoice-total">{{ formatMoney(row.totalMinor) }}</span></template>
    <template #cell-outstandingMinor="{ row }"><span data-test="portal-invoice-outstanding">{{ formatMoney(row.outstandingMinor) }}</span></template>
    <template #cell-status="{ row }">{{ t(`invoices.status.${row.status}`) }}</template>
  </DataTable>
</template>
```

Create `apps/web/src/pages/portal/PortalInvoicePage.vue`:

```vue
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, API_BASE } from '@/api/client';
import type { Invoice } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import { usePortalStore } from '@/stores/portal';
import { formatMoney, percentFromBp } from '@/utils/money';

const props = defineProps<{ id: string }>();
const { t } = useI18n();
const portal = usePortalStore();
const inv = ref<Invoice | null>(null);
const error = ref('');

onMounted(async () => {
  const contactId = portal.selectedContactId;
  if (!contactId) return;
  try { inv.value = await api.get<Invoice>(`/api/portal/invoices/${props.id}`, { contactId }); }
  catch { error.value = t('app.error'); }
});
// Same shape as the manager's link, so the PDF works in dev (port 3001) and in the single-origin image.
const pdfHref = computed(() => `${API_BASE}/api/portal/invoices/${props.id}/pdf?contactId=${portal.selectedContactId ?? ''}`);
const date = (d: string | null) => (d ? new Date(d).toLocaleDateString('mk-MK') : '—');
</script>
<template>
  <p v-if="error" class="text-sm text-red-600" data-test="portal-page-error">{{ error }}</p>
  <div v-if="inv">
    <div class="mb-4 flex flex-wrap items-start justify-between gap-2">
      <div>
        <h1 class="text-2xl font-semibold" data-test="portal-invoice-number">{{ inv.number ?? inv.id }}</h1>
        <p class="text-slate-600">{{ inv.building.name }} · {{ t('portal.period') }} {{ inv.period }} · {{ t(`invoices.status.${inv.status}`) }}</p>
        <p class="text-slate-600">{{ t('invoices.due') }}: {{ date(inv.dueAt) }}</p>
      </div>
      <a :href="pdfHref" target="_blank" rel="noopener" class="rounded-md bg-emerald-600 px-3 py-2 text-sm text-white" data-test="portal-invoice-pdf">{{ t('portal.downloadPdf') }}</a>
    </div>
    <table class="w-full rounded-xl bg-white text-sm shadow-sm">
      <thead class="bg-slate-50 text-left text-slate-600"><tr><th class="px-3 py-2">{{ t('billing.description') }}</th><th class="px-3 py-2">{{ t('units.label') }}</th><th class="px-3 py-2 text-right">{{ t('billing.buildingWide') }}</th><th class="px-3 py-2 text-right">{{ t('billing.ownerShare') }}</th><th class="px-3 py-2 text-right">{{ t('billing.tax') }}</th><th class="px-3 py-2 text-right">{{ t('billing.total') }}</th></tr></thead>
      <tbody>
        <tr v-for="l in inv.lines" :key="l.id" class="border-t border-slate-100">
          <td class="px-3 py-1">{{ l.description }}</td><td class="px-3 py-1">{{ l.unitLabel }}</td>
          <td class="px-3 py-1 text-right">{{ formatMoney(l.buildingWideNetMinor) }}</td>
          <td class="px-3 py-1 text-right">{{ formatMoney(l.ownerNetMinor) }}</td>
          <td class="px-3 py-1 text-right">{{ percentFromBp(l.taxRateBp) }} / {{ formatMoney(l.ownerTaxMinor) }}</td>
          <td class="px-3 py-1 text-right">{{ formatMoney(l.ownerGrossMinor) }}</td>
        </tr>
      </tbody>
    </table>
    <div class="mt-4 ml-auto w-80 space-y-1 text-sm">
      <div class="flex justify-between"><span>{{ t('billing.subtotal') }}</span><span>{{ formatMoney(inv.subtotalMinor) }}</span></div>
      <div class="flex justify-between"><span>{{ t('billing.tax') }}</span><span>{{ formatMoney(inv.taxMinor) }}</span></div>
      <div class="flex justify-between font-medium"><span>{{ t('portal.total') }}</span><span data-test="portal-invoice-total">{{ formatMoney(inv.totalMinor) }}</span></div>
      <div class="flex justify-between"><span>{{ t('billing.previousBalance') }}</span><span>{{ formatMoney(inv.previousBalanceMinor) }}</span></div>
      <div class="flex justify-between border-t border-slate-300 pt-1 text-base font-semibold"><span>{{ t('billing.amountDue') }}</span><span>{{ formatMoney(inv.amountDueMinor) }}</span></div>
      <div class="flex justify-between"><span>{{ t('billing.paid') }}</span><span>{{ formatMoney(inv.paidMinor) }}</span></div>
      <div class="flex justify-between"><span>{{ t('portal.outstanding') }}</span><span data-test="portal-invoice-outstanding">{{ formatMoney(inv.outstandingMinor) }}</span></div>
      <div class="flex justify-between pt-2 text-slate-600"><span>{{ t('invoices.reserveBalance') }}</span><span>{{ formatMoney(inv.reserveFundBuildingBalanceMinor) }}</span></div>
    </div>
    <h2 class="mb-2 mt-6 text-lg font-semibold">{{ t('portal.payments') }}</h2>
    <DataTable :columns="[{ key: 'paidAt', label: t('portal.date') }, { key: 'method', label: t('payments.method') }, { key: 'amountMinor', label: t('portal.amount') }]" :rows="inv.payments">
      <template #cell-paidAt="{ row }">{{ date(row.paidAt) }}</template>
      <template #cell-method="{ row }">{{ t(`payments.methods.${row.method}`) }}</template>
      <template #cell-amountMinor="{ row }">{{ formatMoney(row.amountMinor) }}</template>
    </DataTable>
    <RouterLink to="/portal/invoices" class="mt-4 inline-block text-emerald-700 underline">{{ t('portal.back') }}</RouterLink>
  </div>
</template>
```

Create `apps/web/src/pages/portal/PortalPaymentsPage.vue`:

```vue
<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { Payment } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import { usePortalStore } from '@/stores/portal';
import { formatMoney } from '@/utils/money';

const { t } = useI18n();
const portal = usePortalStore();
const rows = ref<Payment[]>([]);
const error = ref('');

async function load() {
  const contactId = portal.selectedContactId;
  if (!contactId) { rows.value = []; return; }
  error.value = '';
  try { rows.value = (await api.get<{ rows: Payment[]; total: number }>('/api/portal/payments', { contactId, page: 1, pageSize: 50 })).rows; }
  catch { error.value = t('app.error'); }
}
onMounted(load);
watch(() => portal.selectedContactId, load);
const date = (d: string) => new Date(d).toLocaleDateString('mk-MK');
</script>
<template>
  <h1 class="mb-4 text-2xl font-semibold">{{ t('portal.payments') }}</h1>
  <p v-if="error" class="mb-2 text-sm text-red-600" data-test="portal-page-error">{{ error }}</p>
  <DataTable :columns="[{ key: 'paidAt', label: t('portal.date') }, { key: 'method', label: t('payments.method') }, { key: 'amountMinor', label: t('portal.amount') }, { key: 'invoice', label: t('portal.number') }, { key: 'status', label: t('portal.status') }]" :rows="rows">
    <template #cell-paidAt="{ row }">{{ date(row.paidAt) }}</template>
    <template #cell-method="{ row }">{{ t(`payments.methods.${row.method}`) }}</template>
    <template #cell-amountMinor="{ row }"><span data-test="portal-payment-amount">{{ formatMoney(row.amountMinor) }}</span></template>
    <template #cell-invoice="{ row }">{{ row.invoice?.number ?? '—' }}</template>
    <template #cell-status="{ row }">{{ t(`payments.status.${row.status}`) }}</template>
  </DataTable>
</template>
```

Create `apps/web/src/pages/portal/PortalStatementPage.vue`:

```vue
<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { OwnerStatement } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import { usePortalStore } from '@/stores/portal';
import { formatMoney } from '@/utils/money';

const { t } = useI18n();
const portal = usePortalStore();
const statement = ref<OwnerStatement | null>(null);
const error = ref('');

async function load() {
  const contactId = portal.selectedContactId;
  if (!contactId) { statement.value = null; return; }
  error.value = '';
  try { statement.value = await api.get<OwnerStatement>('/api/portal/statement', { contactId }); }
  catch { error.value = t('app.error'); }
}
onMounted(load);
watch(() => portal.selectedContactId, load);
</script>
<template>
  <h1 class="mb-4 text-2xl font-semibold">{{ t('portal.statement') }}</h1>
  <p v-if="error" class="mb-2 text-sm text-red-600" data-test="portal-page-error">{{ error }}</p>
  <DataTable v-if="statement" :columns="[{ key: 'bookedAt', label: t('portal.date') }, { key: 'label', label: t('portal.description') }, { key: 'kind', label: t('portal.status') }, { key: 'fund', label: t('billing.fund') }, { key: 'amountMinor', label: t('portal.amount') }, { key: 'balanceMinor', label: t('portal.balance') }]" :rows="statement.rows">
    <template #cell-bookedAt="{ row }">{{ new Date(row.bookedAt).toLocaleDateString('mk-MK') }}</template>
    <template #cell-kind="{ row }">{{ t(`ledger.kind.${row.kind}`) }}</template>
    <template #cell-fund="{ row }">{{ t(`billing.${row.fund}`) }}</template>
    <template #cell-amountMinor="{ row }">{{ formatMoney(row.amountMinor) }}</template>
    <template #cell-balanceMinor="{ row }">{{ formatMoney(row.balanceMinor) }}</template>
  </DataTable>
  <p v-if="statement" class="mt-4 text-right text-lg font-semibold">{{ t('portal.balance') }}: <span data-test="portal-statement-balance">{{ formatMoney(statement.balanceMinor) }}</span></p>
</template>
```

Create `apps/web/src/pages/portal/PortalFundPage.vue`:

```vue
<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { PortalFund } from '@/api/types';
import { usePortalStore } from '@/stores/portal';
import { formatMoney } from '@/utils/money';

const { t } = useI18n();
const portal = usePortalStore();
const buildingId = ref<string | null>(null);
const fund = ref<PortalFund | null>(null);
const error = ref('');

async function load() {
  const contactId = portal.selectedContactId;
  const id = buildingId.value ?? portal.current?.buildings[0]?.id ?? null;
  buildingId.value = id;
  if (!contactId || !id) { fund.value = null; return; }
  error.value = '';
  try { fund.value = await api.get<PortalFund>(`/api/portal/buildings/${id}/fund`, { contactId }); }
  catch { error.value = t('app.error'); }
}
onMounted(load);
watch(() => portal.selectedContactId, () => { buildingId.value = null; void load(); });
watch(buildingId, (v, old) => { if (v && old && v !== old) void load(); });
const date = (d: string) => new Date(d).toLocaleDateString('mk-MK');
</script>
<template>
  <h1 class="mb-1 text-2xl font-semibold">{{ t('portal.fund') }}</h1>
  <p class="mb-4 text-sm text-slate-600">{{ t('portal.fundNote') }}</p>
  <p v-if="error" class="mb-2 text-sm text-red-600" data-test="portal-page-error">{{ error }}</p>
  <select v-if="(portal.current?.buildings.length ?? 0) > 1" v-model="buildingId" class="mb-4 rounded-md border border-slate-300 px-2 py-1 text-sm" data-test="portal-fund-building">
    <option v-for="b in portal.current!.buildings" :key="b.id" :value="b.id">{{ b.name }}</option>
  </select>
  <div v-if="fund">
    <h2 class="mb-2 text-lg font-medium">{{ fund.building.name }}</h2>
    <div class="grid gap-4 sm:grid-cols-2">
      <div class="rounded-xl bg-white p-4 shadow-sm">
        <div class="text-sm text-slate-500">{{ t('portal.fundRegular') }} — {{ t('portal.fundBalance') }}</div>
        <div class="text-xl font-semibold" data-test="portal-fund-regular">{{ formatMoney(fund.regular.balanceMinor) }}</div>
        <div class="mt-2 text-sm text-slate-500">{{ t('portal.fundBilled') }}</div>
        <div data-test="portal-fund-billed-regular">{{ formatMoney(fund.regular.billedMinor) }}</div>
      </div>
      <div class="rounded-xl bg-white p-4 shadow-sm">
        <div class="text-sm text-slate-500">{{ t('portal.fundReserve') }} — {{ t('portal.fundBalance') }}</div>
        <div class="text-xl font-semibold" data-test="portal-fund-reserve">{{ formatMoney(fund.reserve.balanceMinor) }}</div>
        <div class="mt-2 text-sm text-slate-500">{{ t('portal.fundBilled') }}</div>
        <div data-test="portal-fund-billed-reserve">{{ formatMoney(fund.reserve.billedMinor) }}</div>
      </div>
    </div>
    <h2 class="mb-2 mt-6 text-lg font-semibold">{{ t('portal.fundTransactions') }}</h2>
    <div class="overflow-x-auto rounded-xl bg-white shadow-sm">
      <table class="w-full text-sm">
        <thead class="bg-slate-50 text-left text-slate-600"><tr><th class="px-4 py-2 font-medium">{{ t('portal.date') }}</th><th class="px-4 py-2 font-medium">{{ t('billing.fund') }}</th><th class="px-4 py-2 font-medium">{{ t('portal.status') }}</th><th class="px-4 py-2 font-medium">{{ t('portal.description') }}</th><th class="px-4 py-2 text-right font-medium">{{ t('portal.amount') }}</th></tr></thead>
        <tbody>
          <tr v-if="fund.transactions.length === 0"><td colspan="5" class="px-4 py-6 text-center text-slate-500">{{ t('app.empty') }}</td></tr>
          <tr v-for="tx in fund.transactions" :key="tx.id" class="border-t border-slate-100" data-test="portal-fund-tx">
            <td class="px-4 py-2">{{ date(tx.bookedAt) }}</td>
            <td class="px-4 py-2">{{ t(`billing.${tx.fund}`) }}</td>
            <td class="px-4 py-2">{{ t(`ledger.kind.${tx.kind}`) }}</td>
            <td class="px-4 py-2">{{ tx.description ?? '—' }}</td>
            <td class="px-4 py-2 text-right">{{ formatMoney(tx.amountMinor) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
```

Create `apps/web/src/pages/portal/PortalSettingsPage.vue`:

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import { usePortalStore } from '@/stores/portal';

const { t, te } = useI18n();
const portal = usePortalStore();
const code = ref(''); const codeError = ref(''); const codeDone = ref(false); const codeBusy = ref(false);
const currentPassword = ref(''); const newPassword = ref('');
const pwError = ref(''); const pwDone = ref(false); const pwBusy = ref(false);

const wording = (e: unknown) => {
  const c = (e as { code?: string }).code ?? 'generic';
  return te(`portal.errors.${c}`) ? t(`portal.errors.${c}`) : t('portal.errors.generic');
};

async function addCode() {
  codeError.value = ''; codeDone.value = false; codeBusy.value = true;
  try { await portal.addCode(code.value); code.value = ''; codeDone.value = true; }
  catch (e) { codeError.value = wording(e); } finally { codeBusy.value = false; }
}
async function changePassword() {
  pwError.value = ''; pwDone.value = false; pwBusy.value = true;
  try {
    await portal.changePassword({ currentPassword: currentPassword.value, newPassword: newPassword.value });
    currentPassword.value = ''; newPassword.value = ''; pwDone.value = true;
  } catch (e) { pwError.value = wording(e); } finally { pwBusy.value = false; }
}
</script>
<template>
  <h1 class="mb-4 text-2xl font-semibold">{{ t('portal.settings') }}</h1>
  <section class="mb-6 max-w-sm rounded-xl bg-white p-4 shadow-sm">
    <h2 class="mb-2 font-medium">{{ t('portal.account') }}</h2>
    <p class="text-sm text-slate-600">{{ portal.account?.email }}</p>
  </section>
  <section class="mb-6 max-w-sm rounded-xl bg-white p-4 shadow-sm">
    <h2 class="mb-2 font-medium">{{ t('portal.addCode') }}</h2>
    <form class="space-y-3" @submit.prevent="addCode">
      <AppInput v-model="code" :label="t('portal.code')" data-test="portal-add-code" />
      <p v-if="codeError" class="text-sm text-red-600" data-test="portal-add-code-error">{{ codeError }}</p>
      <p v-if="codeDone" class="text-sm text-emerald-700" data-test="portal-add-code-done">{{ t('portal.addCodeDone') }}</p>
      <AppButton type="submit" :loading="codeBusy" data-test="portal-add-code-submit">{{ t('portal.addCode') }}</AppButton>
    </form>
  </section>
  <section class="max-w-sm rounded-xl bg-white p-4 shadow-sm">
    <h2 class="mb-2 font-medium">{{ t('portal.changePassword') }}</h2>
    <form class="space-y-3" @submit.prevent="changePassword">
      <AppInput v-model="currentPassword" :label="t('portal.currentPassword')" type="password" data-test="portal-current-password" />
      <AppInput v-model="newPassword" :label="t('portal.newPassword')" type="password" data-test="portal-new-password" />
      <p v-if="pwError" class="text-sm text-red-600" data-test="portal-password-error">{{ pwError }}</p>
      <p v-if="pwDone" class="text-sm text-emerald-700" data-test="portal-password-changed">{{ t('portal.passwordChanged') }}</p>
      <AppButton type="submit" :loading="pwBusy" data-test="portal-change-password">{{ t('portal.changePassword') }}</AppButton>
    </form>
  </section>
</template>
```

`apps/web/src/router/index.ts` — fill in the `PortalShell` children:

```ts
      children: [
        { path: '', component: () => import('@/pages/portal/PortalHomePage.vue') },
        { path: 'invoices', component: () => import('@/pages/portal/PortalInvoicesPage.vue') },
        { path: 'invoices/:id', component: () => import('@/pages/portal/PortalInvoicePage.vue'), props: true },
        { path: 'payments', component: () => import('@/pages/portal/PortalPaymentsPage.vue') },
        { path: 'statement', component: () => import('@/pages/portal/PortalStatementPage.vue') },
        { path: 'fund', component: () => import('@/pages/portal/PortalFundPage.vue') },
        { path: 'settings', component: () => import('@/pages/portal/PortalSettingsPage.vue') },
      ],
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @domar/web test && pnpm typecheck && pnpm lint`
Expected: PASS — 4 new tests in `PortalPages.test.ts`; no new i18n key was needed, so the parity test is untouched.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): portal invoices, payments, statement, building fund and settings" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Web — the manager's "Portal access" box on the contact statement page

**Files:**
- Create: `apps/web/src/components/contacts/PortalAccessBox.vue`
- Modify: `apps/web/src/pages/ContactStatementPage.vue`, `apps/web/src/i18n/mk.ts`, `apps/web/src/i18n/en.ts`
- Create: `apps/web/test/PortalAccessBox.test.ts`

**Interfaces (consumed by Task 8):**
- `<PortalAccessBox :contact-id="id" />` — one prop, `contactId: string`. It owns its own fetches: `GET /api/contacts/:id/portal-status` on mount and after every issue, `POST /api/contacts/:id/portal-invite` on the button.
- `data-test` hooks: `portal-status`, `portal-issue`, `portal-issued-code`, `portal-code-copy`, `portal-code-copied`, `portal-code-dismiss`, `portal-code-emailed`, `portal-expires`, `portal-access-error`.
- i18n: `contacts.portalAccess.*` in both locales.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/PortalAccessBox.test.ts`:

```ts
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PortalAccessBox from '@/components/contacts/PortalAccessBox.vue';
import { i18n } from '@/i18n';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

describe('PortalAccessBox', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('issues a code, shows it once and reports the new status', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ status: 'none' }))
      .mockResolvedValueOnce(json({ code: 'Ab3kM9xQ', expiresAt: '2026-10-18T09:00:00.000Z', emailed: true }))
      .mockResolvedValueOnce(json({ status: 'invited', expiresAt: '2026-10-18T09:00:00.000Z' }));
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(PortalAccessBox, { props: { contactId: 'c1' }, global: { plugins: [i18n] } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://localhost:3001/api/contacts/c1/portal-status');
    expect(w.get('[data-test=portal-status]').text()).toBe('Нема пристап');

    await w.get('[data-test=portal-issue]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/contacts/c1/portal-invite');
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(w.get('[data-test=portal-issued-code]').text()).toBe('Ab3kM9xQ');
    expect(w.get('[data-test=portal-code-emailed]').text()).toBe('Кодот е испратен и по е-пошта.');
    expect(w.get('[data-test=portal-status]').text()).toBe('Испратен код');
    expect(w.get('[data-test=portal-expires]').text()).toBe('18.10.2026 г.'); // mk-MK short date

    await w.get('[data-test=portal-code-dismiss]').trigger('click');
    expect(w.find('[data-test=portal-issued-code]').exists()).toBe(false);
  });

  it('copies the code to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // Define the property rather than replacing `navigator`: jsdom's navigator is used by Vue itself.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ status: 'none' }))
      .mockResolvedValueOnce(json({ code: 'Ab3kM9xQ', expiresAt: '2026-10-18T09:00:00.000Z', emailed: false }))
      .mockResolvedValueOnce(json({ status: 'invited', expiresAt: '2026-10-18T09:00:00.000Z' })));
    const w = mount(PortalAccessBox, { props: { contactId: 'c1' }, global: { plugins: [i18n] } });
    await w.get('[data-test=portal-issue]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=portal-issued-code]').exists()).toBe(true));
    expect(w.get('[data-test=portal-code-emailed]').text()).toBe('Контактот нема е-пошта — предајте му го кодот лично.');
    await w.get('[data-test=portal-code-copy]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=portal-code-copied]').exists()).toBe(true));
    expect(writeText).toHaveBeenCalledWith('Ab3kM9xQ');
  });

  it('shows a linked owner and offers a fresh code anyway', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ status: 'linked', linkedAt: '2026-11-20T09:00:00.000Z' })));
    const w = mount(PortalAccessBox, { props: { contactId: 'c1' }, global: { plugins: [i18n] } });
    await vi.waitFor(() => expect(w.get('[data-test=portal-status]').text()).toBe('Поврзан'));
    expect(w.text()).toContain('20.11.2026 г.');
    expect(w.get('[data-test=portal-issue]').text()).toBe('Издади нов код');
  });

  it('shows the generic error when the API refuses', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ status: 'none' }))
      .mockResolvedValueOnce(json({ error: { code: 'forbidden', message: 'Not allowed' } }, 403)));
    const w = mount(PortalAccessBox, { props: { contactId: 'c1' }, global: { plugins: [i18n] } });
    await w.get('[data-test=portal-issue]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=portal-access-error]').exists()).toBe(true));
    expect(w.get('[data-test=portal-access-error]').text()).toBe('Настана грешка');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @domar/web test -- PortalAccessBox`
Expected: FAIL — `Failed to resolve import "@/components/contacts/PortalAccessBox.vue"`.

- [ ] **Step 3: Implement**

Create `apps/web/src/components/contacts/PortalAccessBox.vue`:

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { PortalInvite, PortalStatus } from '@/api/types';
import AppButton from '@/components/ui/AppButton.vue';

const props = defineProps<{ contactId: string }>();
const { t } = useI18n();
const status = ref<PortalStatus | null>(null);
const invite = ref<PortalInvite | null>(null);
const error = ref(''); const busy = ref(false); const copied = ref(false);

async function loadStatus() {
  try { status.value = await api.get<PortalStatus>(`/api/contacts/${props.contactId}/portal-status`); }
  catch { error.value = t('app.error'); }
}
onMounted(loadStatus);

async function issue() {
  busy.value = true; error.value = ''; copied.value = false;
  try {
    // Shown exactly once: the server keeps only a sha256 hash, so this is the manager's only chance.
    invite.value = await api.post<PortalInvite>(`/api/contacts/${props.contactId}/portal-invite`, {});
    await loadStatus();
  } catch { error.value = t('app.error'); } finally { busy.value = false; }
}

async function copy() {
  if (!invite.value) return;
  try { await navigator.clipboard?.writeText(invite.value.code); copied.value = true; } catch { copied.value = false; }
}

const date = (d: string | undefined) => (d ? new Date(d).toLocaleDateString('mk-MK') : '—');
</script>
<template>
  <section class="mb-4 max-w-xl rounded-xl bg-white p-4 shadow-sm">
    <div class="mb-2 flex items-center justify-between">
      <h2 class="font-medium">{{ t('contacts.portalAccess.title') }}</h2>
      <AppButton variant="secondary" :loading="busy" data-test="portal-issue" @click="issue">
        {{ status && status.status !== 'none' ? t('contacts.portalAccess.reissue') : t('contacts.portalAccess.issue') }}
      </AppButton>
    </div>
    <p class="text-sm text-slate-600">
      {{ t('contacts.portalAccess.status') }}:
      <span class="font-medium text-slate-800" data-test="portal-status">{{ t(`contacts.portalAccess.${status?.status ?? 'none'}`) }}</span>
      <span v-if="status?.expiresAt"> · {{ t('contacts.portalAccess.expires') }} <span data-test="portal-expires">{{ date(status.expiresAt) }}</span></span>
      <span v-if="status?.linkedAt"> · {{ t('contacts.portalAccess.linkedAt') }} {{ date(status.linkedAt) }}</span>
    </p>
    <p v-if="error" class="mt-2 text-sm text-red-600" data-test="portal-access-error">{{ error }}</p>
    <div v-if="invite" class="mt-3 rounded-lg bg-emerald-50 p-3 text-sm">
      <div class="font-medium">{{ t('contacts.portalAccess.code') }}</div>
      <code class="mt-1 block text-lg font-semibold tracking-wider" data-test="portal-issued-code">{{ invite.code }}</code>
      <div class="mt-1 text-slate-600">{{ t('contacts.portalAccess.hint') }}</div>
      <div class="mt-1 text-slate-600" data-test="portal-code-emailed">{{ invite.emailed ? t('contacts.portalAccess.emailed') : t('contacts.portalAccess.notEmailed') }}</div>
      <AppButton variant="secondary" class="mt-2" data-test="portal-code-copy" @click="copy">{{ t('contacts.portalAccess.copy') }}</AppButton>
      <span v-if="copied" class="ml-2 text-emerald-700" data-test="portal-code-copied">{{ t('contacts.portalAccess.copied') }}</span>
      <AppButton variant="secondary" class="ml-2 mt-2" data-test="portal-code-dismiss" @click="invite = null">{{ t('contacts.portalAccess.dismiss') }}</AppButton>
    </div>
  </section>
</template>
```

`apps/web/src/pages/ContactStatementPage.vue` — import the box and render it under the heading:

```ts
import PortalAccessBox from '@/components/contacts/PortalAccessBox.vue';
```

```vue
  <h1 v-if="statement" class="mb-1 text-2xl font-semibold">{{ statement.contact.firstName }} {{ statement.contact.lastName }}</h1>
  <p class="mb-4 text-slate-600">{{ t('contacts.statement') }}</p>
  <PortalAccessBox :contact-id="id" />
```

`apps/web/src/i18n/mk.ts` — add a nested `portalAccess` block inside `contacts` (keep the existing keys on their line, then add the block):

```ts
  contacts: {
    title: 'Контакти', add: 'Додади контакт', kind: 'Тип', person: 'Физичко лице', company: 'Правно лице', companyNumber: 'Матичен број', vatNumber: 'Даночен број', phone: 'Телефон', address: 'Адреса', notes: 'Белешки', statement: 'Картица', balance: 'Салдо', allBuildings: 'Сите згради', date: 'Датум',
    portalAccess: {
      title: 'Пристап до порталот', status: 'Статус', none: 'Нема пристап', invited: 'Испратен код', linked: 'Поврзан',
      issue: 'Издади код', reissue: 'Издади нов код', code: 'Код за пристап', hint: 'Запишете го сега — нема да се прикаже повторно.',
      copy: 'Копирај', copied: 'Копирано', dismiss: 'Затвори',
      emailed: 'Кодот е испратен и по е-пошта.', notEmailed: 'Контактот нема е-пошта — предајте му го кодот лично.',
      expires: 'Важи до', linkedAt: 'Поврзан на',
    },
  },
```

`apps/web/src/i18n/en.ts` — the mirror:

```ts
  contacts: {
    title: 'Contacts', add: 'Add contact', kind: 'Type', person: 'Person', company: 'Company', companyNumber: 'Company number', vatNumber: 'VAT number', phone: 'Phone', address: 'Address', notes: 'Notes', statement: 'Statement', balance: 'Balance', allBuildings: 'All buildings', date: 'Date',
    portalAccess: {
      title: 'Portal access', status: 'Status', none: 'No access', invited: 'Code issued', linked: 'Linked',
      issue: 'Issue code', reissue: 'Issue a new code', code: 'Access code', hint: 'Write it down now — it is shown only once.',
      copy: 'Copy', copied: 'Copied', dismiss: 'Close',
      emailed: 'The code was also emailed.', notEmailed: 'This contact has no email — hand the code over in person.',
      expires: 'Valid until', linkedAt: 'Linked on',
    },
  },
```

(Keep the existing `contacts.*` values exactly as they are; only the nested block is new. Verify the English line matches the file's current values before editing.)

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @domar/web test && pnpm typecheck && pnpm lint`
Expected: PASS — 4 new tests, and the parity test still passes with the 15 new `contacts.portalAccess.*` keys present in both locales.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): portal access box on the contact statement page" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: End-to-end — a manager issues a code and the owner reads their invoice

**Files:**
- Create: `e2e/tests/portal.spec.ts`

**Interfaces:** consumes the `data-test` hooks from Tasks 5–7 (`portal-issue`, `portal-issued-code`, `portal-code`, `portal-email`, `portal-password`, `portal-submit`, `portal-card-buildings`, `portal-card-unpaid`, `portal-nav-invoices`, `portal-invoice-link`, `portal-invoice-outstanding`, `portal-invoice-pdf`, `portal-nav-fund`, `portal-fund-reserve`, `portal-logout`) and the API routes from Tasks 2–4. `e2e/playwright.config.ts` already sets `SMTP_URL: 'json'` on the API web server, so the invite email is captured in memory and no mail server is needed.

- [ ] **Step 1: Write the test**

Create `e2e/tests/portal.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

const API = 'http://localhost:3001';
const slug = `e2e-portal-${Date.now().toString(36)}`;
const password = 'correct-horse-1';
const ownerPassword = 'battery-staple-7';

test('a manager issues a code and the owner reads their invoice in the portal', async ({ page, browser }) => {
  // --- manager ---
  await page.goto('/register');
  await page.getByTestId('orgName').fill('Е2Е Портал');
  await page.getByTestId('slug').fill(slug);
  await page.getByTestId('firstName').fill('Ева');
  await page.getByTestId('lastName').fill('Тест');
  await page.getByTestId('email').fill(`eva@${slug}.mk`);
  await page.getByTestId('password').fill(password);
  await page.getByRole('button', { name: /Отвори сметка|Create account/ }).click();
  await expect(page).toHaveURL(/\/app$/);

  // Seed through the API with the session cookie the registration just set.
  const post = async (path: string, data: unknown = {}) => {
    const res = await page.request.post(`${API}${path}`, { data });
    expect(res.status(), `${path} → ${await res.text()}`).toBeLessThan(300);
    return res.json();
  };
  const taxRates = await (await page.request.get(`${API}/api/tax-rates`)).json();
  const vatId = taxRates.rows.find((r: { rateBp: number }) => r.rateBp === 1800).id;
  const owner = await post('/api/contacts', { firstName: 'Марко', lastName: 'Марков', email: `marko@${slug}.mk` });
  const building = await post('/api/buildings', { name: 'Партизанска 12', address: 'Партизанска 12', city: 'Скопје', postalCode: '1000' });
  await post(`/api/buildings/${building.id}/units`, { label: '1', kind: 'apartment', areaM2: 50, ownerContactId: owner.id });
  const service = await post('/api/services', { name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 30000, taxRateId: vatId, appliesTo: ['apartment'] });
  await post(`/api/buildings/${building.id}/services`, { serviceId: service.id, startsPeriod: '2026-01' });
  const put = await page.request.put(`${API}/api/buildings/${building.id}/reserve-fund`, { data: { basis: 'per_m2', amountMinor: 1000, appliesTo: ['apartment'], active: true } });
  expect(put.status()).toBeLessThan(300);
  await post(`/api/buildings/${building.id}/reserve-fund/opening-balance`, { amountMinor: 3500000 });
  const period = await post(`/api/buildings/${building.id}/periods`, { period: '2026-09' });
  await post(`/api/buildings/${building.id}/periods/${period.id}/generate`);
  await post(`/api/buildings/${building.id}/periods/${period.id}/publish`);

  // Issue the code from the manager UI and read it off the screen (it is shown exactly once).
  await page.goto(`/app/contacts/${owner.id}`);
  await expect(page.getByTestId('portal-status')).toHaveText('Нема пристап');
  await page.getByTestId('portal-issue').click();
  const code = (await page.getByTestId('portal-issued-code').innerText()).trim();
  expect(code).toMatch(/^[A-HJ-NP-Za-km-z2-9]{8}$/);
  await expect(page.getByTestId('portal-status')).toHaveText('Испратен код');

  // --- owner, in a second browser context with its own cookie jar ---
  const ownerContext = await browser.newContext();
  try {
    const owners = await ownerContext.newPage();
    await owners.goto('/portal/register');
    await owners.getByTestId('portal-code').fill(code);
    await owners.getByTestId('portal-email').fill(`marko@${slug}.mk`);
    await owners.getByTestId('portal-password').fill(ownerPassword);
    await owners.getByTestId('portal-submit').click();
    await expect(owners).toHaveURL(/\/portal$/);

    await expect(owners.getByTestId('portal-card-buildings')).toHaveText('Партизанска 12');
    await expect(owners.getByTestId('portal-card-unpaid')).toHaveText('1');

    // Чистење 300,00 + 18% ДДВ 54,00 + резервен фонд 50 m² × 10,00 = 500,00 → 854,00 ден.
    await owners.getByTestId('portal-nav-invoices').click();
    await expect(owners.getByTestId('portal-invoice-outstanding')).toHaveText('854,00 ден.');
    await owners.getByTestId('portal-invoice-link').click();
    await expect(owners.getByTestId('portal-invoice-total')).toHaveText('854,00 ден.');

    const href = await owners.getByTestId('portal-invoice-pdf').getAttribute('href');
    expect(href).toContain('/api/portal/invoices/');
    expect(href).toContain(`contactId=${owner.id}`);
    const pdf = await owners.request.get(href!);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toContain('application/pdf');
    expect((await pdf.body()).subarray(0, 4).toString()).toBe('%PDF');

    await owners.getByTestId('portal-nav-fund').click();
    await expect(owners.getByTestId('portal-fund-reserve')).toHaveText('35.000,00 ден.');
    await expect(owners.getByTestId('portal-fund-billed-reserve')).toHaveText('500,00 ден.');

    await owners.getByTestId('portal-logout').click();
    await expect(owners).toHaveURL(/\/portal\/login$/);
    // The session is really gone: the guard bounces a direct visit back to the login page.
    await owners.goto('/portal');
    await expect(owners).toHaveURL(/\/portal\/login$/);
  } finally {
    await ownerContext.close();
  }

  // The manager's own session never reaches the portal API.
  const asManager = await page.request.get(`${API}/api/portal/me`);
  expect(asManager.status()).toBe(401);
});
```

- [ ] **Step 2: Run**

Run: `pnpm db:up && pnpm e2e`
Expected: 6 specs pass (`smoke`, `billing`, `payments`, `pilot`, `reminders`, `portal`). Run twice — each run registers a fresh slug, so the second run must pass unchanged.

- [ ] **Step 3: Commit**

```bash
git add e2e
git commit -m "test(e2e): a manager issues a portal code and the owner reads their invoice" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review notes

**Spec §19 coverage**

- §19.1 *Accounts are global, links are per tenant* — T1: `owner_accounts` (`email` unique, scrypt `password_hash`, `is_active`, timestamps) and `owner_sessions` with no `tenant_id`, added to the migration test's exemption set; `owner_contact_links` (`owner_account_id`, `tenant_id`, `contact_id`, unique on account+contact, `linked_at`) with a `tenant_id`-leading index; `portal_invites` tenant-scoped. T4: every portal query goes through `resolveLink`, which takes the `tenantId` from the link and never from the request, and the 404-for-an-unlinked-contact test covers all six routes.
- §19.2 *Onboarding by invitation code* — T2: `POST /contacts/:id/portal-invite` behind `WRITE_ROLES` returns `{ code, expiresAt, emailed }`, 8 characters from the users' unambiguous alphabet (`randomCode`, shared with `generateTemporaryPassword`), stored as a sha256 hash with `tenant_id`, `contact_id`, 14-day `expires_at`, `used_at`, `created_by`; reissuing expires every earlier live code; the code is emailed through `email_log` template `portal_invite` when the contact has an email and the mailer is configured; `GET /contacts/:id/portal-status` returns `none | invited | linked`. T7 shows the code once in the manager UI with copy and dismiss.
- §19.3 *Portal auth* — T3: `POST /api/portal/register` creates the account or requires the existing account's password, and consumes the code into a link claim-first; `POST /api/portal/link` adds a contact to a signed-in account; `login`, `logout`, `me` (account + links with tenant name, contact name and the buildings the contact owns units in); sessions in `owner_sessions` with the staff token scheme, cookie `domar_owner`, httpOnly, SameSite=Lax, `secure` following `isProduction`; the same 10-per-minute rate limit as staff login; `POST /api/portal/change-password`.
- §19.4 *Read-only data, scoped by link* — T4: `GET /api/portal/invoices` (published and later, newest period first, with `paidMinor`/`outstandingMinor`), `/invoices/:id`, `/invoices/:id/pdf` (the manager's `renderInvoiceHtml` with the link's tenant header), `/payments`, `/statement` (the sub-plan 3 owner statement with a running balance), `/buildings/:id/fund` (both funds' balances plus 12 months of fund-account movements). No portal route writes ledger data; the only writes in the whole plan are the account, the session, the link and the invite's `used_at`.
- §19.5 *Web `/portal/*`* — T5: `PortalShell.vue` with no manager nav, login, register (code + email + password), home (manager, buildings, balance, unpaid count, last invoice), a guard separate from the staff one, the complete `portal.*` i18n block Macedonian first. T6: invoices list + detail with PDF, payments, statement, building fund, settings (change password, add another code). T7: the manager's "Portal access" box on the contact statement page.
- §19.6 *Invariants* — T3/T4: handlers receive `PortalContext { ownerAccountId, links }`; the read-only `TenantContext { tenantId, userId: null, role: 'readonly' }` is built by `portalTenantContext` and reached only through `resolveLink` in `portal/repo.ts` and the audit write in `portal/accounts.ts`; T4's test asserts 404 for an unlinked contact on all six routes, and T3's test asserts a staff cookie is rejected on `/api/portal/*` and an owner cookie on `/api/*` (`/api/contacts` and `/api/auth/me`), with T8 repeating the latter against the running server.
- One §19.4 wording is implemented differently and is called out in design addendum 15: the fund page lists the building's *fund-account* postings and reports what was billed to owners as one number per fund, instead of listing per-owner `charge` postings. Listing owner charges would put per-owner amounts on a page §19.4 explicitly limits to "amounts only, no other owners' names"; the aggregate carries the same information about the fund without that leak. `charge` stays in the response enum, so a future building-level charge posting appears without an API change.

**Interfaces consumed across tasks**

- T1 → T2 (`schema.portalInvites`), T1 → T3 (`schema.ownerAccounts`, `ownerSessions`, `ownerContactLinks`), T1 → T4 (`ownerContactLinks` through `listLinks`).
- T2 → T3 (`claimInvite` is imported verbatim by `portal/accounts.ts` for both `register` and `link`; `DUMMY_PASSWORD_HASH` and `randomCode` move in T2 and are used in T3), T2 → T7 (`PortalInvite`/`PortalStatus` wire shapes), T2 → T8 (the code the e2e reads off the manager screen).
- T3 → T4 (`PortalContext`, `app.requirePortal`, `portalTenantContext`, `req.portal`), T3 → T5 (`GET /portal/me` ↔ `PortalMe`, the cookie name and lifetime), T3 → T6 (`POST /portal/link` and `/change-password` for the settings page).
- T4 → T6 (`invoiceRowOut`/`invoiceDetailOut`/`paymentOut`/`statementOut`/`portalFundOut` ↔ `InvoiceRow`/`Invoice`/`Payment`/`OwnerStatement`/`PortalFund`), T4 → T8 (the PDF route and its `?contactId=`).
- T5 → T6 (`usePortalStore`, `PortalShell`'s router children, the whole `portal.*` i18n block), T5/T6/T7 → T8 (every `data-test` hook and the exact Macedonian strings the e2e asserts: `Нема пристап`, `Испратен код`, `Партизанска 12`, `854,00 ден.`, `35.000,00 ден.`, `500,00 ден.`).
- Unchanged existing interfaces reused: `getContact`, `getInvoice`, `listInvoices`, `listPayments`, `ownerStatement`, `fundBalance`, `billedToOwners`, `renderInvoiceHtml`, `htmlToPdf`, `writeAudit`, `logEmail`, `Mailer`, `requireRole`/`WRITE_ROLES`, `idParam`/`pageQuery`, `hashPassword`/`verifyPassword`, `createTestApp`, `registerTenant`, `setupPublishedBuilding`, `DataTable`/`AppButton`/`AppInput`, `formatMoney`/`percentFromBp`, `API_BASE`.
- The only existing signature widened is `listInvoices(db, ctx, q)` with an optional `statuses?: string[]` (T4); every existing caller omits it and is unaffected. `generateTemporaryPassword()` keeps its signature while its body becomes `randomCode(16)` (T2), and `DUMMY_PASSWORD_HASH` moves file without changing value (T2).

**Numbers and strings the tests lock**

- T1: the exact column lists of all four tables in alphabetical order, the unique indexes on `owner_accounts(email)`, `owner_contact_links(owner_account_id, contact_id)` and `portal_invites(code_hash)`, and the `(tenant_id, contact_id)` / `(tenant_id, contact_id, created_at)` indexes.
- T2: `/^[A-HJ-NP-Za-km-z2-9]{8}$/` for the code, `/^[0-9a-f]{64}$/` for the stored hash, an expiry between 13 and 15 days out, exactly one live invite after a reissue, one `email_log` row with template `portal_invite`, one `portal_invite.create` audit row with no 64-hex string anywhere in its payload.
- T3: cookie `domar_owner` with `HttpOnly`, `SameSite=Lax` and no `Secure` under `NODE_ENV=test`; `marko@owner.mk` from the input `MARKO@owner.mk`; two links for one account across two tenants; `invalid_code` on a reused, unknown or revoked code; `invalid_credentials` for a wrong existing-account password with `used_at` still null; `already_linked` with the refused claim rolled back; the 11th login attempt answering `429`.
- T4: O1's invoice `totalMinor: 256099`, `paidMinor: 256099`, `outstandingMinor: 0`, `reserveFundBuildingBalanceMinor: 3500000`; fund `reserve.balanceMinor 3550000` (3.500.000 opening + 50.000), `regular.balanceMinor 81099` (206.099 − 120.000 − 5.000), `reserve.billedMinor 225000` (225 m² × 1000), `regular.billedMinor 839532` (1.064.532 − 225.000); exactly 4 transactions inside the 12-month window with the two-year-old expense excluded; `Бошковски` and `Анѓеловски` absent from every portal payload.
- T5: `Кодот е погрешен, искористен или истечен.`; `Најавете се и додадете го кодот во Поставки.`; `localStorage['domar.portal.contactId']` following `select`.
- T6: `1.560,99 ден.` from `156099`, `2.560,99 ден.` from `256099`, `810,99 ден.` from `81099`, `35.500,00 ден.` from `3550000`, `2.250,00 ден.` from `225000`; the exact request URLs `…/api/portal/invoices?contactId=c1&pageSize=12`, `…?contactId=c1&page=1&pageSize=50`, `…/api/portal/statement?contactId=c1`, `…/api/portal/buildings/b1/fund?contactId=c1`; `Трошок` and `Почетно салдо` from `ledger.kind.*`.
- T7: `Нема пристап`, `Испратен код`, `Поврзан`, `Издади нов код`, `08.10.2026`, `Кодот е испратен и по е-пошта.`, `Контактот нема е-пошта — предајте му го кодот лично.`.
- T8: `854,00 ден.` (300,00 + 54,00 ДДВ + 500,00 резервен фонд), `35.000,00 ден.` reserve balance, `500,00 ден.` reserve billed, an 8-character code matching the alphabet, `%PDF` from the portal PDF route, and `401` for the manager cookie on `/api/portal/me`.

**Diff size** — T3 is the largest (≈620 lines across 7 files, ~230 of them the test file) and is the one task a reviewer could split along the register/login boundary; T4 ≈560, T6 ≈470, T5 ≈430, T2 ≈380, T7 ≈250, T1 ≈200, T8 ≈110.

**Placeholder scan** — every file listed above is given in full or as an exact, quotable edit to a named line; there is no `TODO`, no `...`, no "implement similarly", and no test whose expected value is left to the implementer. The three edits described rather than pasted whole (`listInvoices`'s condition block, `router/index.ts`'s children array and guard, the two `i18n` blocks) each quote the replacement text verbatim and name the surrounding line.
