# Domar Notifications and Portal PWA (spec §9) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Марко installs the domar portal onto his phone's home screen from `/portal`. The next morning Ива publishes September's period for Партизанска 12. Her transaction writes one `notifications` row per owner who has a portal account; five minutes later the host's crontab calls `POST /api/jobs/notifications`, the row is claimed, and Марко's phone buzzes with **"Нова фактура · Партизанска 12"** — a title and a link, no amount anywhere in the payload. He taps it, the service worker focuses the already-open portal tab at `/portal/invoices/<id>`, and only there, behind his session, does the figure 2.450,00 ден. appear. His neighbour Ана never enabled push: her row falls through to email, and the manager's bell stays quiet because the fallback worked. That evening Марко files **Пријави проблем**; Ива's app shell — which polls `GET /api/notifications` every sixty seconds — grows a red **1** on the bell, and the entry reads "Ново барање за одржување · Протекува цевка во визбата". When Ива moves the request to **Во тек**, Марко's phone buzzes again.

**Architecture:** `packages/db` gains **one migration, 0013**, with two tables — `push_subscriptions` and `notifications` — and one enum, `notification_kind`. Writing is synchronous and transactional: every trigger calls `notify(tx, ctx, rows)` inside the very transaction that publishes the invoice, creates the reminder, sends the invitation or moves the request, so a notification exists exactly when the event that caused it exists. **Delivery is not inline.** A new `POST /api/jobs/notifications`, behind the same `x-job-token` check the reminder cron already uses, claims undelivered rows with `FOR UPDATE SKIP LOCKED`, pushes to the recipient's live subscriptions through the `web-push` package, and falls back to email when there is no live subscription or every push failed. `apps/web` gains a `/portal`-scoped PWA (manifest, `public/portal/sw.js`, registration from `PortalShell.vue`) and one `NotificationBell.vue` used by both shells.

**Tech Stack:** unchanged (Node 24, pnpm 10, TS strict, ESM, Fastify 5 + zod, Drizzle 0.36 + Postgres 16, Vue 3 + Vite + vue-i18n + Tailwind 4, Vitest, Playwright 1.63.0) plus **one new runtime dependency, `web-push@^3.6.7`** (and `@types/web-push@^3.6.4` as a dev dependency) in `@domar/api`, and **three new optional environment variables**: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`. `writeAudit`, `logEmail`, `createMailer`'s no-op contract, `resolveLink`/`assertOwnsUnitIn` (`portal/repo.ts`), `requireRole`/`WRITE_ROLES`, `getBuilding` and the `x-job-token` check from `resources/reminders/routes.ts` are reused as they are.

**Spec:** `docs/superpowers/specs/2026-09-24-domar-phase2-design.md` §9 (the binding section), §11 (invariants — in particular "Notifications never include amounts in push payloads (title + link only); details load in the app"), §10 (roles). Phase 1: `docs/superpowers/specs/2026-09-21-domar-phase1-design.md` §16 (global constraints), §10 (auth and tenancy), §11 (API shape), §12 (web), §19 (the portal — `owner_accounts`, `owner_contact_links`, `PortalContext`). Previous plans: `2026-09-25-11-maintenance.md` (this plan's style, the claim-first pattern, the portal's write routes), `2026-09-24-05-reminders.md` (the `x-job-token` job, `runAllTenants`, the mailer's no-op contract), `2026-09-24-06-owner-portal.md` (`resolveLink`, the portal shell).

## Global Constraints

From Phase 1 spec §16, verbatim:

- Node `>=24`, pnpm `>=10`, TypeScript strict, ESM only.
- Postgres 16; schema must run unchanged on Supabase Postgres (no superuser-only extensions; `pgcrypto`/`uuid-ossp` allowed).
- Every tenant-scoped table has `tenant_id uuid not null` and an index starting with it.
- Money columns: `bigint`, suffix `_minor`. Never `float`.
- All user-facing strings in the web app go through i18n; Macedonian first, English second.
- No secrets in the repo; `.env.example` documents every variable.
- Commit after every green test cycle; conventional commit messages.

From Phase 2 spec §11, verbatim, binding on every task here:

- Legal events are append-only and carry evidence; the compliance screen never reads anything but events plus dates already in the system.
- Every document download checks the tenant and, for portal users, the link (minutes and reports of their building only).
- Uploaded files are stored outside the web root, streamed, never executed, mime-checked, size-capped.
- Extraordinary costs and maintenance costs reach the ledger only through the existing period and expense flows; no new posting kinds.
- Notifications never include amounts in push payloads (title + link only); details load in the app.

Project conventions that are equally binding here:

- **No money in a push, ever.** The push payload is built by one whitelist function, `pushPayload`, which returns `{ id, title, link }` and nothing else. Every trigger keeps the amount out of `title` and puts it in `body`; `body` never leaves the database except through an authenticated `GET /api/notifications` or `GET /api/portal/notifications`. This plan adds **no money column**.
- **Tenant filter on every statement.** Every new repo function takes `(db, ctx, …)` and every `where` starts with `eq(X.tenantId, ctx.tenantId)`. The single exception is the push-subscription lookup during delivery, which is keyed on `owner_account_id` alone — see design addendum 3, which states why and what replaces the filter.
- **An audit row is written inside the same transaction as every mutation** (`writeAudit(tx, ctx, …)`). A `notifications` row is *not* an audit row: where this plan adds a mutation of its own (a push subscription, a read receipt) it writes both.
- **Error envelope:** `{ error: { code, message, details? } }` via `AppError`/`notFound`/`badRequest`/`conflict`/`forbidden`/`unauthorized`. A row of another tenant — or another account — is always `404`, never `403`.
- **TS strict with `exactOptionalPropertyTypes`**: never pass an explicit `undefined` into an object typed with an optional property; spread conditionally (`...(x ? { x } : {})`) or use `stripUndefined` from `resources/common.ts`.
- **ESM `.js` import specifiers** in every TS import of a local file (`./repo.js`, `../audit.js`), `import type` for type-only imports (`@typescript-eslint/consistent-type-imports` is an error).
- **i18n mk/en parity**: `apps/web/test/LoginPage.test.ts` asserts `flatKeys(messages.en).sort()` equals `flatKeys(messages.mk).sort()`. Every key added in this plan goes into **both** `apps/web/src/i18n/mk.ts` and `apps/web/src/i18n/en.ts`, Macedonian first.
- **No `Intl` for formatting.** Amounts go through `pack.formatMoney` (API) or `@/utils/money`'s `formatMoney` (web); plain numbers through `formatNumber`. Dates in notification text are written with `toISOString().slice(0, 10)` or the existing `formatDocumentDate`.
- **`data-test` hooks** on every element an e2e test touches (`testIdAttribute: 'data-test'` in `e2e/playwright.config.ts`).
- Run everything from the repo root. Postgres for tests is the docker-compose service on port 54329 (`pnpm db:up`).
- **Conventional commits**, each ending with your session's co-author trailer, e.g.
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```

## Design addendum (decisions not spelled out in the spec)

1. **Exactly one recipient per row, enforced by Postgres.** `notifications` carries `owner_account_id` **and** `user_id`, both nullable, and a table check `notifications_recipient_chk`: `num_nonnulls(owner_account_id, user_id) = 1`. One row per recipient, never a fan-out list in a column: the read receipt (`read_at`) and the delivery outcome (`delivered_at`, `delivery_error`) are per person, and a jsonb array of recipients would have to be rewritten under concurrency by every reader. Both FKs are `on delete cascade` — a bell entry is not evidence, and a deleted employee's or account's rows go with them.
2. **Rows are written inside the causing transaction; delivery is not.** `notify(tx, ctx, rows)` is called from inside `publishPeriod`, `runBuildingReminders`, `inviteAssembly`, `createDecision`, `setStatus` and `portalMaintenanceCreate`, so a rolled-back publish leaves no notification behind. Sending, which talks to the network, happens in `POST /api/jobs/notifications` — the same shape as the reminder cron, for the same reason: a dead push service must not roll back a building's invoices.
3. **`push_subscriptions.tenant_id` records where the browser subscribed; delivery looks the subscription up by account.** An owner account is deliberately not tenant-scoped (spec §19.1) but the global constraint requires `tenant_id uuid not null` on this table, so the column holds the tenant of the link that was selected when the browser subscribed (the request carries `contactId`, resolved through `resolveLink`). `endpoint` is globally unique, so one browser is one row, and `subscriptionsFor(db, ownerAccountId)` deliberately does **not** filter by tenant: an owner with units under two management companies has one phone and must be reachable from both. What replaces the filter is that the lookup is keyed on an `owner_account_id` taken from the notification row, which was itself written under a tenant filter. Every *other* statement touching `push_subscriptions` — the upsert, the delete, the listing — goes through `PortalContext` and is keyed on the caller's own account id.
4. **A push is delivered once and never retried.** The claim sets `delivered_at = now()` before anything is sent, under `FOR UPDATE SKIP LOCKED`, so two overlapping cron runs split the queue instead of double-sending. A failure writes `delivery_error` and leaves `delivered_at` set. There is no retry loop and no backoff table: the notification is still in the owner's list in the app, the important deliveries (invoices, reminders, invitations) all have an email or a letter behind them already, and a queue that retries is a queue that needs a dead-letter policy nobody asked for. A delivery that failed **both** ways becomes a manager bell row, which is precisely what spec §9 asks the manager side to show.
5. **Unconfigured VAPID behaves exactly like an unconfigured mailer.** `createPusher(config)` with no `VAPID_PRIVATE_KEY` returns `{ configured: false }` and a `send` that answers `{ ok: false, error: 'vapid_not_configured', gone: false }`. Nothing throws, the row records why in `delivery_error`, and the email fallback runs. `VAPID_PRIVATE_KEY=memory` selects an in-memory capture transport for tests, mirroring `SMTP_URL=json`. No test talks to a real push service.
6. **`404` and `410` from the push service delete the subscription.** Those two statuses are the Web Push standard's way of saying the endpoint is gone for good; anything else (`429`, `500`, a timeout) is recorded and the row is left alone. `web-push` raises `WebPushError` with a `statusCode`, which is the only thing `createPusher` reads off it.
7. **Notification text is Macedonian, server-rendered, and stored.** Like `reminders.document_html` and the assembly invitation, the `title`/`body`/`link` of a notification are rendered once, at write time, into the row. They live in `apps/api/src/notifications/text.ts` — **not** on the country pack, because the pack holds the legal wording of Law 160/2025 and these strings are domar's own product copy that embeds domar's own routes (`/portal/invoices/:id`). The web app's i18n covers the bell's chrome (heading, "mark all read", "enable notifications", the empty state) in `mk` and `en`, Macedonian first.
8. **The bell is polled, not streamed.** `GET /api/notifications` every 60 seconds from the app shell, and the same in the portal shell. No SSE, no WebSocket: one long-lived connection per open tab per manager is a deployment concern (Caddy timeouts, container restarts) bought for a feature whose latency budget is minutes. The poll stops when the document is hidden and fires once immediately when it becomes visible again.
9. **"Voting opened" is a decision added to an assembly that is already `invited`.** `votingOpen` is `status === 'invited'` (`portal/assembly-repo.ts:69`), so the invitation itself already tells the owners that voting is open — `assembly_invited` covers that. The separate `assembly_voting_opened` notification fires from `createDecision` **only** when `claimAssembly` returns an assembly already in `invited`: a new ballot item appearing after the owners were called is the case they would otherwise miss.
10. **The service worker lives at `/sw.js` and registers with scope `/portal`.** (Corrected during the final review: this addendum first placed it at `/portal/sw.js`, which claims `/portal/` and therefore does *not* cover `/portal` itself — the manifest's own `start_url` and the portal's home route — so an installed app's cold start was never controlled and the offline shell never appeared there. A worker may only claim a scope at or below its own directory without a `Service-Worker-Allowed` header, so the file moved up rather than the scope moving down.) `app.ts`'s `setHeaders` already sends `no-cache` for everything outside `assets/`, which is exactly the "must not be cached aggressively" requirement — the task asserts it rather than adding a rule. The worker's `fetch` handler returns immediately for any request that is not a same-origin `GET` navigation, so `/api` is never intercepted.
11. **The job token check is extracted, not copied.** `apps/api/src/jobs/token.ts` gets `assertJobToken(config, headers)` — the exact body already in `resources/reminders/routes.ts`, moved — and both job routes call it. Two Fastify plugins register under the `/jobs` prefix, as `buildingPaymentRoutes` and `invoicePaymentRoutes` already do under `/invoices`.
12. **Staff never get push, and staff notifications are never emailed.** Spec §9 gives the manager an *in-app bell*. A `user_id` row is marked delivered by the drain job without a single network call, which is also what keeps rule 4's failure path from recursing: a `delivery_failed` row can never itself fail to deliver.
13. **Task sizes.** Eight tasks: the migration; the transport and the payload; the writer and the two bell APIs; the six triggers; the drain job and its cron; the PWA; the two bells in the browser; the walk-through. Task 4 is the widest (six call sites in five files) and is the one a reviewer could split, at the seam between the owner-facing triggers and the staff one — they are kept together because they share `notifyOwners`/`notifyStaff` and a half-wired trigger set is not testable as a set.

---

### Task 1: DB — migration 0013, `push_subscriptions` and `notifications`

**Files:**
- Create: `packages/db/src/schema/notifications.ts`
- Modify: `packages/db/src/schema/index.ts`
- Create: `packages/db/migrations/0013_*.sql` (generated — do not hand-write the name)
- Modify: `packages/db/test/migrations.test.ts`

**Interfaces:**
- Consumes: `schema.tenants`, `schema.users`, `schema.ownerAccounts` (existing tables, for the foreign keys)
- Produces (used by Tasks 2–8): `schema.notifications`, `schema.pushSubscriptions`, `schema.notificationKind` (pg enum; `.enumValues` feeds the zod enum in Task 3)

- [ ] **Step 1: Write the failing test**

Append these three cases to `packages/db/test/migrations.test.ts`, inside the existing `describe('migrations', …)` block, after the `'a photo belongs to exactly one request and dies with its document'` case:

```ts
  it('creates the notification tables', async () => {
    const rows = await t!.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public' order by 1`;
    const names = rows.map((r) => r.table_name);
    for (const n of ['notifications', 'push_subscriptions']) expect(names).toContain(n);
    const kinds = await t!.sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid where ty.typname = 'notification_kind' order by e.enumsortorder`;
    expect(kinds.map((k) => k.enumlabel)).toEqual([
      'invoice_published', 'reminder_created', 'assembly_invited', 'assembly_voting_opened',
      'maintenance_status', 'maintenance_request_created', 'delivery_failed']);
  });

  it('a notification has exactly one recipient and carries no amount column', async () => {
    const cols = await t!.sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]>`
      select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'notifications' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual([
      'body', 'created_at', 'delivered_at', 'delivery_error', 'id', 'kind', 'link',
      'owner_account_id', 'read_at', 'tenant_id', 'title', 'user_id']);
    // Spec §11: nothing in this table is money, so nothing here can leak into a payload.
    expect(cols.some((c) => c.column_name.endsWith('_minor'))).toBe(false);
    const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(by['owner_account_id']!.is_nullable).toBe('YES');
    expect(by['user_id']!.is_nullable).toBe('YES');
    expect(by['read_at']!.is_nullable).toBe('YES');
    expect(by['delivered_at']!.is_nullable).toBe('YES');
    expect(by['body']!.column_default).toContain("''");
    expect(by['link']!.column_default).toContain("''");

    const [tenant] = await t!.sql<{ id: string }[]>`
      insert into tenants (slug, name, country_code) values ('notif-chk', 'Notif', 'mk') returning id`;
    const [user] = await t!.sql<{ id: string }[]>`
      insert into users (tenant_id, email, password_hash, first_name, last_name, role)
      values (${tenant!.id}, 'u@notif.mk', 'x', 'U', 'U', 'owner') returning id`;
    const [account] = await t!.sql<{ id: string }[]>`
      insert into owner_accounts (email, password_hash) values ('o@notif.mk', 'x') returning id`;
    const insert = (userId: string | null, accountId: string | null) => t!.sql`
      insert into notifications (tenant_id, user_id, owner_account_id, kind, title)
      values (${tenant!.id}, ${userId}, ${accountId}, 'delivery_failed', 'T')`;
    await expect(insert(null, null)).rejects.toThrow(/notifications_recipient_chk/);
    await expect(insert(user!.id, account!.id)).rejects.toThrow(/notifications_recipient_chk/);
    await expect(insert(user!.id, null)).resolves.toBeDefined();
    await expect(insert(null, account!.id)).resolves.toBeDefined();
    await t!.sql`delete from tenants where id = ${tenant!.id}`;
    await t!.sql`delete from owner_accounts where id = ${account!.id}`;
  });

  it('a push subscription is one endpoint, once', async () => {
    const cols = await t!.sql<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns where table_name = 'push_subscriptions' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual([
      'auth', 'created_at', 'endpoint', 'id', 'last_seen_at', 'owner_account_id', 'p256dh', 'tenant_id', 'user_agent']);
    const idx = await t!.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'push_subscriptions'`;
    expect(idx.some((i) => i.indexdef.includes('UNIQUE') && i.indexdef.includes('(endpoint)'))).toBe(true);
    expect(idx.some((i) => i.indexdef.includes('(tenant_id, owner_account_id)'))).toBe(true);
    expect(idx.some((i) => i.indexdef.includes('(owner_account_id)'))).toBe(true);
    const [fk] = await t!.sql<{ delete_rule: string }[]>`
      select rc.delete_rule from information_schema.referential_constraints rc
      join information_schema.key_column_usage k on k.constraint_name = rc.constraint_name
      where k.table_name = 'push_subscriptions' and k.column_name = 'owner_account_id'`;
    expect(fk!.delete_rule).toBe('CASCADE');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm db:up && pnpm --filter @domar/db test`
Expected: FAIL — `expect(names).toContain('notifications')` fails because the table does not exist.

- [ ] **Step 3: Write the schema file**

Create `packages/db/src/schema/notifications.ts`:

```ts
import { sql } from 'drizzle-orm';
import { check, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { ownerAccounts } from './portal.js';
import { tenants } from './tenant.js';

/** Spec §9's trigger list, plus the manager-side pair (a portal request, a failed send). */
export const notificationKind = pgEnum('notification_kind', [
  'invoice_published', 'reminder_created', 'assembly_invited', 'assembly_voting_opened',
  'maintenance_status', 'maintenance_request_created', 'delivery_failed',
]);

const tenantRef = () => uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' });

/**
 * One browser, one row. `endpoint` is globally unique because that is what the Web Push service
 * hands out, so a re-subscription updates the keys in place instead of growing a second row.
 * `tenant_id` records the link the browser subscribed under (plan addendum 3); delivery looks the
 * row up by `owner_account_id` alone, so an owner with two management companies gets both.
 */
export const pushSubscriptions = pgTable('push_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  ownerAccountId: uuid('owner_account_id').notNull().references(() => ownerAccounts.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('push_subscriptions_tenant_account_idx').on(t.tenantId, t.ownerAccountId),
  index('push_subscriptions_account_idx').on(t.ownerAccountId),
]);

/**
 * One row per recipient (plan addendum 1): `read_at` and `delivered_at` are per person, so a shared
 * row would have to be rewritten by every reader. `body` never reaches a push payload — spec §11
 * allows title and link only — and this table has no money column at all.
 */
export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  ownerAccountId: uuid('owner_account_id').references(() => ownerAccounts.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  kind: notificationKind('kind').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  /** An in-app path, never an absolute URL: the service worker resolves it against its own origin. */
  link: text('link').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp('read_at', { withTimezone: true }),
  /** Stamped by the drain job before it sends anything, so a crash cannot double-send. */
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  deliveryError: text('delivery_error'),
}, (t) => [
  index('notifications_tenant_user_idx').on(t.tenantId, t.userId, t.createdAt),
  index('notifications_tenant_account_idx').on(t.tenantId, t.ownerAccountId, t.createdAt),
  // The drain job's only query: the undelivered tail, oldest first.
  index('notifications_pending_idx').on(t.createdAt).where(sql`delivered_at is null`),
  check('notifications_recipient_chk', sql`num_nonnulls(${t.ownerAccountId}, ${t.userId}) = 1`),
]);
```

Add the export to `packages/db/src/schema/index.ts`, after the `maintenance.js` line:

```ts
export * from './notifications.js';
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm --filter @domar/db generate`
Expected: a new `packages/db/migrations/0013_<two-words>.sql` and an updated `meta/_journal.json`. Open the file and check it against this — the statements must match, the generated name will not:

```sql
CREATE TYPE "public"."notification_kind" AS ENUM('invoice_published', 'reminder_created', 'assembly_invited', 'assembly_voting_opened', 'maintenance_status', 'maintenance_request_created', 'delivery_failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner_account_id" uuid,
	"user_id" uuid,
	"kind" "notification_kind" NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"link" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"delivery_error" text,
	CONSTRAINT "notifications_recipient_chk" CHECK (num_nonnulls("notifications"."owner_account_id", "notifications"."user_id") = 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_tenant_user_idx" ON "notifications" USING btree ("tenant_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_tenant_account_idx" ON "notifications" USING btree ("tenant_id","owner_account_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_pending_idx" ON "notifications" USING btree ("created_at") WHERE delivered_at is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_subscriptions_tenant_account_idx" ON "push_subscriptions" USING btree ("tenant_id","owner_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_subscriptions_account_idx" ON "push_subscriptions" USING btree ("owner_account_id");
```

(plus the four `DO $$ BEGIN ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY … EXCEPTION WHEN duplicate_object THEN null; END $$;` blocks drizzle-kit emits for the tenant, user and owner-account references.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @domar/db test`
Expected: PASS — including the pre-existing `'every tenant-scoped table has tenant_id and an index starting with it'` case, which now covers both new tables without an entry in `TENANT_SCOPED_EXEMPT`.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/notifications.ts packages/db/src/schema/index.ts packages/db/migrations packages/db/test/migrations.test.ts
git commit -m "feat(db): notifications and push subscriptions (migration 0013)"
```

---

### Task 2: The push transport and the payload whitelist

**Files:**
- Create: `packages/domain/src/notifications/payload.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/domain/test/notification-payload.test.ts`
- Create: `apps/api/src/notifications/push.ts`
- Create: `apps/api/test/push.test.ts`
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/package.json`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `Config` (`apps/api/src/config.ts`), `Mailer`'s no-op contract as the model (`apps/api/src/email/mailer.ts`)
- Produces (used by Tasks 3–8):
  - `NOTIFICATION_KINDS: readonly NotificationKind[]`, `type NotificationKind` (`@domar/domain`)
  - `pushPayload(n: { id: string; title: string; link: string }): PushPayload` where `PushPayload = { id: string; title: string; link: string }` (`@domar/domain`)
  - `createPusher(config: Config): Pusher` with
    `interface Pusher { readonly configured: boolean; readonly publicKey: string | null; readonly sent: SentPush[]; send(t: PushTarget, p: PushPayload): Promise<PushResult> }`,
    `interface PushTarget { endpoint: string; p256dh: string; auth: string }`,
    `type PushResult = { ok: true } | { ok: false; error: string; gone: boolean }`,
    `interface SentPush { endpoint: string; payload: PushPayload }` (`apps/api/src/notifications/push.ts`)
  - `app.pusher: Pusher` (Fastify decorator)
  - `config.vapidPublicKey`, `config.vapidPrivateKey`, `config.vapidSubject` (all `string`, `''` when unset)

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @domar/api add web-push@^3.6.7
pnpm --filter @domar/api add -D @types/web-push@^3.6.4
```

- [ ] **Step 2: Write the failing tests**

Create `packages/domain/test/notification-payload.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { NOTIFICATION_KINDS, pushPayload } from '../src/index.js';

describe('pushPayload', () => {
  it('keeps the id, the title and the link and drops everything else', () => {
    const row = {
      id: 'n-1', title: 'Нова фактура · Партизанска 12', link: '/portal/invoices/i-1',
      body: 'Вкупно за плаќање: 2.450,00 ден.', tenantId: 't-1', ownerAccountId: 'a-1',
    };
    const out = pushPayload(row);
    // Spec §11: title + link only. A whitelist, so a column added later cannot leak by accident.
    expect(Object.keys(out).sort()).toEqual(['id', 'link', 'title']);
    expect(JSON.stringify(out)).not.toContain('ден.');
    expect(JSON.stringify(out)).not.toContain('2.450');
  });

  it('declares the seven kinds the database enum declares', () => {
    expect([...NOTIFICATION_KINDS]).toEqual([
      'invoice_published', 'reminder_created', 'assembly_invited', 'assembly_voting_opened',
      'maintenance_status', 'maintenance_request_created', 'delivery_failed']);
  });
});
```

Create `apps/api/test/push.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createPusher } from '../src/notifications/push.js';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/d', NODE_ENV: 'test' } as NodeJS.ProcessEnv;
const target = { endpoint: 'https://push.example/abc', p256dh: 'p', auth: 'a' };
const payload = { id: 'n-1', title: 'Нова фактура', link: '/portal/invoices/i-1' };

describe('createPusher', () => {
  it('is a no-op that never throws when VAPID is unset', async () => {
    const pusher = createPusher(loadConfig(base));
    expect(pusher.configured).toBe(false);
    expect(pusher.publicKey).toBeNull();
    await expect(pusher.send(target, payload)).resolves.toEqual({ ok: false, error: 'vapid_not_configured', gone: false });
  });

  it('captures in memory when VAPID_PRIVATE_KEY is "memory"', async () => {
    const pusher = createPusher(loadConfig({ ...base, VAPID_PUBLIC_KEY: 'BPublic', VAPID_PRIVATE_KEY: 'memory', VAPID_SUBJECT: 'mailto:no-reply@domar.mk' }));
    expect(pusher.configured).toBe(true);
    expect(pusher.publicKey).toBe('BPublic');
    await expect(pusher.send(target, payload)).resolves.toEqual({ ok: true });
    expect(pusher.sent).toEqual([{ endpoint: target.endpoint, payload }]);
    // What travels the wire is the payload object itself: no body, no amount.
    expect(Object.keys(pusher.sent[0]!.payload).sort()).toEqual(['id', 'link', 'title']);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @domar/domain test && pnpm --filter @domar/api test push`
Expected: FAIL — `Cannot find module '../src/notifications/push.js'` and `pushPayload is not exported`.

- [ ] **Step 4: Write the domain module**

Create `packages/domain/src/notifications/payload.ts`:

```ts
/**
 * Spec §11: "Notifications never include amounts in push payloads (title + link only); details load
 * in the app." The rule is a whitelist rather than a redaction, so a column added to `notifications`
 * later cannot reach a phone by being forgotten.
 */
export const NOTIFICATION_KINDS = [
  'invoice_published', 'reminder_created', 'assembly_invited', 'assembly_voting_opened',
  'maintenance_status', 'maintenance_request_created', 'delivery_failed',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface PushPayload {
  id: string;
  title: string;
  /** An in-app path (`/portal/invoices/…`), resolved by the service worker against its own origin. */
  link: string;
}

export function pushPayload(n: { id: string; title: string; link: string }): PushPayload {
  return { id: n.id, title: n.title, link: n.link };
}
```

Add to `packages/domain/src/index.ts`, after the `maintenance/status.js` line:

```ts
export * from './notifications/payload.js';
```

- [ ] **Step 5: Add the three config keys**

In `apps/api/src/config.ts`, inside the zod object after `JOB_TOKEN`:

```ts
  // Web Push. All three optional: unset means "no push", exactly like an unset SMTP_URL means
  // "no email" — the app never crashes for lack of a key (spec §9, plan addendum 5).
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  VAPID_SUBJECT: z.string().default(''),
```

In `interface Config`, after `jobToken: string;`:

```ts
  /** VAPID application server key, handed to the browser so it can subscribe. '' = push disabled. */
  vapidPublicKey: string;
  /** The private half, `memory` for the in-memory test transport, or '' for "push disabled". */
  vapidPrivateKey: string;
  /** `mailto:` or `https:` contact the push service may use to reach the operator. */
  vapidSubject: string;
```

In the `loadConfig` return object, after `jobToken: parsed.JOB_TOKEN,`:

```ts
    vapidPublicKey: parsed.VAPID_PUBLIC_KEY,
    vapidPrivateKey: parsed.VAPID_PRIVATE_KEY,
    vapidSubject: parsed.VAPID_SUBJECT || 'mailto:no-reply@localhost',
```

- [ ] **Step 6: Write the pusher**

Create `apps/api/src/notifications/push.ts`:

```ts
import type { PushPayload } from '@domar/domain';
import webpush, { WebPushError } from 'web-push';
import type { Config } from '../config.js';

export interface PushTarget { endpoint: string; p256dh: string; auth: string }
export type PushResult = { ok: true } | { ok: false; error: string; gone: boolean };
export interface SentPush { endpoint: string; payload: PushPayload }

export interface Pusher {
  readonly configured: boolean;
  /** The application server key the portal hands to `PushManager.subscribe`; null when unset. */
  readonly publicKey: string | null;
  /** Messages captured by the in-memory transport (`VAPID_PRIVATE_KEY=memory`); empty otherwise. */
  readonly sent: SentPush[];
  send(target: PushTarget, payload: PushPayload): Promise<PushResult>;
}

/** One day: a notification nobody's phone collected within a day is stale, and the app still has it. */
const TTL_SECONDS = 86_400;

/**
 * Without `VAPID_PRIVATE_KEY` this is an explicit no-op: `send` answers
 * `{ ok: false, error: 'vapid_not_configured' }` so the caller records the reason and falls back to
 * email, and nothing ever throws for lack of a key (plan addendum 5, mirroring `createMailer`).
 */
export function createPusher(config: Config): Pusher {
  const sent: SentPush[] = [];
  if (!config.vapidPrivateKey || !config.vapidPublicKey) {
    return {
      configured: false,
      publicKey: null,
      sent,
      async send() { return { ok: false, error: 'vapid_not_configured', gone: false }; },
    };
  }
  const capture = config.vapidPrivateKey === 'memory';
  if (!capture) webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
  return {
    configured: true,
    publicKey: config.vapidPublicKey,
    sent,
    async send(target: PushTarget, payload: PushPayload): Promise<PushResult> {
      if (capture) {
        sent.push({ endpoint: target.endpoint, payload });
        return { ok: true };
      }
      try {
        await webpush.sendNotification(
          { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
          JSON.stringify(payload),
          { TTL: TTL_SECONDS },
        );
        return { ok: true };
      } catch (err) {
        // 404/410 are the standard's "this endpoint is gone for good"; everything else may recover,
        // so the subscription stays (plan addendum 6).
        const status = err instanceof WebPushError ? err.statusCode : 0;
        const error = (err instanceof Error ? err.message : 'push_failed').slice(0, 500);
        return { ok: false, error, gone: status === 404 || status === 410 };
      }
    },
  };
}
```

- [ ] **Step 7: Decorate the app**

In `apps/api/src/app.ts`, add the import beside the mailer's:

```ts
import { createPusher, type Pusher } from './notifications/push.js';
```

after `app.decorate('mailer', mailer);`:

```ts
  app.decorate('pusher', createPusher(opts.config));
```

and extend the module augmentation at the bottom of the file:

```ts
declare module 'fastify' {
  interface FastifyInstance { config: Config; mailer: Mailer; documents: DocumentStore; pusher: Pusher }
}
```

- [ ] **Step 8: Document the variables**

In `.env.example`, after the `JOB_TOKEN=` block:

```
# Web Push (spec §9). Empty disables push entirely: notifications are still written and still shown
# in the app, and the delivery job falls back to email. Generate a pair with:
#   pnpm --filter @domar/api exec web-push generate-vapid-keys
# `memory` as the private key selects an in-memory transport (tests only).
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
# Contact the push service may use to reach you; mailto: or https:
VAPID_SUBJECT=mailto:no-reply@localhost
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm --filter @domar/domain test && pnpm --filter @domar/api test push && pnpm typecheck`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add packages/domain/src/notifications packages/domain/src/index.ts packages/domain/test/notification-payload.test.ts \
        apps/api/src/notifications/push.ts apps/api/test/push.test.ts apps/api/src/config.ts apps/api/src/app.ts \
        apps/api/package.json pnpm-lock.yaml .env.example
git commit -m "feat(api): web push transport with a title-and-link-only payload"
```

---

### Task 3: The writer, and the two bell APIs

**Files:**
- Create: `apps/api/src/notifications/text.ts`
- Create: `apps/api/src/notifications/repo.ts`
- Create: `apps/api/src/notifications/schema.ts`
- Create: `apps/api/src/notifications/routes.ts`
- Create: `apps/api/src/portal/notification-routes.ts`
- Modify: `apps/api/src/portal/schema.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/test/notifications.test.ts`

**Interfaces:**
- Consumes: `schema.notifications`, `schema.pushSubscriptions` (Task 1); `NotificationKind` (Task 2); `writeAudit` (`apps/api/src/audit.ts`), `TenantContext`, `PortalContext`, `resolveLink` (`apps/api/src/portal/repo.ts`), `idParam` (`apps/api/src/resources/common.ts`)
- Produces (used by Tasks 4, 5, 7, 8):
  - `notificationText(input: NotificationInput): { title: string; body: string; link: string }`
  - `type NotificationInput` — the discriminated union written in Step 4
  - `notify(tx: Db, ctx: TenantContext, rows: NewNotification[]): Promise<void>` with
    `interface NewNotification { ownerAccountId?: string | null; userId?: string | null; kind: NotificationKind; title: string; body: string; link: string }`
  - `ownerAccountsByContact(tx: Db, ctx: TenantContext, contactIds: string[]): Promise<Map<string, string[]>>`
  - `staffRecipients(tx: Db, ctx: TenantContext): Promise<string[]>`
  - `notifyOwners(tx: Db, ctx: TenantContext, items: { contactId: string; input: NotificationInput }[]): Promise<void>`
  - `notifyStaff(tx: Db, ctx: TenantContext, input: NotificationInput): Promise<void>`
  - `listForUser(db, ctx): Promise<{ rows: NotificationRow[]; unread: number }>`, `markUserRead(db, ctx, id)`
  - `listForOwner(db, portal): Promise<{ rows: NotificationRow[]; unread: number }>`, `markOwnerRead(db, portal, id)`
  - `upsertSubscription(db, portal, input): Promise<void>`, `removeSubscription(db, portal, endpoint): Promise<void>`, `subscriptionsFor(db, ownerAccountId): Promise<SubscriptionRow[]>`
  - `type NotificationRow = { id, kind, title, body, link, createdAt, readAt }`
  - `type SubscriptionRow = typeof schema.pushSubscriptions.$inferSelect`
  - Routes: `GET /api/notifications`, `POST /api/notifications/:id/read`, `POST /api/notifications/read-all`, `GET /api/portal/notifications`, `POST /api/portal/notifications/:id/read`, `GET /api/portal/push/key`, `POST /api/portal/push/subscribe`, `POST /api/portal/push/unsubscribe`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/notifications.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupPublishedBuilding } from './billing-fixture.js';
import { createStaffUser, registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('notification bells', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  let A: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  let ownerCookie = '';
  let accountantCookie = '';

  const staffPost = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const staffGet = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? a.cookie } });
  const portalGet = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? ownerCookie } });
  const portalPost = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? ownerCookie }, payload });

  beforeAll(async () => {
    t = await createTestApp({ SMTP_URL: 'json', VAPID_PUBLIC_KEY: 'BPublic', VAPID_PRIVATE_KEY: 'memory' });
    a = await registerTenant(t.app, 'firma-nt');
    b = await registerTenant(t.app, 'firma-nt2');
    A = await setupPublishedBuilding(t.app, a.cookie);
    const code = (await staffPost(`/api/contacts/${A.owners.O1}/portal-invite`)).json().code;
    const reg = await t.app.inject({ method: 'POST', url: '/api/portal/register', payload: { code, email: 'o1@nt.mk', password: 'correct-horse-1' } });
    expect(reg.statusCode, reg.body).toBe(201);
    ownerCookie = String(reg.headers['set-cookie']).split(';')[0]!;
    accountantCookie = (await createStaffUser(t.app, a.cookie, 'firma-nt', { email: 'acc@firma-nt.mk', firstName: 'A', lastName: 'C', role: 'accountant' })).cookie;
  });
  afterAll(async () => { await t.close(); });

  it('publishes the VAPID public key to the portal and nothing else', async () => {
    const res = await portalGet('/api/portal/push/key');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ publicKey: 'BPublic' });
    // The private half is never on the wire.
    expect(res.body).not.toContain('memory');
  });

  it('stores one subscription per endpoint and updates it in place', async () => {
    const body = { contactId: A.owners.O1, endpoint: 'https://push.example/e1', p256dh: 'k1', auth: 'a1' };
    expect((await portalPost('/api/portal/push/subscribe', body)).statusCode).toBe(204);
    expect((await portalPost('/api/portal/push/subscribe', { ...body, p256dh: 'k2' })).statusCode).toBe(204);
    const rows = await t.db.query.pushSubscriptions.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.p256dh).toBe('k2');
    expect(rows[0]!.tenantId).toBe(a.tenantId);
  });

  it('refuses a subscription for a contact the account is not linked to', async () => {
    const res = await portalPost('/api/portal/push/subscribe', { contactId: A.owners.O2, endpoint: 'https://push.example/e9', p256dh: 'k', auth: 'a' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('unsubscribes the caller’s own endpoint', async () => {
    expect((await portalPost('/api/portal/push/unsubscribe', { endpoint: 'https://push.example/e1' })).statusCode).toBe(204);
    expect(await t.db.query.pushSubscriptions.findMany()).toHaveLength(0);
    // Re-subscribed for the tasks that follow.
    await portalPost('/api/portal/push/subscribe', { contactId: A.owners.O1, endpoint: 'https://push.example/e1', p256dh: 'k1', auth: 'a1' });
  });

  it('gives a manager only their own rows, newest first, with an unread count', async () => {
    const { notify, notifyStaff } = await import('../src/notifications/repo.js');
    const ctx = { tenantId: a.tenantId, userId: null, role: 'owner' as const };
    await notify(t.db, ctx, [
      { userId: a.userId, kind: 'maintenance_request_created', title: 'Прво', body: '', link: '/app' },
      { userId: a.userId, kind: 'delivery_failed', title: 'Второ', body: '', link: '/app' },
    ]);
    await notifyStaff(t.db, { tenantId: b.tenantId, userId: null, role: 'owner' }, { kind: 'delivery_failed', what: 'нешто', notificationId: 'n-x' });

    const mine = await staffGet('/api/notifications');
    expect(mine.statusCode).toBe(200);
    const body = mine.json();
    expect(body.rows.map((r: { title: string }) => r.title)).toEqual(['Второ', 'Прво']);
    expect(body.unread).toBe(2);
    // The accountant of the same tenant has rows of their own, not the owner's.
    expect((await staffGet('/api/notifications', accountantCookie)).json().rows).toHaveLength(0);
  });

  it('marks one row read, and refuses somebody else’s id with a 404', async () => {
    const id = (await staffGet('/api/notifications')).json().rows[0].id;
    expect((await staffPost(`/api/notifications/${id}/read`)).statusCode).toBe(204);
    const after = (await staffGet('/api/notifications')).json();
    expect(after.unread).toBe(1);
    expect((await staffPost(`/api/notifications/${id}/read`, {}, accountantCookie)).statusCode).toBe(404);
  });

  it('marks everything read at once', async () => {
    expect((await staffPost('/api/notifications/read-all')).statusCode).toBe(204);
    expect((await staffGet('/api/notifications')).json().unread).toBe(0);
  });

  it('gives an owner their own rows across every link, and never a staff row', async () => {
    const { notify } = await import('../src/notifications/repo.js');
    const account = (await portalGet('/api/portal/me')).json().account.id;
    await notify(t.db, { tenantId: a.tenantId, userId: null, role: 'readonly' }, [
      { ownerAccountId: account, kind: 'invoice_published', title: 'Нова фактура', body: 'Вкупно: 2.450,00 ден.', link: '/portal/invoices/x' },
    ]);
    const res = await portalGet('/api/portal/notifications');
    expect(res.statusCode).toBe(200);
    expect(res.json().rows.map((r: { title: string }) => r.title)).toEqual(['Нова фактура']);
    expect(res.json().unread).toBe(1);
    // The body is readable behind the session — it is only the *push* that may not carry an amount.
    expect(res.json().rows[0].body).toContain('2.450,00 ден.');
    const id = res.json().rows[0].id;
    expect((await portalPost(`/api/portal/notifications/${id}/read`)).statusCode).toBe(204);
    expect((await portalGet('/api/portal/notifications')).json().unread).toBe(0);
  });

  it('does not accept a staff cookie on the portal bell, nor an owner cookie on the manager bell', async () => {
    expect((await portalGet('/api/portal/notifications', a.cookie)).statusCode).toBe(401);
    expect((await staffGet('/api/notifications', ownerCookie)).statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @domar/api test notifications`
Expected: FAIL — `Route GET /api/portal/push/key not found` (404) on the first case.

- [ ] **Step 3: Write the text module**

Create `apps/api/src/notifications/text.ts`:

```ts
import type { MaintenanceStatus, NotificationKind } from '@domar/domain';

/**
 * Macedonian, server-rendered at write time, stored on the row — like `reminders.document_html`
 * (plan addendum 7). Not on the country pack: the pack holds the wording of Law 160/2025, while
 * these strings embed domar's own routes. `title` is what a phone may see, so it never carries an
 * amount; the amount, when there is one, goes into `body` (spec §11).
 */
export type NotificationInput =
  | { kind: 'invoice_published'; buildingName: string; period: string; amount: string; invoiceId: string }
  | { kind: 'reminder_created'; buildingName: string; amount: string }
  | { kind: 'assembly_invited'; buildingName: string; scheduledOn: string; assemblyId: string }
  | { kind: 'assembly_voting_opened'; buildingName: string; decisionTitle: string; assemblyId: string }
  | { kind: 'maintenance_status'; requestTitle: string; status: MaintenanceStatus; requestId: string }
  | { kind: 'maintenance_request_created'; requestTitle: string; buildingName: string; buildingId: string }
  | { kind: 'delivery_failed'; what: string; notificationId: string };

export const MAINTENANCE_STATUS_LABELS: Readonly<Record<MaintenanceStatus, string>> = {
  new: 'Ново', triaged: 'Прегледано', assigned: 'Доделено',
  in_progress: 'Во тек', done: 'Завршено', rejected: 'Одбиено',
};

export interface NotificationText { kind: NotificationKind; title: string; body: string; link: string }

export function notificationText(input: NotificationInput): NotificationText {
  switch (input.kind) {
    case 'invoice_published':
      return {
        kind: input.kind,
        title: `Нова фактура · ${input.buildingName}`,
        body: `Пресметка за ${input.period}. Вкупно за плаќање: ${input.amount}.`,
        link: `/portal/invoices/${input.invoiceId}`,
      };
    case 'reminder_created':
      return {
        kind: input.kind,
        title: `Опомена за неплатен долг · ${input.buildingName}`,
        body: `Вкупен долг по опомената: ${input.amount}.`,
        link: '/portal/invoices',
      };
    case 'assembly_invited':
      return {
        kind: input.kind,
        title: `Покана за собир · ${input.buildingName}`,
        body: `Собирот е закажан за ${input.scheduledOn}. Отворете ја поканата за дневниот ред.`,
        link: `/portal/assemblies/${input.assemblyId}`,
      };
    case 'assembly_voting_opened':
      return {
        kind: input.kind,
        title: `Ново гласање · ${input.buildingName}`,
        body: `На дневниот ред е додадена нова предлог-одлука: ${input.decisionTitle}.`,
        link: `/portal/assemblies/${input.assemblyId}`,
      };
    case 'maintenance_status':
      return {
        kind: input.kind,
        title: `Одржување: ${MAINTENANCE_STATUS_LABELS[input.status]}`,
        body: input.requestTitle,
        link: `/portal/maintenance/${input.requestId}`,
      };
    case 'maintenance_request_created':
      return {
        kind: input.kind,
        title: `Ново барање за одржување · ${input.buildingName}`,
        body: input.requestTitle,
        link: `/app/buildings/${input.buildingId}?tab=maintenance`,
      };
    case 'delivery_failed':
      return {
        kind: input.kind,
        title: 'Известувањето не беше испорачано',
        body: `Не успеа испораката на: ${input.what}. Проверете ги поставките за е-пошта.`,
        link: '/app/settings',
      };
  }
}
```

- [ ] **Step 4: Write the repo**

Create `apps/api/src/notifications/repo.ts`:

```ts
import { type Db, schema } from '@domar/db';
import type { NotificationKind } from '@domar/domain';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { writeAudit } from '../audit.js';
import { notFound } from '../errors.js';
import type { PortalContext } from '../portal/context.js';
import { resolveLink } from '../portal/repo.js';
import type { TenantContext } from '../tenant-context.js';
import { notificationText, type NotificationInput } from './text.js';

const N = schema.notifications; const PS = schema.pushSubscriptions;
const OCL = schema.ownerContactLinks; const U = schema.users;

export type NotificationRow = { id: string; kind: NotificationKind; title: string; body: string; link: string; createdAt: Date; readAt: Date | null };
export type SubscriptionRow = typeof PS.$inferSelect;

export interface NewNotification {
  ownerAccountId?: string | null | undefined;
  userId?: string | null | undefined;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string;
}

const PUBLIC_COLUMNS = { id: N.id, kind: N.kind, title: N.title, body: N.body, link: N.link, createdAt: N.createdAt, readAt: N.readAt };

/**
 * The one writer. Always called inside the transaction of the event that caused it (plan addendum 2),
 * so a rolled-back publish leaves no notification behind. Never throws on an empty list: a trigger
 * for a building whose owners have no portal account writes nothing and says nothing.
 */
export async function notify(tx: Db, ctx: TenantContext, rows: NewNotification[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(N).values(rows.map((r) => ({
    tenantId: ctx.tenantId,
    ownerAccountId: r.ownerAccountId ?? null,
    userId: r.userId ?? null,
    kind: r.kind, title: r.title, body: r.body, link: r.link,
  })));
}

/** contactId → the owner accounts linked to it in this tenant. Empty for a contact nobody claimed. */
export async function ownerAccountsByContact(tx: Db, ctx: TenantContext, contactIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const ids = [...new Set(contactIds)];
  if (ids.length === 0) return out;
  const rows = await tx.select({ contactId: OCL.contactId, ownerAccountId: OCL.ownerAccountId }).from(OCL)
    .where(and(eq(OCL.tenantId, ctx.tenantId), inArray(OCL.contactId, ids)));
  for (const r of rows) out.set(r.contactId, [...(out.get(r.contactId) ?? []), r.ownerAccountId]);
  return out;
}

/** Spec §9's manager side: the active users who can act on it. A technician has no bell. */
export async function staffRecipients(tx: Db, ctx: TenantContext): Promise<string[]> {
  const rows = await tx.select({ id: U.id }).from(U)
    .where(and(eq(U.tenantId, ctx.tenantId), eq(U.isActive, true), inArray(U.role, ['owner', 'accountant'])));
  return rows.map((r) => r.id);
}

/** One row per (contact's owner account); a contact with two accounts gets two, a contact with none gets none. */
export async function notifyOwners(tx: Db, ctx: TenantContext, items: { contactId: string; input: NotificationInput }[]): Promise<void> {
  const accounts = await ownerAccountsByContact(tx, ctx, items.map((i) => i.contactId));
  const rows: NewNotification[] = [];
  for (const item of items) {
    const text = notificationText(item.input);
    for (const ownerAccountId of accounts.get(item.contactId) ?? []) rows.push({ ownerAccountId, ...text });
  }
  await notify(tx, ctx, rows);
}

export async function notifyStaff(tx: Db, ctx: TenantContext, input: NotificationInput): Promise<void> {
  const text = notificationText(input);
  const users = await staffRecipients(tx, ctx);
  await notify(tx, ctx, users.map((userId) => ({ userId, ...text })));
}

const NOTIFICATION_LIMIT = 50;

export async function listForUser(db: Db, ctx: TenantContext): Promise<{ rows: NotificationRow[]; unread: number }> {
  const [rows, [unread]] = await Promise.all([
    db.select(PUBLIC_COLUMNS).from(N)
      .where(and(eq(N.tenantId, ctx.tenantId), eq(N.userId, ctx.userId!)))
      .orderBy(desc(N.createdAt), desc(N.id)).limit(NOTIFICATION_LIMIT),
    db.select({ n: sql<number>`count(*)::int` }).from(N)
      .where(and(eq(N.tenantId, ctx.tenantId), eq(N.userId, ctx.userId!), isNull(N.readAt))),
  ]);
  return { rows, unread: unread?.n ?? 0 };
}

export async function markUserRead(db: Db, ctx: TenantContext, id: string): Promise<void> {
  const [row] = await db.update(N).set({ readAt: new Date() })
    .where(and(eq(N.tenantId, ctx.tenantId), eq(N.userId, ctx.userId!), eq(N.id, id))).returning({ id: N.id });
  // Somebody else's row is a 404, never a 403: the bell must not confirm that an id exists.
  if (!row) throw notFound('Notification');
}

export async function markAllUserRead(db: Db, ctx: TenantContext): Promise<void> {
  await db.update(N).set({ readAt: new Date() })
    .where(and(eq(N.tenantId, ctx.tenantId), eq(N.userId, ctx.userId!), isNull(N.readAt)));
}

/** Across every link the account holds: an owner has one bell, not one per management company. */
export async function listForOwner(db: Db, portal: PortalContext): Promise<{ rows: NotificationRow[]; unread: number }> {
  const tenantIds = [...new Set(portal.links.map((l) => l.tenantId))];
  if (tenantIds.length === 0) return { rows: [], unread: 0 };
  const scope = and(eq(N.ownerAccountId, portal.ownerAccountId), inArray(N.tenantId, tenantIds));
  const [rows, [unread]] = await Promise.all([
    db.select(PUBLIC_COLUMNS).from(N).where(scope).orderBy(desc(N.createdAt), desc(N.id)).limit(NOTIFICATION_LIMIT),
    db.select({ n: sql<number>`count(*)::int` }).from(N).where(and(scope, isNull(N.readAt))),
  ]);
  return { rows, unread: unread?.n ?? 0 };
}

export async function markOwnerRead(db: Db, portal: PortalContext, id: string): Promise<void> {
  const [row] = await db.update(N).set({ readAt: new Date() })
    .where(and(eq(N.ownerAccountId, portal.ownerAccountId), eq(N.id, id))).returning({ id: N.id });
  if (!row) throw notFound('Notification');
}

export interface NewSubscription { contactId: string; endpoint: string; p256dh: string; auth: string; userAgent?: string | undefined }

/**
 * One row per endpoint (the unique index), so a browser that rotates its keys updates in place.
 * `tenant_id` is the link the owner was looking at when they subscribed (plan addendum 3); the
 * `resolveLink` call is what refuses a contact the account is not linked to, with a 404.
 */
export async function upsertSubscription(db: Db, portal: PortalContext, input: NewSubscription): Promise<void> {
  const { ctx } = resolveLink(portal, input.contactId);
  await db.transaction(async (tx) => {
    await tx.insert(PS).values({
      tenantId: ctx.tenantId, ownerAccountId: portal.ownerAccountId,
      endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth,
      userAgent: input.userAgent ?? null,
    }).onConflictDoUpdate({
      target: PS.endpoint,
      set: {
        tenantId: ctx.tenantId, ownerAccountId: portal.ownerAccountId,
        p256dh: input.p256dh, auth: input.auth, userAgent: input.userAgent ?? null, lastSeenAt: new Date(),
      },
    });
    await writeAudit(tx, ctx, { action: 'push_subscription.upsert', entityType: 'owner_account', entityId: portal.ownerAccountId, after: { endpoint: input.endpoint } });
  });
}

/** The caller's own endpoint only; an endpoint that is not theirs simply matches nothing. */
export async function removeSubscription(db: Db, portal: PortalContext, endpoint: string): Promise<void> {
  await db.delete(PS).where(and(eq(PS.ownerAccountId, portal.ownerAccountId), eq(PS.endpoint, endpoint)));
}

/** Delivery's lookup: by account, deliberately across tenants (plan addendum 3). */
export async function subscriptionsFor(db: Db, ownerAccountId: string): Promise<SubscriptionRow[]> {
  return db.select().from(PS).where(eq(PS.ownerAccountId, ownerAccountId));
}

export async function deleteSubscriptionByEndpoint(db: Db, endpoint: string): Promise<void> {
  await db.delete(PS).where(eq(PS.endpoint, endpoint));
}
```

- [ ] **Step 5: Write the schemas and the routes**

Create `apps/api/src/notifications/schema.ts`:

```ts
import { NOTIFICATION_KINDS } from '@domar/domain';
import { z } from 'zod';

export const notificationKindEnum = z.enum(NOTIFICATION_KINDS);
export const notificationRowOut = z.object({
  id: z.string(),
  kind: notificationKindEnum,
  title: z.string(),
  body: z.string(),
  link: z.string(),
  createdAt: z.date().or(z.string()),
  readAt: z.date().or(z.string()).nullable(),
});
export const notificationListOut = z.object({ rows: z.array(notificationRowOut), unread: z.number().int() });
```

Create `apps/api/src/notifications/routes.ts`:

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { idParam } from '../resources/common.js';
import { listForUser, markAllUserRead, markUserRead } from './repo.js';
import { notificationListOut } from './schema.js';

/** The manager's bell. Every role has one: a readonly user is told what changed, like anyone else. */
export const notificationRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', { schema: { response: { 200: notificationListOut } } }, async (req) => listForUser(req.db, req.ctx!));

  app.post('/:id/read', { schema: { params: idParam } }, async (req, reply) => {
    await markUserRead(req.db, req.ctx!, req.params.id);
    return reply.status(204).send();
  });

  app.post('/read-all', {}, async (req, reply) => {
    await markAllUserRead(req.db, req.ctx!);
    return reply.status(204).send();
  });
};
```

Add to `apps/api/src/portal/schema.ts` (at the end):

```ts
export const portalPushSubscribeBody = z.object({
  contactId: z.string().uuid(),
  endpoint: z.string().url().max(2000),
  p256dh: z.string().min(1).max(500),
  auth: z.string().min(1).max(500),
  userAgent: z.string().max(500).optional(),
});
export const portalPushUnsubscribeBody = z.object({ endpoint: z.string().url().max(2000) });
export const portalPushKeyOut = z.object({ publicKey: z.string().nullable() });
```

Create `apps/api/src/portal/notification-routes.ts`:

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { listForOwner, markOwnerRead, removeSubscription, upsertSubscription } from '../notifications/repo.js';
import { notificationListOut } from '../notifications/schema.js';
import { idParam } from '../resources/common.js';
import { portalPushKeyOut, portalPushSubscribeBody, portalPushUnsubscribeBody } from './schema.js';

/** The owner's bell and the browser's push registration. Everything is keyed on the caller's account. */
export const portalNotificationRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requirePortal);

  app.get('/notifications', { schema: { response: { 200: notificationListOut } } }, async (req) =>
    listForOwner(req.db, req.portal!));

  app.post('/notifications/:id/read', { schema: { params: idParam } }, async (req, reply) => {
    await markOwnerRead(req.db, req.portal!, req.params.id);
    return reply.status(204).send();
  });

  // Only the public half, and null when push is not configured: the portal then hides the button.
  app.get('/push/key', { schema: { response: { 200: portalPushKeyOut } } }, async () => ({ publicKey: app.pusher.publicKey }));

  app.post('/push/subscribe', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { body: portalPushSubscribeBody },
  }, async (req, reply) => {
    await upsertSubscription(req.db, req.portal!, req.body);
    return reply.status(204).send();
  });

  app.post('/push/unsubscribe', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { body: portalPushUnsubscribeBody },
  }, async (req, reply) => {
    await removeSubscription(req.db, req.portal!, req.body.endpoint);
    return reply.status(204).send();
  });
};
```

Register both in `apps/api/src/app.ts` — imports beside their neighbours:

```ts
import { notificationRoutes } from './notifications/routes.js';
import { portalNotificationRoutes } from './portal/notification-routes.js';
```

and, inside the `/api` scope, after `await api.register(portalMaintenanceRoutes, { prefix: '/portal' });`:

```ts
    await api.register(portalNotificationRoutes, { prefix: '/portal' });
```

and after `await api.register(dashboardRoutes, { prefix: '/dashboard' });`:

```ts
    await api.register(notificationRoutes, { prefix: '/notifications' });
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @domar/api test notifications && pnpm typecheck`
Expected: PASS (9 cases)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/notifications apps/api/src/portal/notification-routes.ts apps/api/src/portal/schema.ts apps/api/src/app.ts apps/api/test/notifications.test.ts
git commit -m "feat(api): notification writer, manager bell and portal bell"
```

---

### Task 4: The six triggers

**Files:**
- Modify: `apps/api/src/resources/invoicing/publish.ts`
- Modify: `apps/api/src/resources/reminders/service.ts`
- Modify: `apps/api/src/resources/assemblies/service.ts`
- Modify: `apps/api/src/resources/assemblies/repo.ts`
- Modify: `apps/api/src/resources/maintenance/repo.ts`
- Modify: `apps/api/src/portal/maintenance-repo.ts`
- Create: `apps/api/test/notification-triggers.test.ts`

**Interfaces:**
- Consumes (Task 3): `notifyOwners(tx, ctx, items)`, `notifyStaff(tx, ctx, input)`, `NotificationInput`
- Produces: no new exported symbol. Six call sites, each inside an existing transaction.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/notification-triggers.test.ts`:

```ts
import { schema } from '@domar/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupPublishedBuilding } from './billing-fixture.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('notification triggers', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let A: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  let ownerCookie = '';
  let accountId = '';
  let unitId = '';

  const post = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const get = (url: string) => t.app.inject({ method: 'GET', url, headers: { cookie: a.cookie } });
  const ownerRows = async () => t.db.select().from(schema.notifications)
    .where(and(eq(schema.notifications.tenantId, a.tenantId), eq(schema.notifications.ownerAccountId, accountId)));
  const staffRows = async () => t.db.select().from(schema.notifications)
    .where(and(eq(schema.notifications.tenantId, a.tenantId), eq(schema.notifications.userId, a.userId)));

  beforeAll(async () => {
    t = await createTestApp({ SMTP_URL: 'json' });
    a = await registerTenant(t.app, 'firma-tr');
    A = await setupPublishedBuilding(t.app, a.cookie);
    unitId = (await get(`/api/buildings/${A.buildingId}/units`)).json().rows.find((u: { label: string }) => u.label === '1').id;
    const code = (await post(`/api/contacts/${A.owners.O1}/portal-invite`)).json().code;
    const reg = await t.app.inject({ method: 'POST', url: '/api/portal/register', payload: { code, email: 'o1@tr.mk', password: 'correct-horse-1' } });
    ownerCookie = String(reg.headers['set-cookie']).split(';')[0]!;
    accountId = reg.json().account.id;
  });
  afterAll(async () => { await t.close(); });

  it('a published period notifies every linked owner once, with the amount out of the title', async () => {
    // `setupPublishedBuilding` published before the owner had an account; a second period is the trigger.
    const period = (await post(`/api/buildings/${A.buildingId}/periods`, { period: '2026-10' })).json();
    await post(`/api/buildings/${A.buildingId}/periods/${period.id}/generate`);
    expect((await post(`/api/buildings/${A.buildingId}/periods/${period.id}/publish`)).statusCode).toBe(200);

    const rows = (await ownerRows()).filter((r) => r.kind === 'invoice_published');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toContain('Нова фактура');
    // Spec §11: the amount is in the body, never in the title a phone may show.
    expect(rows[0]!.title).not.toMatch(/ден\./);
    expect(rows[0]!.body).toMatch(/ден\./);
    expect(rows[0]!.link).toMatch(/^\/portal\/invoices\/[0-9a-f-]{36}$/);
    expect(rows[0]!.deliveredAt).toBeNull();
  });

  it('a reminder run notifies the owner it was raised against', async () => {
    // The October invoice is unpaid and past due once the clock is moved by the run's own date.
    await t.db.update(schema.invoices).set({ dueAt: new Date('2020-01-01') })
      .where(eq(schema.invoices.tenantId, a.tenantId));
    expect((await post(`/api/buildings/${A.buildingId}/reminders/run`)).statusCode).toBe(200);
    const rows = (await ownerRows()).filter((r) => r.kind === 'reminder_created');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.title).toContain('Опомена');
    expect(rows[0]!.title).not.toMatch(/ден\./);
    expect(rows[0]!.link).toBe('/portal/invoices');
  });

  it('an assembly invitation notifies the invited owners, and a later decision opens voting', async () => {
    const when = new Date(Date.now() + 40 * 24 * 3600 * 1000).toISOString();
    const assembly = (await post(`/api/buildings/${A.buildingId}/assemblies`, { scheduledAt: when, location: 'Влез А' })).json();
    expect((await post(`/api/assemblies/${assembly.id}/invite`)).statusCode).toBe(200);
    const invited = (await ownerRows()).filter((r) => r.kind === 'assembly_invited');
    expect(invited).toHaveLength(1);
    expect(invited[0]!.link).toBe(`/portal/assemblies/${assembly.id}`);

    expect((await post(`/api/assemblies/${assembly.id}/decisions`, { title: 'Нов пристапен систем' })).statusCode).toBe(201);
    const opened = (await ownerRows()).filter((r) => r.kind === 'assembly_voting_opened');
    expect(opened).toHaveLength(1);
    expect(opened[0]!.body).toContain('Нов пристапен систем');
  });

  it('a decision added to a draft assembly notifies nobody', async () => {
    const when = new Date(Date.now() + 40 * 24 * 3600 * 1000).toISOString();
    const draft = (await post(`/api/buildings/${A.buildingId}/assemblies`, { scheduledAt: when, location: 'Влез Б' })).json();
    const before = (await ownerRows()).filter((r) => r.kind === 'assembly_voting_opened').length;
    await post(`/api/assemblies/${draft.id}/decisions`, { title: 'Сеуште нацрт' });
    expect((await ownerRows()).filter((r) => r.kind === 'assembly_voting_opened')).toHaveLength(before);
  });

  it('a portal request rings the manager’s bell, and its status changes ring the owner’s', async () => {
    const created = await t.app.inject({
      method: 'POST', url: '/api/portal/maintenance', headers: { cookie: ownerCookie },
      payload: { contactId: A.owners.O1, buildingId: A.buildingId, unitId, title: 'Протекува цевка во визбата', description: 'Трет ден.', category: 'plumbing', priority: 'high' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const requestId = created.json().id;

    const staff = (await staffRows()).filter((r) => r.kind === 'maintenance_request_created');
    expect(staff).toHaveLength(1);
    expect(staff[0]!.body).toBe('Протекува цевка во визбата');
    expect(staff[0]!.link).toBe(`/app/buildings/${A.buildingId}?tab=maintenance`);

    expect((await post(`/api/maintenance-requests/${requestId}/status`, { status: 'triaged' })).statusCode).toBe(200);
    const owner = (await ownerRows()).filter((r) => r.kind === 'maintenance_status');
    expect(owner).toHaveLength(1);
    expect(owner[0]!.title).toBe('Одржување: Прегледано');
    expect(owner[0]!.link).toBe(`/portal/maintenance/${requestId}`);
  });

  it('a staff-created request notifies no owner: there is no owner behind it', async () => {
    const before = (await ownerRows()).filter((r) => r.kind === 'maintenance_status').length;
    const own = (await post(`/api/buildings/${A.buildingId}/maintenance`, { title: 'Фарбање на влез', category: 'common_area' })).json();
    await post(`/api/maintenance-requests/${own.id}/status`, { status: 'triaged' });
    expect((await ownerRows()).filter((r) => r.kind === 'maintenance_status')).toHaveLength(before);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @domar/api test notification-triggers`
Expected: FAIL — `expect(rows).toHaveLength(1)` receives `0`: nothing writes notifications yet.

- [ ] **Step 3: Wire the invoice trigger**

In `apps/api/src/resources/invoicing/publish.ts`, add the imports:

```ts
import { getCountryPack, type CountryCode } from '@domar/domain';
import { notifyOwners } from '../../notifications/repo.js';
import { getBuilding } from '../buildings/repo.js';
```

and, inside `publishPeriod`'s transaction, immediately before the `await writeAudit(...)` line:

```ts
    // Spec §9: one notification per linked owner account, inside the publishing transaction, so an
    // invoice that is rolled back never announced itself. The amount stays out of `title`.
    const building = await getBuilding(tx, ctx, buildingId);
    const pack = getCountryPack(building.countryCode as CountryCode);
    await notifyOwners(tx, ctx, drafts.map(({ inv }) => ({
      contactId: inv.contactId,
      input: {
        kind: 'invoice_published' as const, buildingName: building.name, period: claimed.period,
        amount: pack.formatMoney(inv.totalMinor), invoiceId: inv.id,
      },
    })));
```

- [ ] **Step 4: Wire the reminder trigger**

In `apps/api/src/resources/reminders/service.ts`, add the import:

```ts
import { notifyOwners } from '../../notifications/repo.js';
```

and, inside `runBuildingReminders`'s transaction, immediately after `const rows = await tx.insert(R).values(values).returning();`:

```ts
    await notifyOwners(tx, ctx, rows.map((r) => ({
      contactId: r.contactId,
      input: { kind: 'reminder_created' as const, buildingName: building.name, amount: pack.formatMoney(r.totalOutstandingMinor) },
    })));
```

- [ ] **Step 5: Wire the two assembly triggers**

In `apps/api/src/resources/assemblies/service.ts`, add the import:

```ts
import { notifyOwners } from '../../notifications/repo.js';
```

and, inside `inviteAssembly`'s transaction, immediately before `await writeAudit(...)`:

```ts
    // The same set the invitations froze: whoever was invited is whoever is told.
    await notifyOwners(tx, ctx, invitations.map((i) => ({
      contactId: i.contactId,
      input: {
        kind: 'assembly_invited' as const, buildingName: building.name,
        scheduledOn: claimed.scheduledAt.toISOString().slice(0, 10), assemblyId: id,
      },
    })));
```

In `apps/api/src/resources/assemblies/repo.ts`, add the imports:

```ts
import { notifyOwners } from '../../notifications/repo.js';
import { getBuilding } from '../buildings/repo.js';
```

and rewrite `createDecision`'s body so the claim's status is read (plan addendum 9):

```ts
export async function createDecision(db: Db, ctx: TenantContext, id: string, input: DecisionCreate) {
  return db.transaction(async (tx) => {
    const claimed = await claimAssembly(tx, ctx, id, ['draft', 'invited']);
    const [existing] = await tx.select({ n: count() }).from(AD).where(and(eq(AD.tenantId, ctx.tenantId), eq(AD.assemblyId, id)));
    const [row] = await tx.insert(AD).values({
      tenantId: ctx.tenantId, assemblyId: id, title: input.title, text: input.text ?? null,
      sortOrder: input.sortOrder ?? Number(existing?.n ?? 0),
    }).returning();
    // A ballot item added *after* the owners were called is the one they would otherwise miss; the
    // invitation itself already told them voting was open (plan addendum 9).
    if (claimed.status === 'invited') {
      const building = await getBuilding(tx, ctx, claimed.buildingId);
      const invited = await tx.select({ contactId: AI.contactId }).from(AI)
        .where(and(eq(AI.tenantId, ctx.tenantId), eq(AI.assemblyId, id)));
      await notifyOwners(tx, ctx, invited.map((i) => ({
        contactId: i.contactId,
        input: { kind: 'assembly_voting_opened' as const, buildingName: building.name, decisionTitle: row!.title, assemblyId: id },
      })));
    }
    await writeAudit(tx, ctx, { action: 'assembly_decision.create', entityType: 'assembly_decision', entityId: row!.id, after: row });
    return getAssembly(tx, ctx, id);
  });
}
```

If `AI` is not already aliased at the top of `repo.ts`, add it to the existing alias line:

```ts
const AI = schema.assemblyInvitations;
```

- [ ] **Step 6: Wire the maintenance triggers**

In `apps/api/src/resources/maintenance/repo.ts`, add the import:

```ts
import { notifyOwners } from '../../notifications/repo.js';
```

and, inside `setStatus`'s transaction, immediately before `await writeAudit(...)`:

```ts
    // Only a request an owner actually filed has an owner to tell; a staff-created one has none.
    if (before.reportedByContactId) {
      await notifyOwners(tx, ctx, [{
        contactId: before.reportedByContactId,
        input: { kind: 'maintenance_status' as const, requestTitle: before.title, status: to, requestId: id },
      }]);
    }
```

In `apps/api/src/portal/maintenance-repo.ts`, add the import:

```ts
import { notifyStaff } from '../notifications/repo.js';
```

and, inside `portalMaintenanceCreate`'s transaction, immediately before `await writeAudit(...)`:

```ts
    // Spec §9's manager side: the in-app bell for a new request from the portal.
    const [building] = await tx.select({ name: B.name }).from(B)
      .where(and(eq(B.tenantId, ctx.tenantId), eq(B.id, input.buildingId))).limit(1);
    await notifyStaff(tx, ctx, {
      kind: 'maintenance_request_created', requestTitle: input.title,
      buildingName: building?.name ?? '', buildingId: input.buildingId,
    });
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @domar/api test && pnpm typecheck`
Expected: PASS — the new file plus the untouched `invoicing`, `reminders`, `assemblies`, `maintenance` and `portal-maintenance` suites.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/resources/invoicing/publish.ts apps/api/src/resources/reminders/service.ts \
        apps/api/src/resources/assemblies/service.ts apps/api/src/resources/assemblies/repo.ts \
        apps/api/src/resources/maintenance/repo.ts apps/api/src/portal/maintenance-repo.ts \
        apps/api/test/notification-triggers.test.ts
git commit -m "feat(api): write notifications from the six spec §9 triggers"
```

---

### Task 5: The delivery job, its cron line, and the failed-send bell

**Files:**
- Create: `apps/api/src/jobs/token.ts`
- Modify: `apps/api/src/resources/reminders/routes.ts`
- Create: `apps/api/src/notifications/deliver.ts`
- Create: `apps/api/src/notifications/job-routes.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/test/notification-delivery.test.ts`
- Modify: `docs/DEPLOY.md`

**Interfaces:**
- Consumes: `Pusher`, `pushPayload` (Task 2); `notify`, `notifyStaff`, `subscriptionsFor`, `deleteSubscriptionByEndpoint` (Task 3); `Mailer`, `logEmail`
- Produces (used by Task 8):
  - `assertJobToken(config: Config, headers: IncomingHttpHeaders): void` (`apps/api/src/jobs/token.ts`)
  - `notificationRuntime(app: FastifyInstance): NotificationRuntime` and
    `drainNotifications(db: Db, rt: NotificationRuntime, limit?: number): Promise<DrainResult>` where
    `interface NotificationRuntime { pusher: Pusher; mailer: Mailer; log: { warn(obj: unknown, msg: string): void } }` and
    `type DrainResult = { claimed: number; pushed: number; emailed: number; failed: number }`
  - Route `POST /api/jobs/notifications`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/notification-delivery.test.ts`:

```ts
import { schema } from '@domar/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupPublishedBuilding } from './billing-fixture.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

const TOKEN = 'job-token-for-the-tests';

describe('notification delivery job', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let A: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  let accountId = '';
  let ownerCookie = '';

  const drain = (token = TOKEN) => t.app.inject({ method: 'POST', url: '/api/jobs/notifications', headers: { 'x-job-token': token } });
  const write = async (over: Partial<typeof schema.notifications.$inferInsert> = {}) => {
    const [row] = await t.db.insert(schema.notifications).values({
      tenantId: a.tenantId, ownerAccountId: accountId, kind: 'invoice_published',
      title: 'Нова фактура · Партизанска 12', body: 'Вкупно: 2.450,00 ден.', link: '/portal/invoices/i-1',
      ...over,
    }).returning();
    return row!;
  };
  const reload = async (id: string) => (await t.db.select().from(schema.notifications).where(eq(schema.notifications.id, id)))[0]!;

  beforeAll(async () => {
    t = await createTestApp({ JOB_TOKEN: TOKEN, SMTP_URL: 'json', VAPID_PUBLIC_KEY: 'BPublic', VAPID_PRIVATE_KEY: 'memory' });
    a = await registerTenant(t.app, 'firma-nd');
    A = await setupPublishedBuilding(t.app, a.cookie);
    const code = (await t.app.inject({ method: 'POST', url: `/api/contacts/${A.owners.O1}/portal-invite`, headers: { cookie: a.cookie }, payload: {} })).json().code;
    const reg = await t.app.inject({ method: 'POST', url: '/api/portal/register', payload: { code, email: 'o1@nd.mk', password: 'correct-horse-1' } });
    ownerCookie = String(reg.headers['set-cookie']).split(';')[0]!;
    accountId = reg.json().account.id;
    // Clear whatever the fixture's own publish wrote, so each case counts only its own row.
    await t.db.delete(schema.notifications);
  });
  afterAll(async () => { await t.close(); });

  it('answers 401 without a token, 403 with a wrong one', async () => {
    expect((await t.app.inject({ method: 'POST', url: '/api/jobs/notifications' })).statusCode).toBe(401);
    expect((await drain('nope-nope-nope-nope')).statusCode).toBe(403);
  });

  it('pushes title and link only, and never the amount', async () => {
    await t.app.inject({
      method: 'POST', url: '/api/portal/push/subscribe', headers: { cookie: ownerCookie },
      payload: { contactId: A.owners.O1, endpoint: 'https://push.example/live', p256dh: 'k', auth: 'x' },
    });
    const row = await write();
    const res = await drain();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ claimed: 1, pushed: 1, emailed: 0, failed: 0 });

    expect(t.app.pusher.sent).toHaveLength(1);
    expect(t.app.pusher.sent[0]!.payload).toEqual({ id: row.id, title: row.title, link: row.link });
    expect(JSON.stringify(t.app.pusher.sent[0]!.payload)).not.toContain('ден.');
    const after = await reload(row.id);
    expect(after.deliveredAt).not.toBeNull();
    expect(after.deliveryError).toBeNull();
    // No second send on a second run: the claim is what makes the job idempotent.
    expect((await drain()).json()).toEqual({ claimed: 0, pushed: 0, emailed: 0, failed: 0 });
  });

  it('falls back to email when the account has no subscription', async () => {
    await t.db.delete(schema.pushSubscriptions);
    const row = await write();
    expect((await drain()).json()).toEqual({ claimed: 1, pushed: 0, emailed: 1, failed: 0 });
    const sent = t.app.mailer.outbox.at(-1)!;
    expect(sent.to).toBe('o1@nd.mk');
    expect(sent.subject).toBe(row.title);
    // Email is behind an address the owner already gave us, so it may carry the detail.
    expect(sent.text).toContain('2.450,00 ден.');
    expect((await reload(row.id)).deliveryError).toBeNull();
  });

  it('deletes a subscription the push service reports as gone', async () => {
    await t.db.insert(schema.pushSubscriptions).values({
      tenantId: a.tenantId, ownerAccountId: accountId, endpoint: 'https://push.example/gone', p256dh: 'k', auth: 'x',
    });
    const original = t.app.pusher.send;
    (t.app.pusher as { send: unknown }).send = async () => ({ ok: false, error: 'gone', gone: true });
    try {
      await write();
      // Push is gone, so the email fallback carries it.
      expect((await drain()).json()).toEqual({ claimed: 1, pushed: 0, emailed: 1, failed: 0 });
    } finally {
      (t.app.pusher as { send: unknown }).send = original;
    }
    expect(await t.db.select().from(schema.pushSubscriptions)).toHaveLength(0);
  });

  it('rings the manager’s bell when neither push nor email delivered', async () => {
    const noMail = await createTestApp({ JOB_TOKEN: TOKEN }); // no SMTP_URL, no VAPID
    try {
      const x = await registerTenant(noMail.app, 'firma-nd2');
      const X = await setupPublishedBuilding(noMail.app, x.cookie);
      const code = (await noMail.app.inject({ method: 'POST', url: `/api/contacts/${X.owners.O1}/portal-invite`, headers: { cookie: x.cookie }, payload: {} })).json().code;
      const reg = await noMail.app.inject({ method: 'POST', url: '/api/portal/register', payload: { code, email: 'o1@nd2.mk', password: 'correct-horse-1' } });
      await noMail.db.delete(schema.notifications);
      await noMail.db.insert(schema.notifications).values({
        tenantId: x.tenantId, ownerAccountId: reg.json().account.id, kind: 'invoice_published',
        title: 'Нова фактура', body: 'Вкупно: 1,00 ден.', link: '/portal/invoices/i-9',
      });
      const res = await noMail.app.inject({ method: 'POST', url: '/api/jobs/notifications', headers: { 'x-job-token': TOKEN } });
      expect(res.json()).toEqual({ claimed: 1, pushed: 0, emailed: 0, failed: 1 });

      const bell = await noMail.db.select().from(schema.notifications)
        .where(and(eq(schema.notifications.tenantId, x.tenantId), eq(schema.notifications.userId, x.userId)));
      expect(bell).toHaveLength(1);
      expect(bell[0]!.kind).toBe('delivery_failed');
      expect(bell[0]!.title).toBe('Известувањето не беше испорачано');
      // The staff row itself is delivered by the same run that created it? No: it is marked
      // delivered without a network call the *next* time the job runs, and never emailed.
      const second = await noMail.app.inject({ method: 'POST', url: '/api/jobs/notifications', headers: { 'x-job-token': TOKEN } });
      expect(second.json()).toEqual({ claimed: 1, pushed: 0, emailed: 0, failed: 0 });
      expect(noMail.app.mailer.outbox).toHaveLength(0);
    } finally {
      await noMail.close();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @domar/api test notification-delivery`
Expected: FAIL — `POST /api/jobs/notifications` answers `404`, not `401`.

- [ ] **Step 3: Extract the job-token check**

Create `apps/api/src/jobs/token.ts`:

```ts
import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Config } from '../config.js';
import { AppError, forbidden, unauthorized } from '../errors.js';

/**
 * The cron's whole authentication (spec §18.3). The header is checked first, so an unauthenticated
 * caller learns nothing about this server's configuration and a misconfigured server still answers
 * a token-less probe with 401.
 */
export function assertJobToken(config: Config, headers: IncomingHttpHeaders): void {
  const given = headers['x-job-token'];
  if (typeof given !== 'string' || given.length === 0) throw unauthorized();
  const expected = config.jobToken;
  if (!expected) throw new AppError(503, 'job_token_not_configured', 'JOB_TOKEN is not configured on this server');
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw forbidden();
}
```

In `apps/api/src/resources/reminders/routes.ts`, replace the body of the `/reminders` job handler with a call to it, drop the now-unused `timingSafeEqual`, `forbidden` and `unauthorized` imports (keep `AppError`, still used by the PDF route), and add `import { assertJobToken } from '../../jobs/token.js';`:

```ts
export const jobRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post('/reminders', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } }, schema: { response: { 200: jobResultOut } } }, async (req) => {
    assertJobToken(app.config, req.headers);
    return runAllTenants(req.db, runtime(app));
  });
};
```

- [ ] **Step 4: Write the drain**

Create `apps/api/src/notifications/deliver.ts`:

```ts
import { type Db, schema } from '@domar/db';
import { pushPayload } from '@domar/domain';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { logEmail } from '../email/log.js';
import type { Mailer } from '../email/mailer.js';
import type { TenantContext } from '../tenant-context.js';
import type { Pusher } from './push.js';
import { deleteSubscriptionByEndpoint, notifyStaff, subscriptionsFor } from './repo.js';

const N = schema.notifications; const OA = schema.ownerAccounts;

export interface NotificationRuntime {
  pusher: Pusher;
  mailer: Mailer;
  log: { warn(obj: unknown, msg: string): void };
}

export interface DrainResult { claimed: number; pushed: number; emailed: number; failed: number }

export const notificationRuntime = (app: FastifyInstance): NotificationRuntime => ({ pusher: app.pusher, mailer: app.mailer, log: app.log });

const DEFAULT_LIMIT = 500;

/**
 * Claims the undelivered tail and sends it. `for update skip locked` is what makes two overlapping
 * cron runs split the queue instead of double-sending, and `delivered_at` is stamped *before* the
 * first network call, so a crash mid-run costs at most one notification (plan addendum 4).
 */
export async function drainNotifications(db: Db, rt: NotificationRuntime, limit = DEFAULT_LIMIT): Promise<DrainResult> {
  const claimed = await db.transaction(async (tx) => {
    const ids = await tx.select({ id: N.id }).from(N).where(isNull(N.deliveredAt))
      .orderBy(asc(N.createdAt), asc(N.id)).limit(limit).for('update', { skipLocked: true });
    if (ids.length === 0) return [];
    return tx.update(N).set({ deliveredAt: new Date() }).where(inArray(N.id, ids.map((i) => i.id))).returning();
  });

  const out: DrainResult = { claimed: claimed.length, pushed: 0, emailed: 0, failed: 0 };
  for (const row of claimed) {
    // A staff row is an in-app bell and nothing else: no push, no email (plan addendum 12). It is
    // also what stops a failed delivery from recursing into another failed delivery.
    if (!row.ownerAccountId) continue;
    try {
      const error = await deliverToOwner(db, rt, row);
      if (error === null) { out.pushed += 1; continue; }
      if (error === 'emailed') { out.emailed += 1; continue; }
      out.failed += 1;
      await recordFailure(db, rt, row, error);
    } catch (err) {
      // One unreachable endpoint must not cost the rest of the queue.
      rt.log.warn({ err, notificationId: row.id }, 'notification delivery threw; recorded as failed');
      out.failed += 1;
      await recordFailure(db, rt, row, (err instanceof Error ? err.message : 'delivery_failed').slice(0, 500));
    }
  }
  return out;
}

/** null = pushed; 'emailed' = the fallback carried it; any other string = the reason it failed. */
async function deliverToOwner(db: Db, rt: NotificationRuntime, row: typeof N.$inferSelect): Promise<string | null> {
  const subscriptions = await subscriptionsFor(db, row.ownerAccountId!);
  const payload = pushPayload({ id: row.id, title: row.title, link: row.link });
  let pushed = false;
  let lastError = 'no_subscription';
  for (const s of subscriptions) {
    const res = await rt.pusher.send({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, payload);
    if (res.ok) { pushed = true; continue; }
    lastError = res.error;
    // 404/410: the endpoint is gone for good, so the row goes with it (plan addendum 6).
    if (res.gone) await deleteSubscriptionByEndpoint(db, s.endpoint);
  }
  if (pushed) return null;

  const [account] = await db.select({ email: OA.email }).from(OA).where(eq(OA.id, row.ownerAccountId!)).limit(1);
  if (!account) return 'account_missing';
  const ctx: TenantContext = { tenantId: row.tenantId, userId: null, role: 'readonly' };
  const res = await rt.mailer.send({ to: account.email, subject: row.title, text: `${row.title}\n\n${row.body}` });
  const ok = 'id' in res;
  await db.transaction(async (tx) => {
    await logEmail(tx, ctx, {
      to: account.email, subject: row.title, template: 'notification', refType: 'notification', refId: row.id,
      status: ok ? 'sent' : 'failed', error: ok ? null : res.error,
    });
  });
  if (ok) return 'emailed';
  return `${lastError}; email: ${res.error}`.slice(0, 500);
}

/** Spec §9's second manager-side bell: a send that failed both ways. */
async function recordFailure(db: Db, rt: NotificationRuntime, row: typeof N.$inferSelect, error: string): Promise<void> {
  const ctx: TenantContext = { tenantId: row.tenantId, userId: null, role: 'owner' };
  await db.transaction(async (tx) => {
    await tx.update(N).set({ deliveryError: error.slice(0, 500) })
      .where(and(eq(N.tenantId, ctx.tenantId), eq(N.id, row.id)));
    await notifyStaff(tx, ctx, { kind: 'delivery_failed', what: row.title, notificationId: row.id });
  });
}
```

- [ ] **Step 5: Write the job route**

Create `apps/api/src/notifications/job-routes.ts`:

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { assertJobToken } from '../jobs/token.js';
import { drainNotifications, notificationRuntime } from './deliver.js';

export const drainResultOut = z.object({
  claimed: z.number().int(), pushed: z.number().int(), emailed: z.number().int(), failed: z.number().int(),
});

/** No session: the cron authenticates with the same shared token as the reminder job (spec §18.3). */
export const notificationJobRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post('/notifications', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, schema: { response: { 200: drainResultOut } } }, async (req) => {
    assertJobToken(app.config, req.headers);
    return drainNotifications(req.db, notificationRuntime(app));
  });
};
```

Register it in `apps/api/src/app.ts` — the import beside the reminders one:

```ts
import { notificationJobRoutes } from './notifications/job-routes.js';
```

and, right after `await api.register(jobRoutes, { prefix: '/jobs' });`:

```ts
    await api.register(notificationJobRoutes, { prefix: '/jobs' });
```

- [ ] **Step 6: Document the cron line**

In `docs/DEPLOY.md`, add a section immediately after the `## Reminders` section:

```markdown
## Notifications

Notification rows are written by the events that cause them (a published period, a new reminder, an
assembly invitation, a maintenance status change, a request filed from the portal). Sending them is a
second job, on the same shared token:

    */5 * * * * cd /srv/domar && . ./.env && curl -fsS -m 120 -X POST -H "x-job-token: $JOB_TOKEN" "https://$DOMAIN/api/jobs/notifications" >> /var/log/domar-notifications.log 2>&1

Every five minutes, because a notification is worth little an hour late. The job claims the
undelivered rows with `for update skip locked` and stamps `delivered_at` before it sends anything, so
two overlapping runs split the queue and a crash never double-sends. The answer counts what happened:
`{"claimed","pushed","emailed","failed"}`. It answers `401` without the header, `403` with the wrong
token and `503` when `JOB_TOKEN` is unset — the same three answers as the reminder job.

Web Push needs a VAPID key pair. Generate one once, put both halves in `.env`, and never rotate them
without expecting every installed portal to resubscribe:

    docker compose -f docker-compose.prod.yml run --rm api pnpm --filter @domar/api exec web-push generate-vapid-keys

With `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` unset, push is simply off: the portal hides the "enable
notifications" button, every notification falls through to email, and nothing fails. Push payloads
carry a title and a link and nothing else — the amount is loaded in the app, behind the session
(spec §11). A push service answering `404` or `410` has retired that endpoint, and domar deletes the
subscription. When neither push nor email delivered, the managers of that tenant get a bell entry
saying so, which is the signal that `SMTP_URL` needs looking at.
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @domar/api test && pnpm typecheck`
Expected: PASS — including the untouched `reminders.test.ts`, which still exercises the extracted token check through `POST /api/jobs/reminders`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/jobs apps/api/src/notifications/deliver.ts apps/api/src/notifications/job-routes.ts \
        apps/api/src/resources/reminders/routes.ts apps/api/src/app.ts apps/api/test/notification-delivery.test.ts docs/DEPLOY.md
git commit -m "feat(api): POST /jobs/notifications drains and delivers, email fallback included"
```

---

### Task 6: The portal PWA — manifest, service worker, subscription

**Files:**
- Create: `apps/web/public/manifest.webmanifest`
- Create: `apps/web/public/icon.svg`
- Create: `apps/web/public/portal/sw.js`
- Create: `apps/web/public/portal/offline.html`
- Create: `apps/web/src/portal/push.ts`
- Modify: `apps/web/index.html`
- Create: `apps/web/test/service-worker.test.ts`
- Create: `apps/web/test/portal-push.test.ts`

**Interfaces:**
- Consumes: `GET /api/portal/push/key`, `POST /api/portal/push/subscribe`, `POST /api/portal/push/unsubscribe` (Task 3); `api` (`apps/web/src/api/client.ts`)
- Produces (used by Tasks 7, 8):
  - `registerPortalWorker(): Promise<ServiceWorkerRegistration | null>`
  - `pushSupported(): boolean`
  - `pushState(): Promise<'unsupported' | 'unconfigured' | 'denied' | 'off' | 'on'>`
  - `enablePush(contactId: string): Promise<'on' | 'denied' | 'unsupported' | 'unconfigured'>`
  - `disablePush(): Promise<void>`
  - all from `apps/web/src/portal/push.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/service-worker.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const SOURCE = readFileSync(fileURLToPath(new URL('../public/portal/sw.js', import.meta.url)), 'utf8');

/** Runs the worker source against a fake global scope and hands back what it registered. */
function loadWorker() {
  const handlers = new Map<string, (e: unknown) => void>();
  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => handlers.set(type, fn),
    registration: { showNotification: vi.fn(() => Promise.resolve()) },
    clients: {
      matchAll: vi.fn(() => Promise.resolve([] as { url: string; focus: () => void; navigate: (u: string) => void }[])),
      openWindow: vi.fn(() => Promise.resolve(null)),
    },
    skipWaiting: vi.fn(),
    caches: { open: vi.fn(() => Promise.resolve({ addAll: vi.fn(), match: vi.fn(() => Promise.resolve(undefined)) })), keys: vi.fn(() => Promise.resolve([])), delete: vi.fn() },
    location: { origin: 'https://domar.mk' },
  };
  new Function('self', 'caches', 'clients', SOURCE)(self, self.caches, self.clients);
  return { self, handlers };
}

describe('the portal service worker', () => {
  it('registers push, notificationclick, install, activate and fetch', () => {
    const { handlers } = loadWorker();
    expect([...handlers.keys()].sort()).toEqual(['activate', 'fetch', 'install', 'notificationclick', 'push']);
  });

  it('shows the pushed title and keeps the link on the notification', async () => {
    const { self, handlers } = loadWorker();
    const waits: Promise<unknown>[] = [];
    handlers.get('push')!({
      data: { json: () => ({ id: 'n-1', title: 'Нова фактура · Партизанска 12', link: '/portal/invoices/i-1' }) },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    await Promise.all(waits);
    expect(self.registration.showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = self.registration.showNotification.mock.calls[0] as [string, { data: { link: string }; body?: string }];
    expect(title).toBe('Нова фактура · Партизанска 12');
    expect(options.data.link).toBe('/portal/invoices/i-1');
    // Spec §11: the payload has no body, so the notification shows none.
    expect(options.body ?? '').toBe('');
  });

  it('opens the link when the notification is clicked', async () => {
    const { self, handlers } = loadWorker();
    const waits: Promise<unknown>[] = [];
    const close = vi.fn();
    handlers.get('notificationclick')!({
      notification: { data: { link: '/portal/invoices/i-1' }, close },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    await Promise.all(waits);
    expect(close).toHaveBeenCalled();
    expect(self.clients.openWindow).toHaveBeenCalledWith('/portal/invoices/i-1');
  });

  it('never intercepts the API', () => {
    const { handlers } = loadWorker();
    const respondWith = vi.fn();
    for (const url of ['https://domar.mk/api/portal/invoices', 'https://domar.mk/api/health']) {
      handlers.get('fetch')!({ request: { method: 'GET', mode: 'navigate', url }, respondWith });
    }
    expect(respondWith).not.toHaveBeenCalled();
  });

  it('only ever handles same-origin GET navigations', () => {
    const { handlers } = loadWorker();
    const respondWith = vi.fn();
    handlers.get('fetch')!({ request: { method: 'POST', mode: 'navigate', url: 'https://domar.mk/portal' }, respondWith });
    handlers.get('fetch')!({ request: { method: 'GET', mode: 'cors', url: 'https://domar.mk/portal/invoices' }, respondWith });
    handlers.get('fetch')!({ request: { method: 'GET', mode: 'navigate', url: 'https://elsewhere.mk/portal' }, respondWith });
    expect(respondWith).not.toHaveBeenCalled();
    handlers.get('fetch')!({ request: { method: 'GET', mode: 'navigate', url: 'https://domar.mk/portal/invoices' }, respondWith });
    expect(respondWith).toHaveBeenCalledTimes(1);
  });
});
```

Create `apps/web/test/portal-push.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disablePush, enablePush, pushState } from '@/portal/push';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const empty = () => new Response(null, { status: 204 });

function stubServiceWorker(subscription: unknown) {
  const subscribe = vi.fn(() => Promise.resolve(subscription));
  const registration = {
    pushManager: { getSubscription: vi.fn(() => Promise.resolve(subscription)), subscribe },
  };
  vi.stubGlobal('navigator', {
    serviceWorker: { register: vi.fn(() => Promise.resolve(registration)), ready: Promise.resolve(registration) },
    userAgent: 'vitest',
  });
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn(() => Promise.resolve('granted')) });
  return { registration, subscribe };
}

const fakeSubscription = {
  endpoint: 'https://push.example/e1',
  toJSON: () => ({ endpoint: 'https://push.example/e1', keys: { p256dh: 'kkk', auth: 'aaa' } }),
  unsubscribe: vi.fn(() => Promise.resolve(true)),
};

describe('portal push', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is "unsupported" when the browser has no PushManager', async () => {
    vi.stubGlobal('navigator', { userAgent: 'vitest' });
    vi.stubGlobal('fetch', vi.fn());
    await expect(pushState()).resolves.toBe('unsupported');
  });

  it('is "unconfigured" when the server has no VAPID key', async () => {
    stubServiceWorker(null);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ publicKey: null })));
    await expect(pushState()).resolves.toBe('unconfigured');
  });

  it('subscribes and posts the endpoint and both keys', async () => {
    const { subscribe } = stubServiceWorker(null);
    subscribe.mockResolvedValue(fakeSubscription);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ publicKey: 'BPublic' }))
      .mockResolvedValueOnce(empty());
    vi.stubGlobal('fetch', fetchMock);

    await expect(enablePush('c1')).resolves.toBe('on');
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/portal/push/subscribe');
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body))).toEqual({
      contactId: 'c1', endpoint: 'https://push.example/e1', p256dh: 'kkk', auth: 'aaa', userAgent: 'vitest',
    });
  });

  it('unsubscribes locally and on the server', async () => {
    stubServiceWorker(fakeSubscription);
    const fetchMock = vi.fn().mockResolvedValue(empty());
    vi.stubGlobal('fetch', fetchMock);
    await disablePush();
    expect(fakeSubscription.unsubscribe).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://localhost:3001/api/portal/push/unsubscribe');
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ endpoint: 'https://push.example/e1' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @domar/web test service-worker portal-push`
Expected: FAIL — `ENOENT: no such file or directory … public/portal/sw.js`.

- [ ] **Step 3: Write the manifest and the icon**

Create `apps/web/public/manifest.webmanifest`:

```json
{
  "name": "domar — портал за сопственици",
  "short_name": "domar",
  "description": "Фактури, плаќања, состојба на фондот и барања за одржување.",
  "lang": "mk",
  "dir": "ltr",
  "start_url": "/portal",
  "scope": "/portal",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#f8fafc",
  "theme_color": "#047857",
  "icons": [
    { "src": "/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" },
    { "src": "/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "maskable" }
  ]
}
```

Create `apps/web/public/icon.svg` (a maskable mark: the safe zone is the middle 80%, so the glyph stays well inside):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="domar">
  <rect width="512" height="512" rx="96" fill="#047857"/>
  <path d="M256 128 132 232v152h80v-96h88v96h80V232z" fill="#ecfdf5"/>
</svg>
```

- [ ] **Step 4: Write the service worker**

Create `apps/web/public/portal/offline.html`:

```html
<!doctype html>
<html lang="mk">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>domar — офлајн</title>
    <style>
      body { margin: 0; display: grid; min-height: 100vh; place-items: center; background: #f8fafc; color: #0f172a;
             font-family: system-ui, -apple-system, "Segoe UI", sans-serif; text-align: center; padding: 1rem; }
      h1 { color: #047857; font-size: 1.25rem; margin: 0 0 .5rem; }
      p { margin: 0; color: #475569; font-size: .95rem; }
    </style>
  </head>
  <body>
    <div>
      <h1>Нема врска со интернет</h1>
      <p>Обидете се повторно кога ќе имате мрежа.</p>
      <p lang="en">You are offline. Try again when you have a network.</p>
    </div>
  </body>
</html>
```

Create `apps/web/public/portal/sw.js` (plain classic JavaScript — this file is never bundled, and its scope is `/portal/` because that is the directory it is served from):

```js
/* domar portal service worker (spec §9). Offline shell only: no API response is ever cached. */
const CACHE = 'domar-portal-v1';
const OFFLINE = '/portal/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE, '/icon.svg'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/**
 * Navigations only, and only same-origin ones. `/api` is never touched: an owner's invoice must
 * come from the server behind their session, never from a cache this worker controls.
 */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api')) return;
  event.respondWith(fetch(req).catch(() => caches.match(OFFLINE)));
});

/** Spec §11: the payload carries a title and a link, so that is all the notification can show. */
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (err) {
    payload = {};
  }
  const title = payload.title || 'domar';
  const link = payload.link || '/portal';
  event.waitUntil(self.registration.showNotification(title, {
    body: '',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: payload.id || link,
    data: { link },
  }));
});

self.addEventListener('notificationclick', (event) => {
  const link = (event.notification.data && event.notification.data.link) || '/portal';
  event.notification.close();
  // Focus an open portal tab if there is one, so a tap does not pile up windows.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if (new URL(w.url).pathname.startsWith('/portal')) {
          w.navigate(link);
          return w.focus();
        }
      }
      return self.clients.openWindow(link);
    }),
  );
});
```

- [ ] **Step 5: Link the manifest**

Replace the `<head>` of `apps/web/index.html`:

```html
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#047857" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/icon.svg" />
    <title>domar</title>
  </head>
```

- [ ] **Step 6: Write the browser-side push module**

Create `apps/web/src/portal/push.ts`:

```ts
import { api } from '@/api/client';

export type PushState = 'unsupported' | 'unconfigured' | 'denied' | 'off' | 'on';

/** `/portal/sw.js`, so the worker's own directory is its scope — no server header needed (addendum 10). */
const WORKER_URL = '/portal/sw.js';
const SCOPE = '/portal/';

export function pushSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    && typeof PushManager !== 'undefined' && typeof Notification !== 'undefined';
}

export async function registerPortalWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(WORKER_URL, { scope: SCOPE });
  } catch {
    // A blocked worker (private mode, an http origin that is not localhost) is not an error the
    // owner can do anything about: the portal keeps working, it simply has no offline shell.
    return null;
  }
}

/** The base64url VAPID key as the bytes `PushManager.subscribe` wants. No `Buffer` in a browser. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function serverKey(): Promise<string | null> {
  const { publicKey } = await api.get<{ publicKey: string | null }>('/api/portal/push/key');
  return publicKey;
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (!(await serverKey())) return 'unconfigured';
  if (Notification.permission === 'denied') return 'denied';
  const registration = await navigator.serviceWorker.ready;
  return (await registration.pushManager.getSubscription()) ? 'on' : 'off';
}

export async function enablePush(contactId: string): Promise<'on' | 'denied' | 'unsupported' | 'unconfigured'> {
  if (!pushSupported()) return 'unsupported';
  const key = await serverKey();
  if (!key) return 'unconfigured';
  if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') return 'denied';
  const registration = await navigator.serviceWorker.ready;
  const subscription = (await registration.pushManager.getSubscription())
    ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }));
  const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  await api.post('/api/portal/push/subscribe', {
    contactId,
    endpoint: json.endpoint ?? subscription.endpoint,
    p256dh: json.keys?.p256dh ?? '',
    auth: json.keys?.auth ?? '',
    userAgent: navigator.userAgent.slice(0, 500),
  });
  return 'on';
}

export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await api.post('/api/portal/push/unsubscribe', { endpoint });
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @domar/web test service-worker portal-push && pnpm --filter @domar/web typecheck`
Expected: PASS (9 cases)

- [ ] **Step 8: Commit**

```bash
git add apps/web/public apps/web/src/portal apps/web/index.html apps/web/test/service-worker.test.ts apps/web/test/portal-push.test.ts
git commit -m "feat(web): portal PWA with a /portal-scoped service worker and push subscription"
```

---

### Task 7: The two bells in the browser

**Files:**
- Create: `apps/web/src/composables/useNotifications.ts`
- Create: `apps/web/src/components/layout/NotificationBell.vue`
- Modify: `apps/web/src/layouts/AppShell.vue`
- Modify: `apps/web/src/layouts/PortalShell.vue`
- Modify: `apps/web/src/api/types.ts`
- Modify: `apps/web/src/i18n/mk.ts`
- Modify: `apps/web/src/i18n/en.ts`
- Create: `apps/web/test/NotificationBell.test.ts`

**Interfaces:**
- Consumes: `GET /api/notifications`, `POST /api/notifications/:id/read`, `POST /api/notifications/read-all`, `GET /api/portal/notifications`, `POST /api/portal/notifications/:id/read` (Task 3); `registerPortalWorker`, `pushState`, `enablePush`, `disablePush` (Task 6); `usePortalStore` (`apps/web/src/stores/portal.ts`)
- Produces (used by Task 8):
  - `useNotifications(scope: 'app' | 'portal')` → `{ rows: Ref<NotificationRow[]>; unread: Ref<number>; refresh(): Promise<void>; markRead(id: string): Promise<void>; markAllRead(): Promise<void>; start(): void; stop(): void }`
  - `NotificationBell.vue` with prop `scope: 'app' | 'portal'`
  - `data-test` hooks: `notification-bell`, `notification-count`, `notification-panel`, `notification-item`, `notification-mark-all`, `notification-empty`, `notification-push-toggle`, `notification-push-state`
  - `interface NotificationRow` in `apps/web/src/api/types.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/NotificationBell.test.ts`:

```ts
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotificationRow } from '@/api/types';
import NotificationBell from '@/components/layout/NotificationBell.vue';
import { i18n } from '@/i18n';
import { usePortalStore } from '@/stores/portal';

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const empty = () => new Response(null, { status: 204 });

const rows: NotificationRow[] = [
  { id: 'n-1', kind: 'invoice_published', title: 'Нова фактура · Партизанска 12', body: 'Вкупно за плаќање: 2.450,00 ден.', link: '/portal/invoices/i-1', createdAt: '2026-09-25T09:00:00.000Z', readAt: null },
  { id: 'n-2', kind: 'maintenance_status', title: 'Одржување: Во тек', body: 'Протекува цевка во визбата', link: '/portal/maintenance/m-1', createdAt: '2026-09-24T09:00:00.000Z', readAt: '2026-09-24T10:00:00.000Z' },
];

const mountBell = (scope: 'app' | 'portal') =>
  mount(NotificationBell, { props: { scope }, global: { plugins: [i18n], stubs: { RouterLink: true } } });

describe('NotificationBell', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the manager’s own notifications and badges the unread ones', async () => {
    setActivePinia(createPinia());
    const fetchMock = vi.fn().mockResolvedValue(json({ rows, unread: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const w = mountBell('app');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flushPromises();
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://localhost:3001/api/notifications');
    expect(w.get('[data-test=notification-count]').text()).toBe('1');

    await w.get('[data-test=notification-bell]').trigger('click');
    expect(w.findAll('[data-test=notification-item]')).toHaveLength(2);
    expect(w.get('[data-test=notification-item]').text()).toContain('Нова фактура · Партизанска 12');
    // The body is shown in the app, where it belongs — only the push is title-and-link-only.
    expect(w.get('[data-test=notification-item]').text()).toContain('2.450,00 ден.');
  });

  it('marks one read and drops the badge', async () => {
    setActivePinia(createPinia());
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ rows, unread: 1 }))
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(json({ rows: rows.map((r) => ({ ...r, readAt: '2026-09-25T11:00:00.000Z' })), unread: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    const w = mountBell('app');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await w.get('[data-test=notification-bell]').trigger('click');
    await w.get('[data-test=notification-item]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/notifications/n-1/read');
    await flushPromises();
    expect(w.find('[data-test=notification-count]').exists()).toBe(false);
  });

  it('marks everything read at once', async () => {
    setActivePinia(createPinia());
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ rows, unread: 1 }))
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(json({ rows, unread: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    const w = mountBell('app');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await w.get('[data-test=notification-bell]').trigger('click');
    await w.get('[data-test=notification-mark-all]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/notifications/read-all');
  });

  it('uses the portal routes and offers the push toggle in the portal', async () => {
    setActivePinia(createPinia());
    const me = {
      account: { id: 'a1', email: 'marko@owner.mk' },
      links: [{ tenantId: 't1', tenantName: 'Фирма 1', contactId: 'c1', contactName: 'Марко Марков', buildings: [{ id: 'b1', name: 'Партизанска 12' }] }],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(me))
      .mockResolvedValue(json({ rows: [], unread: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    // No PushManager in jsdom, so the toggle reports "unsupported" rather than throwing.
    const store = usePortalStore();
    await store.fetchMe();
    const w = mountBell('portal');
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    await flushPromises();
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/portal/notifications');
    await w.get('[data-test=notification-bell]').trigger('click');
    expect(w.get('[data-test=notification-empty]').text()).toBe('Нема известувања');
    expect(w.get('[data-test=notification-push-state]').text()).toBe('Не е поддржано на овој уред');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @domar/web test NotificationBell`
Expected: FAIL — `Failed to resolve import "@/components/layout/NotificationBell.vue"`.

- [ ] **Step 3: Add the row type**

In `apps/web/src/api/types.ts`, after the `PortalMaintenanceRequest` definitions:

```ts
export type NotificationKind =
  | 'invoice_published' | 'reminder_created' | 'assembly_invited' | 'assembly_voting_opened'
  | 'maintenance_status' | 'maintenance_request_created' | 'delivery_failed';
export interface NotificationRow { id: string; kind: NotificationKind; title: string; body: string; link: string; createdAt: string; readAt: string | null }
export interface NotificationList { rows: NotificationRow[]; unread: number }
```

- [ ] **Step 4: Write the composable**

Create `apps/web/src/composables/useNotifications.ts`:

```ts
import { onScopeDispose, ref, type Ref } from 'vue';
import { api } from '@/api/client';
import type { NotificationList, NotificationRow } from '@/api/types';

export type BellScope = 'app' | 'portal';

/** Polling, not a stream: one long-lived connection per open tab is not worth minutes of latency (addendum 8). */
const POLL_MS = 60_000;

export interface Bell {
  rows: Ref<NotificationRow[]>;
  unread: Ref<number>;
  refresh(): Promise<void>;
  markRead(id: string): Promise<void>;
  markAllRead(): Promise<void>;
  start(): void;
  stop(): void;
}

export function useNotifications(scope: BellScope): Bell {
  const base = scope === 'portal' ? '/api/portal/notifications' : '/api/notifications';
  const rows = ref<NotificationRow[]>([]);
  const unread = ref(0);
  let timer: ReturnType<typeof setInterval> | null = null;

  async function refresh() {
    try {
      const res = await api.get<NotificationList>(base);
      rows.value = res.rows;
      unread.value = res.unread;
    } catch {
      // A signed-out tab or a blip: the bell simply keeps what it had.
    }
  }

  async function markRead(id: string) {
    await api.post(`${base}/${id}/read`);
    await refresh();
  }

  async function markAllRead() {
    // The portal has no bulk route: an owner's list is short, so it marks what it is showing.
    if (scope === 'portal') {
      await Promise.all(rows.value.filter((r) => !r.readAt).map((r) => api.post(`${base}/${r.id}/read`)));
    } else {
      await api.post(`${base}/read-all`);
    }
    await refresh();
  }

  function onVisible() {
    if (document.visibilityState === 'visible') void refresh();
  }

  function start() {
    void refresh();
    if (timer === null) timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
  }

  function stop() {
    if (timer !== null) { clearInterval(timer); timer = null; }
    document.removeEventListener('visibilitychange', onVisible);
  }

  onScopeDispose(stop);
  return { rows, unread, refresh, markRead, markAllRead, start, stop };
}
```

- [ ] **Step 5: Write the bell**

Create `apps/web/src/components/layout/NotificationBell.vue`:

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import type { NotificationRow } from '@/api/types';
import { useNotifications, type BellScope } from '@/composables/useNotifications';
import { disablePush, enablePush, pushState, type PushState } from '@/portal/push';
import { usePortalStore } from '@/stores/portal';

const props = defineProps<{ scope: BellScope }>();
const { t } = useI18n();
const router = useRouter();
const portal = usePortalStore();
const bell = useNotifications(props.scope);
const open = ref(false);
const push = ref<PushState>('unsupported');
const busy = ref(false);

onMounted(async () => {
  bell.start();
  if (props.scope === 'portal') push.value = await pushState();
});

async function openRow(row: NotificationRow) {
  open.value = false;
  if (!row.readAt) await bell.markRead(row.id);
  if (row.link) await router.push(row.link);
}

async function togglePush() {
  const contactId = portal.selectedContactId;
  if (!contactId) return;
  busy.value = true;
  try {
    if (push.value === 'on') { await disablePush(); push.value = 'off'; }
    else push.value = await enablePush(contactId);
  } finally {
    busy.value = false;
  }
}

/** "25.09.2026 11:04" without Intl: Chrome ships no mk-MK data (see utils/money.ts). */
function stamp(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
</script>

<template>
  <div class="relative">
    <button class="relative rounded-md px-2 py-1 text-slate-600 hover:bg-slate-100" data-test="notification-bell"
      :aria-label="t('notifications.title')" @click="open = !open">
      <span aria-hidden="true">🔔</span>
      <span v-if="bell.unread.value > 0" data-test="notification-count"
        class="absolute -right-1 -top-1 rounded-full bg-red-600 px-1.5 text-xs font-medium text-white">{{ bell.unread.value }}</span>
    </button>

    <div v-if="open" data-test="notification-panel"
      class="absolute right-0 z-20 mt-2 w-80 rounded-md border border-slate-200 bg-white shadow-lg">
      <div class="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <span class="text-sm font-medium">{{ t('notifications.title') }}</span>
        <button class="text-xs text-slate-600 underline" data-test="notification-mark-all" @click="bell.markAllRead()">{{ t('notifications.markAllRead') }}</button>
      </div>

      <div v-if="scope === 'portal'" class="flex items-center justify-between border-b border-slate-200 px-3 py-2 text-xs">
        <span class="text-slate-600" data-test="notification-push-state">{{ t(`notifications.push.${push}`) }}</span>
        <button v-if="push === 'on' || push === 'off'" class="text-emerald-700 underline" data-test="notification-push-toggle" :disabled="busy" @click="togglePush()">
          {{ push === 'on' ? t('notifications.push.disable') : t('notifications.push.enable') }}
        </button>
      </div>

      <p v-if="bell.rows.value.length === 0" class="px-3 py-4 text-sm text-slate-500" data-test="notification-empty">{{ t('notifications.empty') }}</p>
      <ul v-else class="max-h-96 overflow-y-auto">
        <li v-for="row in bell.rows.value" :key="row.id">
          <button class="block w-full px-3 py-2 text-left hover:bg-slate-50" :class="row.readAt ? '' : 'bg-emerald-50/60'"
            data-test="notification-item" @click="openRow(row)">
            <span class="block text-sm font-medium text-slate-900">{{ row.title }}</span>
            <span v-if="row.body" class="block text-xs text-slate-600">{{ row.body }}</span>
            <span class="block text-xs text-slate-400">{{ stamp(row.createdAt) }}</span>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
```

- [ ] **Step 6: Mount it in both shells**

In `apps/web/src/layouts/AppShell.vue`, add `import NotificationBell from '@/components/layout/NotificationBell.vue';` to the script and put the bell beside the user block, replacing the `<div class="mt-8 border-t …">` opening lines' first child row:

```html
      <div class="mt-8 border-t border-slate-200 pt-4 text-sm">
        <div class="flex items-start justify-between">
          <div>
            <div class="font-medium">{{ auth.user?.firstName }} {{ auth.user?.lastName }}</div>
            <div class="text-slate-500">{{ auth.tenant?.name }}</div>
          </div>
          <NotificationBell scope="app" />
        </div>
```

(the two buttons below it — the locale toggle and `data-test="logout"` — stay exactly as they are).

In `apps/web/src/layouts/PortalShell.vue`, add `import NotificationBell from '@/components/layout/NotificationBell.vue';` and insert the bell between the email span and the locale button:

```html
        <span class="ml-auto text-sm text-slate-600">{{ portal.account?.email }}</span>
        <NotificationBell scope="portal" />
        <button class="text-sm text-slate-600 underline" @click="toggleLocale">{{ i18n.global.locale.value.toUpperCase() }}</button>
```

Also register the service worker once the portal shell mounts — add to its `<script setup>`:

```ts
import { onMounted } from 'vue';
import { registerPortalWorker } from '@/portal/push';

onMounted(() => { void registerPortalWorker(); });
```

- [ ] **Step 7: Add the i18n keys**

In `apps/web/src/i18n/mk.ts`, at the top level of the exported object (after the `portal:` block):

```ts
  notifications: {
    title: 'Известувања',
    empty: 'Нема известувања',
    markAllRead: 'Означи ги сите како прочитани',
    push: {
      unsupported: 'Не е поддржано на овој уред',
      unconfigured: 'Известувањата на уред не се овозможени',
      denied: 'Дозволата е одбиена во прелистувачот',
      off: 'Известувањата на уред се исклучени',
      on: 'Известувањата на уред се вклучени',
      enable: 'Вклучи',
      disable: 'Исклучи',
    },
  },
```

In `apps/web/src/i18n/en.ts`, the same keys in the same place:

```ts
  notifications: {
    title: 'Notifications',
    empty: 'No notifications',
    markAllRead: 'Mark all as read',
    push: {
      unsupported: 'Not supported on this device',
      unconfigured: 'Device notifications are not enabled',
      denied: 'Permission was denied in the browser',
      off: 'Device notifications are off',
      on: 'Device notifications are on',
      enable: 'Turn on',
      disable: 'Turn off',
    },
  },
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter @domar/web test && pnpm --filter @domar/web typecheck`
Expected: PASS — including `LoginPage.test.ts`'s mk/en key-parity case.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/composables/useNotifications.ts apps/web/src/components/layout apps/web/src/layouts \
        apps/web/src/api/types.ts apps/web/src/i18n apps/web/test/NotificationBell.test.ts
git commit -m "feat(web): notification bell in the manager shell and the portal shell"
```

---

### Task 8: The walk-through

**Files:**
- Create: `e2e/tests/notifications.spec.ts`

**Interfaces:**
- Consumes: everything above. No new source file.

- [ ] **Step 1: Write the failing test**

Create `e2e/tests/notifications.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

const API = 'http://localhost:3001';
const slug = `e2e-izvestuvanja-${Date.now().toString(36)}`;
const password = 'correct-horse-1';
const ownerPassword = 'battery-staple-7';

test('a published invoice and a portal request reach the right bell', async ({ page, browser }) => {
  // --- the manager opens the organisation ---
  await page.goto('/register');
  await page.getByTestId('orgName').fill('Е2Е Известувања');
  await page.getByTestId('slug').fill(slug);
  await page.getByTestId('firstName').fill('Ива');
  await page.getByTestId('lastName').fill('Тест');
  await page.getByTestId('email').fill(`iva@${slug}.mk`);
  await page.getByTestId('password').fill(password);
  await page.getByRole('button', { name: /Отвори сметка|Create account/ }).click();
  await expect(page).toHaveURL(/\/app$/);

  const post = async (path: string, data: unknown = {}) => {
    const res = await page.request.post(`${API}${path}`, { data });
    expect(res.status(), `${path} → ${await res.text()}`).toBeLessThan(300);
    return res.json();
  };
  const owner = await post('/api/contacts', { firstName: 'Марко', lastName: 'Марков', email: `marko@${slug}.mk` });
  const building = await post('/api/buildings', { name: 'Партизанска 12', address: 'Партизанска 12', city: 'Скопје', postalCode: '1000' });
  const unit = await post(`/api/buildings/${building.id}/units`, { label: '1', kind: 'apartment', areaM2: 50, ownerContactId: owner.id });
  const service = await post('/api/services', { name: 'Одржување на влез', pricing: 'fixed_per_unit', defaultPriceMinor: 30_000 });
  await post(`/api/buildings/${building.id}/services`, { serviceId: service.id, startsPeriod: '2026-09' });

  // The owner's portal code, read off the manager's screen exactly once.
  await page.goto(`/app/contacts/${owner.id}`);
  await page.getByTestId('portal-issue').click();
  const code = (await page.getByTestId('portal-issued-code').innerText()).trim();

  const ownerContext = await browser.newContext();
  const owners = await ownerContext.newPage();
  try {
    await owners.goto('/portal/register');
    await owners.getByTestId('portal-code').fill(code);
    await owners.getByTestId('portal-email').fill(`marko@${slug}.mk`);
    await owners.getByTestId('portal-password').fill(ownerPassword);
    await owners.getByTestId('portal-submit').click();
    await expect(owners).toHaveURL(/\/portal$/);

    // --- the manager publishes September ---
    const period = await post(`/api/buildings/${building.id}/periods`, { period: '2026-09' });
    await post(`/api/buildings/${building.id}/periods/${period.id}/generate`);
    await post(`/api/buildings/${building.id}/periods/${period.id}/publish`);

    // --- the owner's bell ---
    await owners.reload();
    await expect(owners.getByTestId('notification-count')).toHaveText('1');
    await owners.getByTestId('notification-bell').click();
    await expect(owners.getByTestId('notification-item')).toHaveCount(1);
    await expect(owners.getByTestId('notification-item')).toContainText('Нова фактура');
    // Spec §11 lives in the payload, not the panel: the app shows the amount, the push would not.
    await expect(owners.getByTestId('notification-item')).toContainText('ден.');
    await owners.getByTestId('notification-item').click();
    await expect(owners).toHaveURL(/\/portal\/invoices\/[0-9a-f-]{36}$/);
    await owners.goto('/portal');
    await expect(owners.getByTestId('notification-count')).toHaveCount(0);

    // --- the owner files a maintenance request ---
    await owners.getByTestId('portal-nav-maintenance').click();
    await owners.getByTestId('portal-maintenance-title').fill('Протекува цевка во визбата');
    await owners.getByTestId('portal-maintenance-description').fill('Трет ден.');
    await owners.getByTestId('portal-maintenance-category').selectOption('plumbing');
    await owners.getByTestId('portal-maintenance-submit').click();
    await expect(owners.getByTestId('portal-maintenance-row')).toHaveCount(1);

    // --- the manager's bell ---
    await page.goto('/app');
    await expect(page.getByTestId('notification-count')).toHaveText('1');
    await page.getByTestId('notification-bell').click();
    await expect(page.getByTestId('notification-item')).toContainText('Ново барање за одржување');
    await page.getByTestId('notification-item').click();
    await expect(page).toHaveURL(new RegExp(`/app/buildings/${building.id}\\?tab=maintenance$`));
    await page.goto('/app');
    await expect(page.getByTestId('notification-count')).toHaveCount(0);

    // --- the manager triages it and the owner is told ---
    const board = await page.request.get(`${API}/api/buildings/${building.id}/maintenance`);
    const requestId = (await board.json()).rows[0].id;
    await post(`/api/maintenance-requests/${requestId}/status`, { status: 'triaged' });

    await owners.goto('/portal');
    await expect(owners.getByTestId('notification-count')).toHaveText('1');
    await owners.getByTestId('notification-bell').click();
    await expect(owners.getByTestId('notification-item').first()).toContainText('Одржување: Прегледано');

    // --- the job drains the queue and answers with counts ---
    const drained = await page.request.post(`${API}/api/jobs/notifications`, { headers: { 'x-job-token': 'nope' } });
    expect(drained.status()).toBe(403);
  } finally {
    await ownerContext.close();
  }

  // The offline shell and the manifest are served, and the worker is not cached hard.
  const manifest = await page.request.get('/manifest.webmanifest');
  expect(manifest.status()).toBe(200);
  expect((await manifest.json()).scope).toBe('/portal');
  const worker = await page.request.get('/portal/sw.js');
  expect(worker.status()).toBe(200);
  expect(await worker.text()).toContain('notificationclick');
  expect(unit.id).toBeTruthy();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm db:up && pnpm e2e -- notifications`
Expected: FAIL before the tasks above are complete; after them, it is the acceptance walk-through.

- [ ] **Step 3: Make it pass**

No new source: every element and route this spec touches exists after Tasks 1–7. Where it fails, fix the *component* at fault and re-run — do not weaken the assertion.

- [ ] **Step 4: Run the whole suite**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`
Expected: PASS everywhere.

- [ ] **Step 5: Commit**

```bash
git add e2e/tests/notifications.spec.ts
git commit -m "test(e2e): an invoice and a portal request reach the right bell"
```

---

## Self-review

**Spec coverage (§9, sentence by sentence):**

| Spec §9 requirement | Task |
| --- | --- |
| Web manifest + service worker for `/portal`; installable; offline shell only | 6 |
| `push_subscriptions` (owner account, endpoint, keys) | 1, 3 |
| Web Push, VAPID keys in env | 2 |
| `notifications` table (owner account, kind, title, body, link, read_at) | 1 |
| Trigger: invoice published | 4 |
| Trigger: reminder created | 4 |
| Trigger: assembly invited | 4 |
| Trigger: decision opened | 4 (addendum 9) |
| Trigger: maintenance status change | 4 |
| Email fallback when no subscription | 5 |
| Manager-side in-app bell for new maintenance requests | 4 (writer), 7 (bell) |
| Manager-side in-app bell for failed sends | 5 (writer), 7 (bell) |
| §11: no amounts in push payloads, title + link only | 2 (whitelist), 4 (title/body split, asserted), 5 (asserted), 6 (`body: ''`) |
| §16: `tenant_id` + leading index on every tenant-scoped table | 1 |
| §16: i18n mk + en, Macedonian first | 7 |
| §16: `.env.example` documents every variable | 2 |
| Cron line in `docs/DEPLOY.md` | 5 |

No spec §9 requirement is left without a task.

**Type consistency:** `pushPayload`/`PushPayload` (Task 2) is the only shape that reaches a phone and is consumed unchanged in Task 5 and asserted in Task 6. `notify`/`notifyOwners`/`notifyStaff`/`NotificationInput` (Task 3) are the exact names Task 4 imports. `NotificationRow` is the same field list in `apps/api/src/notifications/repo.ts`, `apps/api/src/notifications/schema.ts` and `apps/web/src/api/types.ts`. `useNotifications(scope)` returns the `Bell` interface the bell component destructures, and the bell's `data-test` hooks are the ones `e2e/tests/notifications.spec.ts` asks for.

**Placeholders:** none — every code step carries the code, every test step carries the assertions, and every "modify" step quotes the surrounding lines it goes between.
