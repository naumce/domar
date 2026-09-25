# Domar Maintenance (spec §8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner opens the portal at half past eleven at night, presses **Ново барање**, types "Протекува цевка во визбата", picks **Водовод**, attaches a photo of the puddle and sends it. The manager's building screen gains a **Одржување** board with a card in the **Ново** column. She presses **Прими**, then **Додели** and picks Стефан — the tenant's `technician` user — so the card moves to **Доделено**. Stefan signs in, sees exactly one request (his), presses **Започни**, adds the note "Заменета спојка, фатено во 40 минути" and a photo of the repaired joint. The manager presses **Затвори со трошок**, types 12.000 den on the **резервен фонд** and picks the supplier: domar creates the expense through the very same flow the Trošoci tab uses, books the posting, links `expense_id` on the request, writes `maintenance.status` into the audit log and closes the card in **Завршено**. The reserve fund's balance drops by 12.000 den on the fund page, the expense appears in the fund transactions, and the owner — refreshing the portal — sees **Завршено** with the manager's owner-visible note and the two photos. The `technician` role, which until today could write nothing anywhere in domar, has a job.

**Architecture:** `packages/db` gains **one migration, 0012**, with three tables — `maintenance_requests`, `maintenance_events`, `maintenance_photos` — and five enums. `@domar/domain` gains `src/maintenance/status.ts`: the transition graph and the role capability matrix as pure data, plus the seven maintenance categories on the country pack, so both the API and the tests read one table of truth instead of restating it. `apps/api` gains `resources/maintenance/{schema,repo,photos,routes}.ts` (the board, the transitions, the events, the assignment, the photo store) and `portal/{maintenance-repo,maintenance-routes}.ts` (the owner's five routes). **No new money path:** closing with a cost calls the existing `createExpense` inside the closing transaction, which books the existing `expense` posting — spec §11's "maintenance costs reach the ledger only through the existing expense flows" is satisfied by calling that function and by adding no posting kind. **No legal event:** maintenance is not a duty of 160/2025, the compliance screen is untouched and `legal_event_kind` gains no label. `apps/web` gains `components/building/MaintenanceTab.vue` + `components/maintenance/MaintenancePanel.vue` and `pages/portal/{PortalMaintenancePage,PortalMaintenanceRequestPage}.vue`. `e2e/tests/maintenance.spec.ts` walks the whole story above with four browser contexts' worth of identities in two.

**Tech Stack:** unchanged (Node 24, pnpm 10, TS strict, ESM, Fastify 5 + zod, Drizzle 0.36 + Postgres 16, Vue 3 + Vite + vue-i18n + Tailwind 4, Vitest, Playwright 1.63.0). **No new dependency, no new environment variable.** The document store (`documents/store.ts`), `createDocument` with its `allow` allowlist parameter, `@fastify/multipart` (already registered globally in `app.ts`), `createExpense` (`resources/reserve-fund/repo.ts`), `writeAudit`, `resolveLink`/`assertOwnsUnitIn` (`portal/repo.ts`) and `requireRole`/`WRITE_ROLES` are all reused as they are.

**Spec:** `docs/superpowers/specs/2026-09-24-domar-phase2-design.md` §8 (maintenance — the binding section), §10 (roles: `technician` gains maintenance access and read on buildings; `readonly` reads), §4 (documents, photos as `kind photo`, the storage rules), §11 (invariants — in particular "maintenance costs reach the ledger only through the existing … expense flows; no new posting kinds"). Phase 1: `docs/superpowers/specs/2026-09-21-domar-phase1-design.md` §16 (global constraints), §10 (auth and tenancy), §11 (API shape), §12 (web), §19 (the portal). Previous plans: `2026-09-25-10-reports.md` (this plan's style; `NewDocument.allow`, `GENERATED_MIME`), `2026-09-25-09-assembly.md` (the claim-first `UPDATE … WHERE status IN (…) RETURNING` pattern, the portal's one POST), `2026-09-24-08-compliance.md` (the document store and its multipart route).

## Global Constraints

From Phase 1 spec §16, verbatim:

- Node `>=24`, pnpm `>=10`, TypeScript strict, ESM only.
- Postgres 16; schema must run unchanged on Supabase Postgres (no superuser-only extensions; `pgcrypto`/`uuid-ossp` allowed).
- Every tenant-scoped table has `tenant_id uuid not null` and an index starting with it.
- Money columns: `bigint`, suffix `_minor`. Never `float`.
- All user-facing strings in the web app go through i18n; Macedonian first, English second.
- No secrets in the repo; `.env.example` documents every variable.
- Commit after every green test cycle; conventional commit messages.

Project conventions that are equally binding here:

- **Money is integer minor units** everywhere (`number` in TS, `bigint` in Postgres). Amounts on the wire end in `Minor`. This sub-plan adds exactly one money column, `maintenance_requests.cost_minor`, and it is `bigint`.
- **Tenant filter on every statement.** Every new repo function takes `(db, ctx, …)` and every `where` starts with `eq(X.tenantId, ctx.tenantId)`. No exceptions, including the three new tables and every join onto them.
- **An audit row is written inside the same transaction as every mutation** (`writeAudit(tx, ctx, …)`). A `maintenance_events` row is *not* a substitute for an audit row: the two are written side by side, the event being the user-facing feed and the audit row the tamper log.
- **Role gating:** reads are behind `app.requireAuth` (every role, `readonly` included); writes are behind `requireRole(...WRITE_ROLES)` (`owner`, `accountant`) except the three maintenance routes a technician needs, which are behind `requireRole(...MAINTENANCE_ROLES)` and additionally scoped inside the repo.
- **Error envelope:** `{ error: { code, message, details? } }` via `AppError`/`notFound`/`badRequest`/`conflict`. A row of another tenant is always `404`, never `403`. A request a technician is not assigned to is also `404`.
- **TS strict with `exactOptionalPropertyTypes`**: never pass an explicit `undefined` into an object typed with an optional property; spread conditionally (`...(x ? { x } : {})`) or use `stripUndefined`.
- **ESM `.js` import specifiers** in every TS import of a local file (`./repo.js`, `../../audit.js`), `import type` for type-only imports (`@typescript-eslint/consistent-type-imports` is an error).
- **i18n mk/en parity**: `apps/web/test/LoginPage.test.ts` asserts `flatKeys(messages.en).sort()` equals `flatKeys(messages.mk).sort()`. Every key added in this plan goes into both files, Macedonian first.
- **`data-test` hooks** on every element an e2e test touches (`testIdAttribute: 'data-test'` in `e2e/playwright.config.ts`).
- Run everything from the repo root. Postgres for tests is the docker-compose service on port 54329 (`pnpm db:up`).
- **Conventional commits**, each ending with your session's co-author trailer, e.g.
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```

Phase 2 spec §11 invariants, verbatim, binding on every task here:

- Legal events are append-only and carry evidence; the compliance screen never reads anything but events plus dates already in the system.
- Every document download checks the tenant and, for portal users, the link (minutes and reports of their building only).
- Uploaded files are stored outside the web root, streamed, never executed, mime-checked, size-capped.
- Extraordinary costs and maintenance costs reach the ledger only through the existing period and expense flows; no new posting kinds.
- Notifications never include amounts in push payloads (title + link only); details load in the app. *(No push ships in this sub-plan; sub-plan 5 owns it. The constraint is recorded so nothing here invents a payload.)*

## Design addendum (decisions not spelled out in the spec)

1. **The reporter is a database check, not a convention.** `maintenance_requests` carries `reported_by_user_id` **and** `reported_by_contact_id`, both nullable, and a table check `maintenance_requests_reporter_chk`: `num_nonnulls(reported_by_user_id, reported_by_contact_id) = 1`. Exactly one is set, enforced by Postgres, because "who reported this" is the one fact the whole board hangs off and an application-only rule is one forgotten code path away from a row nobody can render. Both columns are `on delete no action`, not `set null` — a reporter is evidence — which is also what keeps the check true for the row's whole life: nothing can ever null one of the two columns. `no action` rather than `restrict` on purpose: it is checked at the end of the statement, so deleting a whole tenant still works (the cascade removes the requests in the same statement), while deleting a single reporter is still refused. `assignee_user_id` is `on delete set null`, because an assignment is not evidence and a deactivated technician must not pin a row in place.
2. **The status machine, in full.** `maintenance_status` is `('new','triaged','assigned','in_progress','done','rejected')` and the legal edges are exactly:
   - `new → triaged | assigned | rejected`
   - `triaged → assigned | rejected`
   - `assigned → in_progress | done`
   - `in_progress → done`
   - `done`, `rejected`: terminal, no edge out.
   **Reopening is not allowed.** A request that turned out not to be fixed is a new request, because a status log that can walk backwards stops being evidence of what happened and the cost already booked against the closed one would have to be un-booked to keep the pair honest.
3. **`assigned` is reached only through `POST …/assign`.** The status route's body enum is `('triaged','rejected','in_progress','done')` and refuses `assigned`, because assigning needs an assignee and a request in `assigned` with `assignee_user_id is null` would be a lie the board cannot draw. The pure transition table in `@domar/domain` nevertheless holds the `new|triaged → assigned` edges, because that is the graph; the route schema is the narrower door onto it.
4. **Every transition is claim-first.** `claimRequest(tx, ctx, id, allowed)` is `UPDATE maintenance_requests SET updated_at = now() WHERE tenant_id = … AND id = … AND status IN (allowed) RETURNING *`. No row back means either another tenant's id (re-read, `404`) or a status that moved under us (`409 status_locked`). Two managers pressing **Затвори** at once therefore produce one close and one `409`, and — decisive here — one expense, not two. This is the `claimAssembly` pattern from sub-plan 2, applied to the one table where a double write would cost the building money.
5. **Closing is a decision about money, and it must be made explicitly.** `POST …/status { status: 'done' }` with no `cost` key at all is `400 cost_decision_required`. The caller must send either `{ cost: null }` — closed, nothing to book — or `{ cost: { fund, costMinor, supplierId?, documentId? } }`, which calls `createExpense(tx, ctx, buildingId, …)` **inside the closing transaction**, stamps `fund`, `cost_minor` and `expense_id` on the request and lets the existing flow write the `expense` posting. Nothing in this plan inserts a posting, and no posting kind is added: spec §11 is satisfied by delegation, not by imitation.
6. **A technician may close, but never with a cost.** `MAINTENANCE_CAPABILITIES.technician` is `['progress','close','comment','photo']`: they may move `assigned → in_progress`, `in_progress → done` and `assigned → done`, add events and upload photos to their own requests. A `cost` in the body from a technician is `403 cost_requires_write_role`. Booking money against a building's fund is the accountant's act, and giving it to the role whose whole point is that it sees only its own queue would put a write into the ledger behind the thinnest gate in the system.
7. **A technician sees only what is theirs, and a missing assignment is a 404.** Every read and every write in `resources/maintenance/repo.ts` adds `eq(MR.assigneeUserId, ctx.userId)` to its `where` when `ctx.role === 'technician'`. The list of a building returns their assigned requests in it and nothing else; a `GET` of somebody else's request is `404`, never `403`, exactly as a cross-tenant row is — the technician must not be able to enumerate the board by reading status codes. Reading the *building* is separately fine: spec §10 grants it, `GET /api/buildings/:id` is already behind `requireAuth` alone, and Task 3 asserts that rather than changing it. The alternative — all requests of the tenant read-only — was rejected: a technician is a contractor's account and the free-text description of somebody's flooded flat is not theirs to browse.
8. **Photos are ordinary documents plus a join row.** A photo is a `documents` row with `kind = 'photo'` and the request's `building_id`, and a `maintenance_photos` row bridging it to the request. The join table rather than `documents.maintenance_request_id` because a column on `documents` would make every document of the system carry a maintenance concern it has nothing to do with, and because the join row is the natural place for "who attached it" (`uploaded_by_user_id` / `uploaded_by_contact_id`, an owner being one of the two). `document_id` is unique across the table, so a photo belongs to exactly one request, and the FK is `on delete cascade`, so deleting the document through the ordinary `DELETE /api/documents/:id` takes the join row with it instead of leaving a gallery entry pointing at nothing. `deleteDocument` is therefore **not** edited.
9. **Photos get their own route, not a widened multipart route.** `POST /api/maintenance-requests/:id/photos` and `POST /api/portal/maintenance/:id/photos`, both multipart, both reusing `createDocument` and `app.documents`. Adding an optional `maintenanceRequestId` field to the building documents route was rejected: that route is `WRITE_ROLES`-only and the portal cannot reach it at all, so the owner's upload would need a second route anyway, and a technician would then be able to post any `kind` to any building. The dedicated routes carry their own narrower allowlist, `PHOTO_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg' }`, passed as `createDocument`'s `allow`, and their own cap, `MAX_PHOTO_BYTES = 8 MiB`, applied per request through `req.file({ limits: { fileSize: MAX_PHOTO_BYTES } })` so busboy truncates at eight and the route answers `413 file_too_large`. A PDF posted to a photo route is `400 unsupported_media_type`.
10. **The portal shows an owner their own requests, not their building's.** `GET /api/portal/maintenance?contactId` filters on `reported_by_contact_id = contactId` across the buildings that contact owns a unit in. A neighbour's free-text description ("сосед од 4 кат постојано остава ѓубре") is not an owner's business, and Art. 45(4) transparency is about the *fund*, which the portal already shows in full. A manager who wants a request visible to everybody says so in an `owner`-visible note on that owner's request; there is no building-wide feed in this sub-plan.
11. **Event visibility has two values and one rule.** `maintenance_events.visibility` is `('internal','owner')`. Staff-written events default to `internal` and the author may raise one to `owner`; **every event written through the portal is `owner`, always**, because an owner cannot write something hidden from themselves. The portal's feed is therefore exactly `visibility = 'owner'` — one filter, no union with "…or authored by me", which would have been the same set spelled twice. Status changes made by staff are written as `owner` when they move the request between the statuses an owner is shown (`triaged`, `assigned`, `in_progress`, `done`, `rejected`), because a status the owner can read on the card and cannot read in the timeline is a worse timeline. Free-text notes stay `internal` unless raised.
12. **`maintenance_events` has an author check too, but a weaker one.** `num_nonnulls(author_user_id, author_contact_id) <= 1`, not `= 1`: `author_user_id` is `on delete set null` (a departed employee's notes stay, unsigned) and the nightly job — which writes nothing here today — acts for no user. `author_contact_id` is `no action`, like the reporter.
13. **No legal event, and the compliance screen is untouched.** Spec §3 lists eight `legal_event_kind` labels and maintenance is none of them; 160/2025 imposes no maintenance-request duty. `packages/domain/src/compliance/evaluate.ts`, `resources/compliance/snapshot.ts` and `ComplianceTab.vue` are not edited by any task in this plan, and `legal_event_kind` gains no value. The audit log is where a maintenance mutation leaves its trace.
14. **The categories live on the country pack and earn their keep in the ledger.** `maintenance_category` is the Postgres enum `('plumbing','electrical','lift','heating','cleaning','common_area','other')` and `pack.maintenanceCategories` is the matching ordered list of `{ key, label }` in Macedonian. The pack's labels are not decoration: the expense a close-with-cost creates is described as `Одржување: <label> — <title>`, so the fund transaction a resident reads on the portal says "Одржување: Водовод — Протекува цевка во визбата" and not a uuid. The web picker uses its own `maintenance.categories.*` i18n keys, because the web needs mk **and** en and the pack is single-language by design; `packages/domain/test/country.test.ts` and `apps/web/test/LoginPage.test.ts` between them lock that the two key sets stay identical.
15. **No tenant-wide `GET /api/maintenance-requests`.** A technician reaches their queue through the building they were assigned in, which spec §10 gives them read on anyway. A cross-building queue is a real convenience and a real second surface to keep scoped; it belongs with the notification bell in sub-plan 5, where the technician actually gets told there is something to do.
16. **Task sizes.** Seven tasks. The migration and its assertions; the pure domain table; the board's API; the money and the photos and the portal; the manager's screen; the owner's screen; the walk-through. Task 4 is the biggest (~590 lines including two test files) and is the one a reviewer could split, at the seam between "the photo store" and "the portal" — they are kept together because the portal's upload route is the photo store's second caller and testing one without the other would test half a fence.

---

### Task 1: DB — migration 0012, the three maintenance tables

**Files:**
- Create: `packages/db/src/schema/maintenance.ts`
- Modify: `packages/db/src/schema/index.ts`
- Create: `packages/db/migrations/0012_*.sql` (generated — do not hand-write the name)
- Modify: `packages/db/test/migrations.test.ts`

**Interfaces (consumed by Tasks 2, 3, 4, 5, 6):**
- `schema.maintenanceRequests`, `schema.maintenanceEvents`, `schema.maintenancePhotos`
- `schema.maintenanceStatus`, `schema.maintenancePriority`, `schema.maintenanceCategory`, `schema.maintenanceEventKind`, `schema.maintenanceVisibility` (pg enums; `.enumValues` feeds every zod enum in Task 3)

- [ ] **Step 1: Write the failing test**

Append these five cases to `packages/db/test/migrations.test.ts`, inside the existing `describe('migrations', …)` block, after the assembly cases:

```ts
  it('creates the maintenance tables', async () => {
    const rows = await t!.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public' order by 1`;
    const names = rows.map((r) => r.table_name);
    for (const n of ['maintenance_requests', 'maintenance_events', 'maintenance_photos']) expect(names).toContain(n);
  });

  it('a maintenance request carries its reporter, its assignee and its cost', async () => {
    const cols = await t!.sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]>`
      select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'maintenance_requests' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual([
      'assignee_user_id', 'building_id', 'category', 'closed_at', 'cost_minor', 'created_at', 'description',
      'expense_id', 'fund', 'id', 'priority', 'reported_by_contact_id', 'reported_by_user_id', 'status',
      'supplier_id', 'tenant_id', 'title', 'unit_id', 'updated_at']);
    const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(by['cost_minor']!.data_type).toBe('bigint');
    expect(by['cost_minor']!.is_nullable).toBe('YES');
    expect(by['fund']!.is_nullable).toBe('YES');
    expect(by['expense_id']!.is_nullable).toBe('YES');
    expect(by['unit_id']!.is_nullable).toBe('YES');
    expect(by['assignee_user_id']!.is_nullable).toBe('YES');
    expect(by['reported_by_user_id']!.is_nullable).toBe('YES');
    expect(by['reported_by_contact_id']!.is_nullable).toBe('YES');
    expect(by['status']!.column_default).toContain('new');
    expect(by['priority']!.column_default).toContain('normal');
    const status = await t!.sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid where ty.typname = 'maintenance_status' order by e.enumsortorder`;
    expect(status.map((s) => s.enumlabel)).toEqual(['new', 'triaged', 'assigned', 'in_progress', 'done', 'rejected']);
    const priority = await t!.sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid where ty.typname = 'maintenance_priority' order by e.enumsortorder`;
    expect(priority.map((s) => s.enumlabel)).toEqual(['low', 'normal', 'high', 'urgent']);
    const category = await t!.sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid where ty.typname = 'maintenance_category' order by e.enumsortorder`;
    expect(category.map((s) => s.enumlabel)).toEqual(['plumbing', 'electrical', 'lift', 'heating', 'cleaning', 'common_area', 'other']);
    const idx = await t!.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'maintenance_requests'`;
    expect(idx.some((i) => i.indexdef.includes('(tenant_id, building_id, created_at)'))).toBe(true);
    expect(idx.some((i) => i.indexdef.includes('(tenant_id, status, created_at)'))).toBe(true);
    expect(idx.some((i) => i.indexdef.includes('(tenant_id, assignee_user_id, created_at)'))).toBe(true);
    expect(idx.some((i) => i.indexdef.includes('(tenant_id, reported_by_contact_id, created_at)'))).toBe(true);
  });

  it('exactly one reporter is a database check, not a convention', async () => {
    const [chk] = await t!.sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'maintenance_requests'::regclass and contype = 'c' and conname = 'maintenance_requests_reporter_chk'`;
    expect(chk).toBeDefined();
    expect(chk!.def.replace(/\s+/g, ' ')).toContain('num_nonnulls');

    // The check really fires: two reporters and no reporter are both refused.
    const [tenant] = await t!.sql<{ id: string }[]>`
      insert into tenants (slug, name, country_code, currency, locale)
      values ('mig-maint', 'Mig Maint', 'mk', 'MKD', 'mk-MK') returning id`;
    const [building] = await t!.sql<{ id: string }[]>`
      insert into buildings (tenant_id, name, country_code) values (${tenant!.id}, 'Зграда', 'mk') returning id`;
    const [user] = await t!.sql<{ id: string }[]>`
      insert into users (tenant_id, email, password_hash, first_name, last_name, role)
      values (${tenant!.id}, 'm@mig.mk', 'x', 'M', 'M', 'owner') returning id`;
    const [contact] = await t!.sql<{ id: string }[]>`
      insert into contacts (tenant_id, last_name) values (${tenant!.id}, 'Сопственик') returning id`;
    const insert = (reportedByUser: string | null, reportedByContact: string | null) => t!.sql`
      insert into maintenance_requests (tenant_id, building_id, title, description, category, reported_by_user_id, reported_by_contact_id)
      values (${tenant!.id}, ${building!.id}, 'Т', 'О', 'other', ${reportedByUser}, ${reportedByContact})`;
    await expect(insert(null, null)).rejects.toThrow(/maintenance_requests_reporter_chk/);
    await expect(insert(user!.id, contact!.id)).rejects.toThrow(/maintenance_requests_reporter_chk/);
    await expect(insert(user!.id, null)).resolves.toBeDefined();
    await t!.sql`delete from tenants where id = ${tenant!.id}`;
  });

  it('maintenance events record who said what, and how visible it is', async () => {
    const cols = await t!.sql<{ column_name: string; is_nullable: string; column_default: string | null }[]>`
      select column_name, is_nullable, column_default from information_schema.columns where table_name = 'maintenance_events' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual([
      'author_contact_id', 'author_user_id', 'created_at', 'from_status', 'id', 'kind',
      'maintenance_request_id', 'note', 'tenant_id', 'to_status', 'visibility']);
    const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(by['note']!.is_nullable).toBe('NO');
    expect(by['from_status']!.is_nullable).toBe('YES');
    expect(by['to_status']!.is_nullable).toBe('YES');
    expect(by['visibility']!.column_default).toContain('internal');
    const kinds = await t!.sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid where ty.typname = 'maintenance_event_kind' order by e.enumsortorder`;
    expect(kinds.map((k) => k.enumlabel)).toEqual(['created', 'status_changed', 'assigned', 'comment', 'photo_added']);
    const vis = await t!.sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid where ty.typname = 'maintenance_visibility' order by e.enumsortorder`;
    expect(vis.map((v) => v.enumlabel)).toEqual(['internal', 'owner']);
    const idx = await t!.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'maintenance_events'`;
    expect(idx.some((i) => i.indexdef.includes('(tenant_id, maintenance_request_id, created_at)'))).toBe(true);
  });

  it('a photo belongs to exactly one request and dies with its document', async () => {
    const cols = await t!.sql<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns where table_name = 'maintenance_photos' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual([
      'created_at', 'document_id', 'id', 'maintenance_request_id', 'tenant_id', 'uploaded_by_contact_id', 'uploaded_by_user_id']);
    const idx = await t!.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'maintenance_photos'`;
    expect(idx.some((i) => i.indexdef.includes('UNIQUE') && i.indexdef.includes('(document_id)'))).toBe(true);
    expect(idx.some((i) => i.indexdef.includes('(tenant_id, maintenance_request_id, created_at)'))).toBe(true);
    const [fk] = await t!.sql<{ delete_rule: string }[]>`
      select rc.delete_rule from information_schema.referential_constraints rc
      join information_schema.key_column_usage k on k.constraint_name = rc.constraint_name
      where k.table_name = 'maintenance_photos' and k.column_name = 'document_id'`;
    expect(fk!.delete_rule).toBe('CASCADE');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm db:up && pnpm --filter @domar/db test`
Expected: FAIL — `creates the maintenance tables` fails on `expect(names).toContain('maintenance_requests')`; the other four fail on `undefined` column lists.

- [ ] **Step 3: Implement**

Create `packages/db/src/schema/maintenance.ts`:

```ts
import { sql } from 'drizzle-orm';
import { bigint, check, index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { expenses, fund } from './billing.js';
import { buildings, units } from './building.js';
import { documents, suppliers } from './compliance.js';
import { contacts } from './contact.js';
import { tenants } from './tenant.js';

/** Spec §8. `done` and `rejected` are terminal: a request is never reopened (plan addendum 2). */
export const maintenanceStatus = pgEnum('maintenance_status', ['new', 'triaged', 'assigned', 'in_progress', 'done', 'rejected']);
export const maintenancePriority = pgEnum('maintenance_priority', ['low', 'normal', 'high', 'urgent']);
/** The country pack's `maintenanceCategories` carries the labels for exactly these keys (addendum 14). */
export const maintenanceCategory = pgEnum('maintenance_category', ['plumbing', 'electrical', 'lift', 'heating', 'cleaning', 'common_area', 'other']);
export const maintenanceEventKind = pgEnum('maintenance_event_kind', ['created', 'status_changed', 'assigned', 'comment', 'photo_added']);
/** `owner` events are what the portal's feed shows; everything written through the portal is `owner`. */
export const maintenanceVisibility = pgEnum('maintenance_visibility', ['internal', 'owner']);

const money = (name: string) => bigint(name, { mode: 'number' });
const tenantRef = () => uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' });
const ts = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Spec §8: one owner request. `reported_by_*` is exactly one of the two, enforced by the check —
 * neither column is ever nulled by a delete (`no action`), so the check holds for the row's life
 * and a reporter cannot be deleted out from under it (addendum 1).
 * `cost_minor`/`fund`/`expense_id` are filled only when the request is closed with a cost, and the
 * expense itself is written by the existing `createExpense` flow (spec §11, addendum 5).
 */
export const maintenanceRequests = pgTable('maintenance_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
  /** null = the common parts rather than one flat. */
  unitId: uuid('unit_id').references(() => units.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  category: maintenanceCategory('category').notNull(),
  priority: maintenancePriority('priority').notNull().default('normal'),
  status: maintenanceStatus('status').notNull().default('new'),
  reportedByUserId: uuid('reported_by_user_id').references(() => users.id, { onDelete: 'no action' }),
  reportedByContactId: uuid('reported_by_contact_id').references(() => contacts.id, { onDelete: 'no action' }),
  /** A user of this tenant with role technician, accountant or owner (checked in the API). */
  assigneeUserId: uuid('assignee_user_id').references(() => users.id, { onDelete: 'set null' }),
  supplierId: uuid('supplier_id').references(() => suppliers.id, { onDelete: 'set null' }),
  fund: fund('fund'),
  costMinor: money('cost_minor'),
  expenseId: uuid('expense_id').references(() => expenses.id, { onDelete: 'set null' }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  ...ts(),
}, (t) => [
  index('maintenance_requests_tenant_building_idx').on(t.tenantId, t.buildingId, t.createdAt),
  index('maintenance_requests_tenant_status_idx').on(t.tenantId, t.status, t.createdAt),
  index('maintenance_requests_tenant_assignee_idx').on(t.tenantId, t.assigneeUserId, t.createdAt),
  index('maintenance_requests_tenant_contact_idx').on(t.tenantId, t.reportedByContactId, t.createdAt),
  check('maintenance_requests_reporter_chk', sql`num_nonnulls(${t.reportedByUserId}, ${t.reportedByContactId}) = 1`),
]);

/** The feed: one row per status change, assignment, comment and photo (spec §8). Never updated. */
export const maintenanceEvents = pgTable('maintenance_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  maintenanceRequestId: uuid('maintenance_request_id').notNull().references(() => maintenanceRequests.id, { onDelete: 'cascade' }),
  kind: maintenanceEventKind('kind').notNull(),
  fromStatus: maintenanceStatus('from_status'),
  toStatus: maintenanceStatus('to_status'),
  note: text('note').notNull().default(''),
  visibility: maintenanceVisibility('visibility').notNull().default('internal'),
  authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
  authorContactId: uuid('author_contact_id').references(() => contacts.id, { onDelete: 'no action' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('maintenance_events_tenant_request_idx').on(t.tenantId, t.maintenanceRequestId, t.createdAt),
  // `<=`, not `=`: `author_user_id` is `set null`, so a departed employee's notes stay unsigned (addendum 12).
  check('maintenance_events_author_chk', sql`num_nonnulls(${t.authorUserId}, ${t.authorContactId}) <= 1`),
]);

/**
 * Spec §8: "photos as documents (`kind photo`)". The join row, not a column on `documents`, so a
 * photo carries who attached it and every other document stays free of a maintenance concern.
 * `document_id` is unique and cascades: deleting the document takes the gallery entry with it.
 */
export const maintenancePhotos = pgTable('maintenance_photos', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  maintenanceRequestId: uuid('maintenance_request_id').notNull().references(() => maintenanceRequests.id, { onDelete: 'cascade' }),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  uploadedByContactId: uuid('uploaded_by_contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('maintenance_photos_tenant_request_idx').on(t.tenantId, t.maintenanceRequestId, t.createdAt),
  uniqueIndex('maintenance_photos_document_idx').on(t.documentId),
]);
```

Add one line to `packages/db/src/schema/index.ts`, after `export * from './assembly.js';`:

```ts
export * from './maintenance.js';
```

Generate the migration (the file name is random and assigned by drizzle-kit — do not invent one):

```bash
pnpm db:up
pnpm --filter @domar/db generate
```

Read the generated `packages/db/migrations/0012_*.sql` and confirm it contains, in this order: the five `CREATE TYPE` statements, `CREATE TABLE IF NOT EXISTS "maintenance_requests"` with `CONSTRAINT "maintenance_requests_reporter_chk" CHECK (num_nonnulls("maintenance_requests"."reported_by_user_id","maintenance_requests"."reported_by_contact_id") = 1)`, the two other tables with their own check and constraints, the `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` block and the six `CREATE INDEX`/`CREATE UNIQUE INDEX` statements. **Do not edit the generated SQL**; if a constraint is missing, fix `maintenance.ts` and regenerate after deleting the new file and its `meta/` journal entry.

- [ ] **Step 4: Run tests**

Run: `pnpm db:up && pnpm --filter @domar/db test && pnpm --filter @domar/db typecheck && pnpm lint`
Expected: PASS — 5 new cases green, and the pre-existing `every tenant-scoped table has tenant_id and an index starting with it` and `money columns are bigint and end with _minor` cases still green now that they sweep the three new tables too.

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): maintenance requests, their event feed and their photos" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Domain — the transition graph, the capability matrix and the pack's categories

**Files:**
- Create: `packages/domain/src/maintenance/status.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/domain/src/country/types.ts`
- Modify: `packages/domain/src/country/mk.ts`
- Create: `packages/domain/test/maintenance.test.ts`
- Modify: `packages/domain/test/country.test.ts`

**Interfaces (consumed by Tasks 3, 4, 5 and 6):**
- `MaintenanceStatus`, `MaintenanceCategory`, `MaintenancePriority`, `MaintenanceCapability`, `MaintenanceRole`
- `MAINTENANCE_STATUSES`, `MAINTENANCE_CATEGORIES`, `MAINTENANCE_PRIORITIES`, `TERMINAL_STATUSES`, `ALLOWED_TRANSITIONS`, `MAINTENANCE_CAPABILITIES`
- `canTransition(from, to)`, `nextStatus(from, to)`, `nextStatuses(from)`, `isTerminal(status)`, `can(role, capability)`
- `pack.maintenanceCategories: MaintenanceCategoryLabel[]` and the type `MaintenanceCategoryLabel`

- [ ] **Step 1: Write the failing test**

Create `packages/domain/test/maintenance.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkPack } from '../src/country/mk.js';
import {
  ALLOWED_TRANSITIONS, MAINTENANCE_CAPABILITIES, MAINTENANCE_CATEGORIES, MAINTENANCE_PRIORITIES, MAINTENANCE_STATUSES,
  TERMINAL_STATUSES, can, canTransition, isTerminal, nextStatus, nextStatuses,
  type MaintenanceRole, type MaintenanceStatus,
} from '../src/maintenance/status.js';

describe('the maintenance status graph', () => {
  it('lists the six statuses in the order the board draws them', () => {
    expect(MAINTENANCE_STATUSES).toEqual(['new', 'triaged', 'assigned', 'in_progress', 'done', 'rejected']);
    expect(MAINTENANCE_PRIORITIES).toEqual(['low', 'normal', 'high', 'urgent']);
  });

  it('is exactly the graph the plan fixed — every edge, and no other', () => {
    expect(ALLOWED_TRANSITIONS).toEqual({
      new: ['triaged', 'assigned', 'rejected'],
      triaged: ['assigned', 'rejected'],
      assigned: ['in_progress', 'done'],
      in_progress: ['done'],
      done: [],
      rejected: [],
    });
  });

  it('allows the happy path and refuses every step backwards', () => {
    expect(canTransition('new', 'triaged')).toBe(true);
    expect(canTransition('triaged', 'assigned')).toBe(true);
    expect(canTransition('assigned', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'done')).toBe(true);
    // A request fixed on the spot closes straight from `assigned`.
    expect(canTransition('assigned', 'done')).toBe(true);
    expect(canTransition('triaged', 'in_progress')).toBe(false);
    expect(canTransition('new', 'done')).toBe(false);
    expect(canTransition('in_progress', 'assigned')).toBe(false);
    expect(canTransition('done', 'in_progress')).toBe(false);
    expect(canTransition('rejected', 'triaged')).toBe(false);
    expect(canTransition('new', 'new')).toBe(false);
  });

  it('rejects only from new and triaged', () => {
    expect(canTransition('new', 'rejected')).toBe(true);
    expect(canTransition('triaged', 'rejected')).toBe(true);
    expect(canTransition('assigned', 'rejected')).toBe(false);
    expect(canTransition('in_progress', 'rejected')).toBe(false);
  });

  it('knows its terminal states, and they are dead ends', () => {
    expect(TERMINAL_STATUSES).toEqual(['done', 'rejected']);
    for (const s of TERMINAL_STATUSES) {
      expect(isTerminal(s)).toBe(true);
      expect(nextStatuses(s)).toEqual([]);
      for (const to of MAINTENANCE_STATUSES) expect(canTransition(s, to), `${s} → ${to}`).toBe(false);
    }
    expect(isTerminal('in_progress')).toBe(false);
  });

  it('nextStatus returns the target when it is legal and null when it is not', () => {
    expect(nextStatus('assigned', 'in_progress')).toBe('in_progress');
    expect(nextStatus('assigned', 'triaged')).toBeNull();
    expect(nextStatus('done', 'done')).toBeNull();
  });

  it('never leaves a status unreachable or a non-terminal status without an exit', () => {
    const reachable = new Set<MaintenanceStatus>(['new']);
    for (const from of MAINTENANCE_STATUSES) for (const to of nextStatuses(from)) reachable.add(to);
    expect([...reachable].sort()).toEqual([...MAINTENANCE_STATUSES].sort());
    for (const s of MAINTENANCE_STATUSES) {
      expect(nextStatuses(s).length > 0, s).toBe(!TERMINAL_STATUSES.includes(s));
    }
  });
});

describe('the maintenance capability matrix', () => {
  it('is the exact table the API gates on', () => {
    expect(MAINTENANCE_CAPABILITIES).toEqual({
      owner: ['create', 'triage', 'reject', 'assign', 'progress', 'close', 'close_with_cost', 'comment', 'photo'],
      accountant: ['create', 'triage', 'reject', 'assign', 'progress', 'close', 'close_with_cost', 'comment', 'photo'],
      technician: ['progress', 'close', 'comment', 'photo'],
      readonly: [],
    });
  });

  it('lets a technician work a request but never book its cost', () => {
    expect(can('technician', 'progress')).toBe(true);
    expect(can('technician', 'close')).toBe(true);
    expect(can('technician', 'comment')).toBe(true);
    expect(can('technician', 'photo')).toBe(true);
    expect(can('technician', 'close_with_cost')).toBe(false);
    expect(can('technician', 'assign')).toBe(false);
    expect(can('technician', 'create')).toBe(false);
    expect(can('technician', 'triage')).toBe(false);
    expect(can('technician', 'reject')).toBe(false);
  });

  it('gives readonly nothing at all and the two write roles everything', () => {
    const everything = MAINTENANCE_CAPABILITIES.owner;
    expect(MAINTENANCE_CAPABILITIES.accountant).toEqual(everything);
    for (const c of everything) expect(can('readonly', c), c).toBe(false);
    for (const role of ['owner', 'accountant'] as MaintenanceRole[]) {
      for (const c of everything) expect(can(role, c), `${role}/${c}`).toBe(true);
    }
  });
});

describe('the country pack carries the categories', () => {
  it('labels every category of the enum, in the picker order, in Macedonian', () => {
    expect(MAINTENANCE_CATEGORIES).toEqual(['plumbing', 'electrical', 'lift', 'heating', 'cleaning', 'common_area', 'other']);
    expect(mkPack.maintenanceCategories).toEqual([
      { key: 'plumbing', label: 'Водовод и канализација' },
      { key: 'electrical', label: 'Електрика' },
      { key: 'lift', label: 'Лифт' },
      { key: 'heating', label: 'Греење' },
      { key: 'cleaning', label: 'Чистење' },
      { key: 'common_area', label: 'Заеднички простории' },
      { key: 'other', label: 'Друго' },
    ]);
  });

  it('labels the expense a closed request books, so the fund page reads as Macedonian', () => {
    const label = mkPack.maintenanceCategories.find((c) => c.key === 'plumbing')!.label;
    expect(`${mkPack.labels.maintenanceExpense}: ${label} — Протекува цевка во визбата`)
      .toBe('Одржување: Водовод и канализација — Протекува цевка во визбата');
  });
});
```

Append this case to `packages/domain/test/country.test.ts`, inside its existing top-level `describe`:

```ts
  it('the pack labels exactly the categories the database enum holds, in order', () => {
    expect(mkPack.maintenanceCategories.map((c) => c.key)).toEqual(MAINTENANCE_CATEGORIES);
    expect(new Set(mkPack.maintenanceCategories.map((c) => c.label)).size).toBe(MAINTENANCE_CATEGORIES.length);
    for (const c of mkPack.maintenanceCategories) expect(c.label.trim().length, c.key).toBeGreaterThan(0);
    expect(mkPack.labels.maintenanceExpense).toBe('Одржување');
  });
```

and add `MAINTENANCE_CATEGORIES` to that file's import from `../src/maintenance/status.js`:

```ts
import { MAINTENANCE_CATEGORIES } from '../src/maintenance/status.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @domar/domain test`
Expected: FAIL — `Cannot find module '../src/maintenance/status.js'` in both new and modified test files.

- [ ] **Step 3: Implement**

Create `packages/domain/src/maintenance/status.ts`:

```ts
/**
 * Spec §8, as pure data. Nothing here touches a database, a clock or a locale, so the API, the two
 * web screens and the tests all read one table instead of three copies of the same rules.
 */
export type MaintenanceStatus = 'new' | 'triaged' | 'assigned' | 'in_progress' | 'done' | 'rejected';
export type MaintenancePriority = 'low' | 'normal' | 'high' | 'urgent';
export type MaintenanceCategory = 'plumbing' | 'electrical' | 'lift' | 'heating' | 'cleaning' | 'common_area' | 'other';
/** The four `user_role` values; the capability matrix is total over them. */
export type MaintenanceRole = 'owner' | 'accountant' | 'technician' | 'readonly';
export type MaintenanceCapability =
  | 'create' | 'triage' | 'reject' | 'assign' | 'progress' | 'close' | 'close_with_cost' | 'comment' | 'photo';

/** The order the board draws its columns in, and the order the `maintenance_status` enum declares. */
export const MAINTENANCE_STATUSES: readonly MaintenanceStatus[] = ['new', 'triaged', 'assigned', 'in_progress', 'done', 'rejected'];
export const MAINTENANCE_PRIORITIES: readonly MaintenancePriority[] = ['low', 'normal', 'high', 'urgent'];
export const MAINTENANCE_CATEGORIES: readonly MaintenanceCategory[] = ['plumbing', 'electrical', 'lift', 'heating', 'cleaning', 'common_area', 'other'];
/** Closed for good: a request that was not really fixed is a new request (plan addendum 2). */
export const TERMINAL_STATUSES: readonly MaintenanceStatus[] = ['done', 'rejected'];

/**
 * Every legal edge, and no other. `new|triaged → assigned` lives here because it is part of the
 * graph; the HTTP status route nevertheless refuses `assigned` as a target, because reaching it
 * needs an assignee and that is `POST …/assign`'s job (plan addendum 3).
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<MaintenanceStatus, readonly MaintenanceStatus[]>> = {
  new: ['triaged', 'assigned', 'rejected'],
  triaged: ['assigned', 'rejected'],
  assigned: ['in_progress', 'done'],
  in_progress: ['done'],
  done: [],
  rejected: [],
};

export const MAINTENANCE_CAPABILITIES: Readonly<Record<MaintenanceRole, readonly MaintenanceCapability[]>> = {
  owner: ['create', 'triage', 'reject', 'assign', 'progress', 'close', 'close_with_cost', 'comment', 'photo'],
  accountant: ['create', 'triage', 'reject', 'assign', 'progress', 'close', 'close_with_cost', 'comment', 'photo'],
  // Spec §10: the technician's real job. `close_with_cost` is deliberately absent — booking money
  // against a building's fund is an accountant's act (plan addendum 6).
  technician: ['progress', 'close', 'comment', 'photo'],
  readonly: [],
};

export function nextStatuses(from: MaintenanceStatus): readonly MaintenanceStatus[] {
  return ALLOWED_TRANSITIONS[from];
}

export function canTransition(from: MaintenanceStatus, to: MaintenanceStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** The target when the move is legal, `null` when it is not; the API turns `null` into a 409. */
export function nextStatus(from: MaintenanceStatus, to: MaintenanceStatus): MaintenanceStatus | null {
  return canTransition(from, to) ? to : null;
}

export function isTerminal(status: MaintenanceStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function can(role: MaintenanceRole, capability: MaintenanceCapability): boolean {
  return MAINTENANCE_CAPABILITIES[role].includes(capability);
}
```

Add one line to `packages/domain/src/index.ts`, after `export * from './assembly/tally.js';`:

```ts
export * from './maintenance/status.js';
```

In `packages/domain/src/country/types.ts`, add the import of the category type at the top of the file, beside the existing `StatementParser` import:

```ts
import type { MaintenanceCategory } from '../maintenance/status.js';
```

then add the label type just above `CountryLabels`:

```ts
/** Spec §8: one entry per `MaintenanceCategory`, in the order the picker offers them. */
export interface MaintenanceCategoryLabel {
  key: MaintenanceCategory;
  label: string;
}
```

add one field to `CountryLabels`, after `reports: ReportLabels;`:

```ts
  /** Spec §8: the word an expense booked by a closed maintenance request is prefixed with. */
  maintenanceExpense: string;
```

and one field to `CountryPack`, after `complianceRules: ComplianceRules;`:

```ts
  /** Spec §8: the fixed category list, labelled, so the expense a closed request books is readable. */
  maintenanceCategories: MaintenanceCategoryLabel[];
```

In `packages/domain/src/country/mk.ts`, add one line to `labels`, immediately after the `reports: { … },` block:

```ts
    maintenanceExpense: 'Одржување',
```

and add the category list immediately after the `complianceRules: { … },` block:

```ts
  maintenanceCategories: [
    { key: 'plumbing', label: 'Водовод и канализација' },
    { key: 'electrical', label: 'Електрика' },
    { key: 'lift', label: 'Лифт' },
    { key: 'heating', label: 'Греење' },
    { key: 'cleaning', label: 'Чистење' },
    { key: 'common_area', label: 'Заеднички простории' },
    { key: 'other', label: 'Друго' },
  ],
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @domar/domain test && pnpm --filter @domar/domain typecheck && pnpm lint`
Expected: PASS — 11 new cases in `maintenance.test.ts`, 1 new case in `country.test.ts`, every pre-existing domain case still green.

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): the maintenance status graph, capability matrix and category labels" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: API — the board, the transitions, the assignment and the event feed

**Files:**
- Create: `apps/api/src/resources/maintenance/schema.ts`
- Create: `apps/api/src/resources/maintenance/repo.ts`
- Create: `apps/api/src/resources/maintenance/routes.ts`
- Modify: `apps/api/src/auth/roles.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/test/fixtures.ts`
- Create: `apps/api/test/maintenance.test.ts`

**Interfaces (consumed by Tasks 4, 5, 6 and 7):**
- Routes: `GET|POST /api/buildings/:buildingId/maintenance`, `GET|PATCH /api/maintenance-requests/:id`, `POST /api/maintenance-requests/:id/status`, `POST /api/maintenance-requests/:id/assign`, `POST /api/maintenance-requests/:id/events`
- `MAINTENANCE_ROLES` (`apps/api/src/auth/roles.ts`)
- `schema.ts`: `maintenanceStatusEnum`, `maintenancePriorityEnum`, `maintenanceCategoryEnum`, `maintenanceEventKindEnum`, `maintenanceVisibilityEnum`, `maintenanceStatusTargetEnum`, `maintenanceCreate`, `maintenancePatch`, `maintenanceStatusBody`, `maintenanceAssignBody`, `maintenanceEventBody`, `maintenanceRowOut`, `maintenanceOut`, `maintenanceListOut`, `maintenanceListQuery`, `maintenancePhotoOut`, `maintenanceEventOut`, and the types `MaintenanceCreateInput`, `MaintenancePatchInput`, `MaintenanceStatusInput`, `MaintenanceAssignInput`, `MaintenanceEventInput`
- `repo.ts`: `listRequests`, `getRequest`, `getRequestRow`, `createRequest`, `updateRequest`, `setStatus`, `assignRequest`, `addEvent`, `claimRequest`, `recordEvent`, `requestPhotos`, `fullName`, `MR`
- `fixtures.ts`: `createStaffUser(app, ownerCookie, slug, { email, firstName, lastName, role })`

- [ ] **Step 1: Write the failing test**

Add this helper to `apps/api/test/fixtures.ts`, below `registerTenant`:

```ts
/** A second staff login in the same tenant: created by the owner, then signed in with its temporary password. */
export async function createStaffUser(
  app: FastifyInstance,
  ownerCookie: string,
  slug: string,
  input: { email: string; firstName: string; lastName: string; role: 'owner' | 'accountant' | 'technician' | 'readonly' },
): Promise<{ id: string; cookie: string }> {
  const created = await app.inject({ method: 'POST', url: '/api/users', headers: { cookie: ownerCookie }, payload: input });
  if (created.statusCode !== 201) throw new Error(`user create failed: ${created.body}`);
  const { user, temporaryPassword } = created.json();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantSlug: slug, email: input.email, password: temporaryPassword } });
  if (login.statusCode !== 200) throw new Error(`login failed: ${login.body}`);
  const raw = login.headers['set-cookie'];
  return { id: user.id, cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]! };
}
```

Create `apps/api/test/maintenance.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupPublishedBuilding } from './billing-fixture.js';
import { createStaffUser, registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('maintenance requests', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  let A: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  let tech: { id: string; cookie: string };
  let other: { id: string; cookie: string };
  let readonlyCookie = '';
  let unitId = '';

  const post = (url: string, payload: unknown, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload: payload as never });
  const get = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? a.cookie } });
  const patch = (url: string, payload: unknown, cookie?: string) =>
    t.app.inject({ method: 'PATCH', url, headers: { cookie: cookie ?? a.cookie }, payload: payload as never });

  const create = async (over: Record<string, unknown> = {}) => {
    const res = await post(`/api/buildings/${A.buildingId}/maintenance`, {
      title: 'Протекува цевка во визбата', description: 'Вода тече покрај вертикалата под влезот.',
      category: 'plumbing', priority: 'high', ...over,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  };

  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-maint');
    b = await registerTenant(t.app, 'firma-maint-other');
    A = await setupPublishedBuilding(t.app, a.cookie);
    unitId = (await get(`/api/buildings/${A.buildingId}/units`)).json().rows[0].id;
    tech = await createStaffUser(t.app, a.cookie, 'firma-maint', { email: 'stefan@firma-maint.mk', firstName: 'Стефан', lastName: 'Стефановски', role: 'technician' });
    other = await createStaffUser(t.app, a.cookie, 'firma-maint', { email: 'nikola@firma-maint.mk', firstName: 'Никола', lastName: 'Николовски', role: 'technician' });
    readonlyCookie = (await createStaffUser(t.app, a.cookie, 'firma-maint', { email: 'ro@firma-maint.mk', firstName: 'Р', lastName: 'О', role: 'readonly' })).cookie;
  });
  afterAll(async () => { await t.close(); });

  it('creates a request reported by the signed-in manager, with a created event', async () => {
    const row = await create({ unitId });
    expect(row.status).toBe('new');
    expect(row.priority).toBe('high');
    expect(row.category).toBe('plumbing');
    expect(row.unitId).toBe(unitId);
    expect(row.unitLabel).toBe('1');
    expect(row.reporterKind).toBe('manager');
    expect(row.reporterName).toBe('O firma-maint');
    expect(row.assigneeUserId).toBeNull();
    expect(row.costMinor).toBeNull();
    expect(row.expenseId).toBeNull();
    expect(row.photoCount).toBe(0);

    const detail = (await get(`/api/maintenance-requests/${row.id}`)).json();
    expect(detail.description).toBe('Вода тече покрај вертикалата под влезот.');
    expect(detail.photos).toEqual([]);
    expect(detail.events).toHaveLength(1);
    expect(detail.events[0].kind).toBe('created');
    expect(detail.events[0].toStatus).toBe('new');
    expect(detail.events[0].visibility).toBe('internal');
    expect(detail.events[0].authorKind).toBe('manager');
  });

  it('walks new → triaged → assigned → in_progress → done and logs every step', async () => {
    const row = await create();
    const triaged = await post(`/api/maintenance-requests/${row.id}/status`, { status: 'triaged', note: 'Проверено на лице место.' });
    expect(triaged.statusCode).toBe(200);
    expect(triaged.json().status).toBe('triaged');

    const assigned = await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: tech.id, supplierId: A.supplierId ?? null });
    expect(assigned.statusCode, assigned.body).toBe(200);
    expect(assigned.json().status).toBe('assigned');
    expect(assigned.json().assigneeUserId).toBe(tech.id);
    expect(assigned.json().assigneeName).toBe('Стефан Стефановски');

    const started = await post(`/api/maintenance-requests/${row.id}/status`, { status: 'in_progress' }, tech.cookie);
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json().status).toBe('in_progress');

    const done = await post(`/api/maintenance-requests/${row.id}/status`, { status: 'done', cost: null, note: 'Заменета спојка.', visibility: 'owner' });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().status).toBe('done');
    expect(done.json().closedAt).not.toBeNull();
    expect(done.json().costMinor).toBeNull();
    expect(done.json().expenseId).toBeNull();

    const detail = (await get(`/api/maintenance-requests/${row.id}`)).json();
    expect(detail.events.map((e: { kind: string; toStatus: string | null }) => [e.kind, e.toStatus])).toEqual([
      ['created', 'new'], ['status_changed', 'triaged'], ['assigned', 'assigned'],
      ['status_changed', 'in_progress'], ['status_changed', 'done'],
    ]);
    expect(detail.events[1].note).toBe('Проверено на лице место.');
    expect(detail.events[3].authorName).toBe('Стефан Стефановски');
    // A status an owner can read on the card is a status they can read in the feed (addendum 11).
    expect(detail.events.map((e: { visibility: string }) => e.visibility)).toEqual(['internal', 'owner', 'owner', 'owner', 'owner']);
  });

  it('refuses an illegal move with 409 and leaves the status alone', async () => {
    const row = await create();
    const jump = await post(`/api/maintenance-requests/${row.id}/status`, { status: 'in_progress' });
    expect(jump.statusCode).toBe(409);
    expect(jump.json().error.code).toBe('status_locked');
    expect((await get(`/api/maintenance-requests/${row.id}`)).json().status).toBe('new');

    await post(`/api/maintenance-requests/${row.id}/status`, { status: 'rejected', note: 'Двојна пријава.' });
    const reopen = await post(`/api/maintenance-requests/${row.id}/status`, { status: 'triaged' });
    expect(reopen.statusCode).toBe(409);
    expect(reopen.json().error.code).toBe('status_locked');
  });

  it('refuses to close without a decision about the money', async () => {
    const row = await create();
    await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: tech.id });
    const res = await post(`/api/maintenance-requests/${row.id}/status`, { status: 'done' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('cost_decision_required');
    expect((await get(`/api/maintenance-requests/${row.id}`)).json().status).toBe('assigned');
  });

  it('reassigns without moving an in-progress request back to assigned', async () => {
    const row = await create();
    await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: tech.id });
    await post(`/api/maintenance-requests/${row.id}/status`, { status: 'in_progress' }, tech.cookie);
    const again = await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: other.id });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().status).toBe('in_progress');
    expect(again.json().assigneeUserId).toBe(other.id);
  });

  it('only assigns to an active technician, accountant or owner of this tenant', async () => {
    const row = await create();
    const foreign = await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: b.userId });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error.code).toBe('invalid_reference');

    const ro = (await get('/api/users')).json().rows.find((u: { email: string }) => u.email === 'ro@firma-maint.mk');
    const readonlyAssignee = await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: ro.id });
    expect(readonlyAssignee.statusCode).toBe(400);
    expect(readonlyAssignee.json().error.code).toBe('invalid_reference');
  });

  it('shows a technician their own requests and nothing else', async () => {
    const mine = await create({ title: 'Лифтот запира меѓу катови', category: 'lift' });
    const theirs = await create({ title: 'Изгорена сијалица во ходник', category: 'electrical' });
    await post(`/api/maintenance-requests/${mine.id}/assign`, { assigneeUserId: tech.id });
    await post(`/api/maintenance-requests/${theirs.id}/assign`, { assigneeUserId: other.id });

    const list = await get(`/api/buildings/${A.buildingId}/maintenance`, tech.cookie);
    expect(list.statusCode).toBe(200);
    const ids = list.json().rows.map((r: { id: string }) => r.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);

    expect((await get(`/api/maintenance-requests/${mine.id}`, tech.cookie)).statusCode).toBe(200);
    // Not 403: a technician must not be able to enumerate the board by reading status codes.
    expect((await get(`/api/maintenance-requests/${theirs.id}`, tech.cookie)).statusCode).toBe(404);
    expect((await post(`/api/maintenance-requests/${theirs.id}/status`, { status: 'in_progress' }, tech.cookie)).statusCode).toBe(404);
  });

  it('refuses a technician the acts that are not theirs', async () => {
    const row = await create();
    await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: tech.id });
    expect((await post(`/api/buildings/${A.buildingId}/maintenance`, { title: 'x', description: '', category: 'other' }, tech.cookie)).statusCode).toBe(403);
    expect((await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: other.id }, tech.cookie)).statusCode).toBe(403);
    expect((await patch(`/api/maintenance-requests/${row.id}`, { priority: 'urgent' }, tech.cookie)).statusCode).toBe(403);
    const triage = await post(`/api/maintenance-requests/${row.id}/status`, { status: 'triaged' }, tech.cookie);
    expect(triage.statusCode).toBe(403); // the capability gate refuses a technician `triage` before any transition is considered
    // A technician may still speak on their own request.
    expect((await post(`/api/maintenance-requests/${row.id}/events`, { note: 'Ќе дојдам утре во 9.' }, tech.cookie)).statusCode).toBe(201);
  });

  it('lets readonly read the board and write nothing', async () => {
    const row = await create();
    expect((await get(`/api/buildings/${A.buildingId}/maintenance`, readonlyCookie)).statusCode).toBe(200);
    expect((await get(`/api/maintenance-requests/${row.id}`, readonlyCookie)).statusCode).toBe(200);
    expect((await post(`/api/maintenance-requests/${row.id}/status`, { status: 'triaged' }, readonlyCookie)).statusCode).toBe(403);
    expect((await post(`/api/maintenance-requests/${row.id}/events`, { note: 'x' }, readonlyCookie)).statusCode).toBe(403);
  });

  it('gives a technician read on the building, as spec §10 says', async () => {
    const res = await get(`/api/buildings/${A.buildingId}`, tech.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Партизанска 12');
  });

  it('filters the board by status and by category', async () => {
    const list = await get(`/api/buildings/${A.buildingId}/maintenance?status=new&category=lift`);
    expect(list.statusCode).toBe(200);
    for (const r of list.json().rows) {
      expect(r.status).toBe('new');
      expect(r.category).toBe('lift');
    }
  });

  it('edits a request while it is open and refuses once it is closed', async () => {
    const row = await create();
    const edited = await patch(`/api/maintenance-requests/${row.id}`, { priority: 'urgent', title: 'Протекува цевка — итно' });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().priority).toBe('urgent');
    expect(edited.json().title).toBe('Протекува цевка — итно');
    await post(`/api/maintenance-requests/${row.id}/status`, { status: 'rejected' });
    const late = await patch(`/api/maintenance-requests/${row.id}`, { priority: 'low' });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('status_locked');
  });

  it('keeps another tenant out with 404, never 403', async () => {
    const row = await create();
    expect((await get(`/api/maintenance-requests/${row.id}`, b.cookie)).statusCode).toBe(404);
    expect((await post(`/api/maintenance-requests/${row.id}/status`, { status: 'triaged' }, b.cookie)).statusCode).toBe(404);
    expect((await get(`/api/buildings/${A.buildingId}/maintenance`, b.cookie)).statusCode).toBe(404);
  });

  it('refuses a unit that is not in this building', async () => {
    const otherBuilding = (await post('/api/buildings', { name: 'Востаничка 7' })).json().id;
    const res = await post(`/api/buildings/${otherBuilding}/maintenance`, { title: 'т', description: '', category: 'other', unitId });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_reference');
  });

  it('audits every mutation', async () => {
    const row = await create();
    await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: tech.id });
    await post(`/api/maintenance-requests/${row.id}/events`, { note: 'Забелешка.' });
    const actions = (await t.db.query.auditLogs.findMany({ where: (l, { eq: e }) => e(l.entityId, row.id) })).map((l) => l.action).sort();
    expect(actions).toEqual(['maintenance.assign', 'maintenance.create', 'maintenance.event']);
  });
});
```

> `A.supplierId` is not part of `PublishedBuilding`; the second case passes `supplierId: A.supplierId ?? null`, which is `null` there, so the assign body's optional supplier is exercised as "none" without the fixture growing a field.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm db:up && pnpm --filter @domar/api test maintenance`
Expected: FAIL — every case 404s, because `/api/buildings/:buildingId/maintenance` is not a route yet (`Route POST /api/buildings/…/maintenance not found`).

- [ ] **Step 3: Implement**

Create `apps/api/src/resources/maintenance/schema.ts`:

```ts
import { schema } from '@domar/db';
import { z } from 'zod';
import { fundEnum } from '../reserve-fund/schema.js';

export const maintenanceStatusEnum = z.enum(schema.maintenanceStatus.enumValues);
export const maintenancePriorityEnum = z.enum(schema.maintenancePriority.enumValues);
export const maintenanceCategoryEnum = z.enum(schema.maintenanceCategory.enumValues);
export const maintenanceEventKindEnum = z.enum(schema.maintenanceEventKind.enumValues);
export const maintenanceVisibilityEnum = z.enum(schema.maintenanceVisibility.enumValues);

/** `assigned` is missing on purpose: it is reached only through POST …/assign (plan addendum 3). */
export const maintenanceStatusTargetEnum = z.enum(['triaged', 'rejected', 'in_progress', 'done']);

export const maintenanceCreate = z.object({
  unitId: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).default(''),
  category: maintenanceCategoryEnum,
  priority: maintenancePriorityEnum.default('normal'),
});

export const maintenancePatch = z.object({
  unitId: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  category: maintenanceCategoryEnum.optional(),
  priority: maintenancePriorityEnum.optional(),
}).strict().refine((v) => Object.keys(v).length > 0, 'empty patch');

/**
 * `cost` is `z.null()` here and nothing else: this task can only close a request with no money.
 * Task 4 replaces this one field with `maintenanceCost.nullable()`; everything around it stays.
 * Its *absence* is what `cost_decision_required` refuses — `{}` and `{ cost: null }` differ.
 */
export const maintenanceStatusBody = z.object({
  status: maintenanceStatusTargetEnum,
  note: z.string().max(2000).optional(),
  visibility: maintenanceVisibilityEnum.optional(),
  cost: z.null().optional(),
});

export const maintenanceAssignBody = z.object({
  assigneeUserId: z.string().uuid(),
  supplierId: z.string().uuid().nullable().optional(),
  note: z.string().max(2000).optional(),
});

export const maintenanceEventBody = z.object({
  note: z.string().min(1).max(2000),
  visibility: maintenanceVisibilityEnum.default('internal'),
});

export const maintenancePhotoOut = z.object({
  documentId: z.string(), title: z.string(), fileName: z.string(), mime: z.string(),
  sizeBytes: z.number().int(), uploadedByName: z.string(), createdAt: z.date().or(z.string()),
});

export const maintenanceEventOut = z.object({
  id: z.string(), kind: maintenanceEventKindEnum,
  fromStatus: maintenanceStatusEnum.nullable(), toStatus: maintenanceStatusEnum.nullable(),
  note: z.string(), visibility: maintenanceVisibilityEnum,
  authorName: z.string(), authorKind: z.enum(['manager', 'owner', 'system']),
  createdAt: z.date().or(z.string()),
});

export const maintenanceRowOut = z.object({
  id: z.string(), buildingId: z.string(), unitId: z.string().nullable(), unitLabel: z.string().nullable(),
  title: z.string(), category: maintenanceCategoryEnum, priority: maintenancePriorityEnum, status: maintenanceStatusEnum,
  reporterName: z.string(), reporterKind: z.enum(['manager', 'owner']),
  assigneeUserId: z.string().nullable(), assigneeName: z.string().nullable(),
  supplierId: z.string().nullable(), supplierName: z.string().nullable(),
  fund: fundEnum.nullable(), costMinor: z.number().int().nullable(), expenseId: z.string().nullable(),
  photoCount: z.number().int(),
  closedAt: z.date().or(z.string()).nullable(), createdAt: z.date().or(z.string()), updatedAt: z.date().or(z.string()),
});

export const maintenanceOut = maintenanceRowOut.extend({
  description: z.string(),
  photos: z.array(maintenancePhotoOut),
  events: z.array(maintenanceEventOut),
});
export const maintenanceListOut = z.object({ rows: z.array(maintenanceRowOut) });
export const maintenanceListQuery = z.object({
  status: maintenanceStatusEnum.optional(),
  category: maintenanceCategoryEnum.optional(),
});

export type MaintenanceCreateInput = z.infer<typeof maintenanceCreate>;
export type MaintenancePatchInput = z.infer<typeof maintenancePatch>;
export type MaintenanceStatusInput = z.infer<typeof maintenanceStatusBody>;
export type MaintenanceAssignInput = z.infer<typeof maintenanceAssignBody>;
export type MaintenanceEventInput = z.infer<typeof maintenanceEventBody>;
```

Create `apps/api/src/resources/maintenance/repo.ts`:

```ts
import { type Db, schema } from '@domar/db';
import { MAINTENANCE_STATUSES, can, canTransition, type MaintenanceCapability, type MaintenanceRole, type MaintenanceStatus } from '@domar/domain';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { writeAudit } from '../../audit.js';
import { AppError, badRequest, conflict, notFound } from '../../errors.js';
import type { TenantContext, UserRole } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import { stripUndefined } from '../common.js';
import { assertSupplierInTenant } from '../suppliers/repo.js';
import type { MaintenanceAssignInput, MaintenanceCreateInput, MaintenanceEventInput, MaintenancePatchInput, MaintenanceStatusInput } from './schema.js';

export const MR = schema.maintenanceRequests;
const ME = schema.maintenanceEvents;
const MP = schema.maintenancePhotos;
const U = schema.units; const C = schema.contacts; const S = schema.suppliers; const USR = schema.users; const D = schema.documents;

const reporterUser = alias(USR, 'reporter_user');
const assigneeUser = alias(USR, 'assignee_user');
const authorUser = alias(USR, 'author_user');
const authorContact = alias(C, 'author_contact');
const uploaderUser = alias(USR, 'uploader_user');
const uploaderContact = alias(C, 'uploader_contact');

export type MaintenanceRow = typeof MR.$inferSelect;

export const fullName = (first: string | null, last: string | null) => `${first ?? ''} ${last ?? ''}`.trim();

/** Only a user of this tenant, active, and in a role that can actually be given work (spec §8, §10). */
const ASSIGNABLE_ROLES: UserRole[] = ['owner', 'accountant', 'technician'];

/**
 * Spec §10: a technician sees their own queue and nothing else. This one clause is added to every
 * read and every write of the table, so there is no path that forgets it (plan addendum 7).
 */
function scope(ctx: TenantContext) {
  if (ctx.role !== 'technician') return [];
  // A technician always signs in, so `userId` is set; the guard keeps the uuid comparison from ever
  // being handed an empty string, which Postgres would reject rather than treat as "no rows".
  return [ctx.userId ? eq(MR.assigneeUserId, ctx.userId) : sql`false`];
}

/** The capability the role has to hold to move a request to `to`. */
function capabilityFor(to: MaintenanceStatus, hasCost: boolean): MaintenanceCapability {
  if (to === 'triaged') return 'triage';
  if (to === 'rejected') return 'reject';
  if (to === 'in_progress') return 'progress';
  return hasCost ? 'close_with_cost' : 'close';
}

/** A status an owner reads on their card is a status they read in their timeline (addendum 11). */
const OWNER_VISIBLE_STATUSES: MaintenanceStatus[] = ['triaged', 'assigned', 'in_progress', 'done', 'rejected'];

async function assertUnitInBuilding(db: Db, ctx: TenantContext, buildingId: string, unitId: string | null | undefined): Promise<void> {
  if (!unitId) return;
  const [row] = await db.select({ id: U.id }).from(U)
    .where(and(eq(U.tenantId, ctx.tenantId), eq(U.buildingId, buildingId), eq(U.id, unitId))).limit(1);
  if (!row) throw badRequest('invalid_reference', 'unitId does not belong to this building');
}

async function assertAssignee(db: Db, ctx: TenantContext, userId: string) {
  const [row] = await db.select({ id: USR.id, role: USR.role, isActive: USR.isActive, firstName: USR.firstName, lastName: USR.lastName })
    .from(USR).where(and(eq(USR.tenantId, ctx.tenantId), eq(USR.id, userId))).limit(1);
  if (!row || !row.isActive || !ASSIGNABLE_ROLES.includes(row.role)) {
    throw badRequest('invalid_reference', 'assigneeUserId must be an active technician, accountant or owner of this organization');
  }
  return row;
}

/** The raw row, tenant-scoped and technician-scoped. Another tenant's id and somebody else's request are both 404. */
export async function getRequestRow(db: Db, ctx: TenantContext, id: string): Promise<MaintenanceRow> {
  const [row] = await db.select().from(MR).where(and(eq(MR.tenantId, ctx.tenantId), eq(MR.id, id), ...scope(ctx))).limit(1);
  if (!row) throw notFound('Maintenance request');
  return row;
}

/**
 * Claim-first, exactly like `claimAssembly`: the status is both the guard and the thing that moves,
 * so two managers closing at once produce one close, one 409 — and one expense (plan addendum 4).
 */
export async function claimRequest(tx: Db, ctx: TenantContext, id: string, allowed: MaintenanceStatus[]): Promise<MaintenanceRow> {
  const [row] = await tx.update(MR).set({ updatedAt: new Date() })
    .where(and(eq(MR.tenantId, ctx.tenantId), eq(MR.id, id), inArray(MR.status, allowed), ...scope(ctx))).returning();
  if (!row) {
    await getRequestRow(tx, ctx, id); // 404 across tenants and for a technician who is not assigned
    throw conflict('status_locked', `Only a request with status ${allowed.join(' or ')} can be changed this way`);
  }
  return row;
}

export async function recordEvent(tx: Db, ctx: TenantContext, e: {
  requestId: string;
  kind: typeof ME.$inferInsert['kind'];
  fromStatus?: MaintenanceStatus | null;
  toStatus?: MaintenanceStatus | null;
  note?: string;
  visibility?: typeof ME.$inferInsert['visibility'];
  authorContactId?: string | null;
}): Promise<void> {
  await tx.insert(ME).values({
    tenantId: ctx.tenantId,
    maintenanceRequestId: e.requestId,
    kind: e.kind,
    fromStatus: e.fromStatus ?? null,
    toStatus: e.toStatus ?? null,
    note: e.note ?? '',
    visibility: e.visibility ?? 'internal',
    // Exactly one author, or none: the portal passes a contact, staff routes pass neither and let
    // `ctx.userId` sign the row (the table's check is `<= 1`, so a job with no user is legal too).
    authorUserId: e.authorContactId ? null : ctx.userId,
    authorContactId: e.authorContactId ?? null,
  });
}

/** The subquery spells its table and column out: drizzle renders single-table selects unqualified. */
export const PHOTO_COUNT = sql<number>`(select count(*) from "maintenance_photos" p where p.maintenance_request_id = "maintenance_requests"."id")`.mapWith(Number);

const selection = {
  r: MR,
  unitLabel: U.label,
  reporterFirst: reporterUser.firstName, reporterLast: reporterUser.lastName,
  contactFirst: C.firstName, contactLast: C.lastName,
  assigneeFirst: assigneeUser.firstName, assigneeLast: assigneeUser.lastName,
  supplierName: S.name,
  photoCount: PHOTO_COUNT,
};

/** What `baseQuery` yields. Written out rather than inferred so `toRow` needs no cast. */
interface Joined {
  r: MaintenanceRow;
  unitLabel: string | null;
  reporterFirst: string | null; reporterLast: string | null;
  contactFirst: string | null; contactLast: string | null;
  assigneeFirst: string | null; assigneeLast: string | null;
  supplierName: string | null;
  photoCount: number;
}

function toRow(r: Joined) {
  const owner = r.r.reportedByContactId !== null;
  return {
    id: r.r.id, buildingId: r.r.buildingId, unitId: r.r.unitId, unitLabel: r.unitLabel,
    title: r.r.title, category: r.r.category, priority: r.r.priority, status: r.r.status,
    reporterName: owner ? fullName(r.contactFirst, r.contactLast) : fullName(r.reporterFirst, r.reporterLast),
    reporterKind: owner ? ('owner' as const) : ('manager' as const),
    assigneeUserId: r.r.assigneeUserId, assigneeName: r.r.assigneeUserId ? fullName(r.assigneeFirst, r.assigneeLast) : null,
    supplierId: r.r.supplierId, supplierName: r.supplierName,
    fund: r.r.fund, costMinor: r.r.costMinor, expenseId: r.r.expenseId,
    photoCount: r.photoCount,
    closedAt: r.r.closedAt, createdAt: r.r.createdAt, updatedAt: r.r.updatedAt,
  };
}

function baseQuery(db: Db) {
  return db.select(selection).from(MR)
    .leftJoin(U, and(eq(U.id, MR.unitId), eq(U.tenantId, MR.tenantId)))
    .leftJoin(reporterUser, eq(reporterUser.id, MR.reportedByUserId))
    .leftJoin(C, and(eq(C.id, MR.reportedByContactId), eq(C.tenantId, MR.tenantId)))
    .leftJoin(assigneeUser, eq(assigneeUser.id, MR.assigneeUserId))
    .leftJoin(S, and(eq(S.id, MR.supplierId), eq(S.tenantId, MR.tenantId)));
}

export async function listRequests(db: Db, ctx: TenantContext, buildingId: string, q: { status?: MaintenanceStatus | undefined; category?: MaintenanceRow['category'] | undefined }) {
  await getBuilding(db, ctx, buildingId); // 404 across tenants, before anything is read
  const rows = await baseQuery(db)
    .where(and(eq(MR.tenantId, ctx.tenantId), eq(MR.buildingId, buildingId), ...scope(ctx),
      ...(q.status ? [eq(MR.status, q.status)] : []), ...(q.category ? [eq(MR.category, q.category)] : [])))
    .orderBy(desc(MR.createdAt), desc(MR.id));
  return { rows: rows.map((r) => toRow(r)) };
}

export async function requestPhotos(db: Db, ctx: TenantContext, requestId: string) {
  const rows = await db.select({
    documentId: MP.documentId, title: D.title, fileName: D.fileName, mime: D.mime, sizeBytes: D.sizeBytes,
    createdAt: MP.createdAt,
    userFirst: uploaderUser.firstName, userLast: uploaderUser.lastName,
    contactFirst: uploaderContact.firstName, contactLast: uploaderContact.lastName,
  }).from(MP)
    .innerJoin(D, and(eq(D.id, MP.documentId), eq(D.tenantId, MP.tenantId)))
    .leftJoin(uploaderUser, eq(uploaderUser.id, MP.uploadedByUserId))
    .leftJoin(uploaderContact, and(eq(uploaderContact.id, MP.uploadedByContactId), eq(uploaderContact.tenantId, MP.tenantId)))
    .where(and(eq(MP.tenantId, ctx.tenantId), eq(MP.maintenanceRequestId, requestId)))
    .orderBy(asc(MP.createdAt), asc(MP.id));
  return rows.map((r) => ({
    documentId: r.documentId, title: r.title, fileName: r.fileName, mime: r.mime, sizeBytes: r.sizeBytes,
    uploadedByName: r.contactFirst !== null || r.contactLast !== null
      ? fullName(r.contactFirst, r.contactLast)
      : fullName(r.userFirst, r.userLast),
    createdAt: r.createdAt,
  }));
}

export async function requestEvents(db: Db, ctx: TenantContext, requestId: string, onlyOwnerVisible = false) {
  const rows = await db.select({
    e: ME,
    userFirst: authorUser.firstName, userLast: authorUser.lastName,
    contactFirst: authorContact.firstName, contactLast: authorContact.lastName,
  }).from(ME)
    .leftJoin(authorUser, eq(authorUser.id, ME.authorUserId))
    .leftJoin(authorContact, and(eq(authorContact.id, ME.authorContactId), eq(authorContact.tenantId, ME.tenantId)))
    .where(and(eq(ME.tenantId, ctx.tenantId), eq(ME.maintenanceRequestId, requestId),
      ...(onlyOwnerVisible ? [eq(ME.visibility, 'owner')] : [])))
    .orderBy(asc(ME.createdAt), asc(ME.id));
  return rows.map((r) => ({
    id: r.e.id, kind: r.e.kind, fromStatus: r.e.fromStatus, toStatus: r.e.toStatus,
    note: r.e.note, visibility: r.e.visibility,
    authorName: r.e.authorContactId ? fullName(r.contactFirst, r.contactLast) : fullName(r.userFirst, r.userLast),
    authorKind: r.e.authorContactId ? ('owner' as const) : r.e.authorUserId ? ('manager' as const) : ('system' as const),
    createdAt: r.e.createdAt,
  }));
}

export async function getRequest(db: Db, ctx: TenantContext, id: string) {
  await getRequestRow(db, ctx, id); // 404 across tenants and outside a technician's queue
  const [row] = await baseQuery(db).where(and(eq(MR.tenantId, ctx.tenantId), eq(MR.id, id), ...scope(ctx))).limit(1);
  if (!row) throw notFound('Maintenance request');
  const [photos, events] = await Promise.all([requestPhotos(db, ctx, id), requestEvents(db, ctx, id)]);
  return { ...toRow(row), description: row.r.description, photos, events };
}

export async function createRequest(db: Db, ctx: TenantContext, buildingId: string, input: MaintenanceCreateInput) {
  return db.transaction(async (tx) => {
    await getBuilding(tx, ctx, buildingId);
    await assertUnitInBuilding(tx, ctx, buildingId, input.unitId);
    const [row] = await tx.insert(MR).values({
      tenantId: ctx.tenantId, buildingId, unitId: input.unitId ?? null,
      title: input.title, description: input.description, category: input.category, priority: input.priority,
      reportedByUserId: ctx.userId, reportedByContactId: null,
    }).returning();
    await recordEvent(tx, ctx, { requestId: row!.id, kind: 'created', toStatus: 'new', note: input.title });
    await writeAudit(tx, ctx, { action: 'maintenance.create', entityType: 'maintenance_request', entityId: row!.id, after: row });
    return getRequest(tx, ctx, row!.id);
  });
}

/** Open requests only: a closed one is evidence of what was done, not a draft (plan addendum 2). */
export async function updateRequest(db: Db, ctx: TenantContext, id: string, patch: MaintenancePatchInput) {
  return db.transaction(async (tx) => {
    const before = await claimRequest(tx, ctx, id, ['new', 'triaged', 'assigned', 'in_progress']);
    await assertUnitInBuilding(tx, ctx, before.buildingId, patch.unitId);
    const [row] = await tx.update(MR).set({ ...stripUndefined(patch), updatedAt: new Date() })
      .where(and(eq(MR.tenantId, ctx.tenantId), eq(MR.id, id))).returning();
    await writeAudit(tx, ctx, { action: 'maintenance.update', entityType: 'maintenance_request', entityId: id, before, after: row });
    return getRequest(tx, ctx, id);
  });
}

export async function setStatus(db: Db, ctx: TenantContext, id: string, input: MaintenanceStatusInput) {
  const to = input.status as MaintenanceStatus;
  const hasCost = input.cost != null;
  if (!can(ctx.role as MaintenanceRole, capabilityFor(to, hasCost))) {
    if (hasCost) throw new AppError(403, 'cost_requires_write_role', 'Only an owner or an accountant may close a request with a cost');
    throw new AppError(403, 'forbidden', 'Not allowed');
  }
  // Explicitly `undefined`, not falsy: `{ cost: null }` is a decision, a missing key is not (addendum 5).
  if (to === 'done' && input.cost === undefined) {
    throw badRequest('cost_decision_required', 'Closing a request requires either a cost or an explicit null');
  }
  const froms = MAINTENANCE_STATUSES.filter((s) => canTransition(s, to));
  return db.transaction(async (tx) => {
    const before = await claimRequest(tx, ctx, id, [...froms]);
    const [row] = await tx.update(MR).set({ status: to, updatedAt: new Date(), ...(to === 'done' ? { closedAt: new Date() } : {}) })
      .where(and(eq(MR.tenantId, ctx.tenantId), eq(MR.id, id))).returning();
    await recordEvent(tx, ctx, {
      requestId: id, kind: 'status_changed', fromStatus: before.status, toStatus: to, note: input.note ?? '',
      visibility: input.visibility ?? (OWNER_VISIBLE_STATUSES.includes(to) ? 'owner' : 'internal'),
    });
    await writeAudit(tx, ctx, { action: 'maintenance.status', entityType: 'maintenance_request', entityId: id, before, after: row });
    return getRequest(tx, ctx, id);
  });
}

/**
 * `new|triaged` become `assigned`; `assigned|in_progress` keep their status and only change hands,
 * because a technician who has already started is not back at the beginning (plan addendum 3).
 */
export async function assignRequest(db: Db, ctx: TenantContext, id: string, input: MaintenanceAssignInput) {
  return db.transaction(async (tx) => {
    const assignee = await assertAssignee(tx, ctx, input.assigneeUserId);
    await assertSupplierInTenant(tx, ctx, input.supplierId);
    const before = await claimRequest(tx, ctx, id, ['new', 'triaged', 'assigned', 'in_progress']);
    // `claimRequest` already refused a terminal request, so this is the whole choice there is.
    const to: MaintenanceStatus = before.status === 'in_progress' ? 'in_progress' : 'assigned';
    const [row] = await tx.update(MR).set({
      assigneeUserId: input.assigneeUserId, status: to, updatedAt: new Date(),
      ...(input.supplierId !== undefined ? { supplierId: input.supplierId } : {}),
    }).where(and(eq(MR.tenantId, ctx.tenantId), eq(MR.id, id))).returning();
    await recordEvent(tx, ctx, {
      requestId: id, kind: 'assigned', fromStatus: before.status, toStatus: to,
      note: input.note ?? fullName(assignee.firstName, assignee.lastName), visibility: 'owner',
    });
    await writeAudit(tx, ctx, { action: 'maintenance.assign', entityType: 'maintenance_request', entityId: id, before, after: row });
    return getRequest(tx, ctx, id);
  });
}

export async function addEvent(db: Db, ctx: TenantContext, id: string, input: MaintenanceEventInput) {
  return db.transaction(async (tx) => {
    const row = await getRequestRow(tx, ctx, id);
    await recordEvent(tx, ctx, { requestId: row.id, kind: 'comment', note: input.note, visibility: input.visibility });
    await writeAudit(tx, ctx, { action: 'maintenance.event', entityType: 'maintenance_request', entityId: id, after: { note: input.note, visibility: input.visibility } });
    return getRequest(tx, ctx, id);
  });
}
```

Create `apps/api/src/resources/maintenance/routes.ts`:

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { MAINTENANCE_ROLES, requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { idParam } from '../common.js';
import { buildingParam } from '../units/schema.js';
import { addEvent, assignRequest, createRequest, getRequest, listRequests, setStatus, updateRequest } from './repo.js';
import { maintenanceAssignBody, maintenanceCreate, maintenanceEventBody, maintenanceListOut, maintenanceListQuery, maintenanceOut, maintenancePatch, maintenanceStatusBody } from './schema.js';

/** Spec §8 board of one building. Reads are open to every role; a technician's list is their own. */
export const buildingMaintenanceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', { schema: { params: buildingParam, querystring: maintenanceListQuery, response: { 200: maintenanceListOut } } }, async (req) =>
    listRequests(req.db, req.ctx!, req.params.buildingId, req.query));

  app.post('/', { preHandler: requireRole(...WRITE_ROLES), schema: { params: buildingParam, body: maintenanceCreate, response: { 201: maintenanceOut } } }, async (req, reply) =>
    reply.status(201).send(await createRequest(req.db, req.ctx!, req.params.buildingId, req.body)));
};

export const maintenanceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  const write = { preHandler: requireRole(...WRITE_ROLES) };
  // Spec §10: the technician's three verbs. The repo scopes each of them to their own requests.
  const worker = { preHandler: requireRole(...MAINTENANCE_ROLES) };

  app.get('/:id', { schema: { params: idParam, response: { 200: maintenanceOut } } }, async (req) =>
    getRequest(req.db, req.ctx!, req.params.id));

  app.patch('/:id', { ...write, schema: { params: idParam, body: maintenancePatch, response: { 200: maintenanceOut } } }, async (req) =>
    updateRequest(req.db, req.ctx!, req.params.id, req.body));

  app.post('/:id/status', { ...worker, schema: { params: idParam, body: maintenanceStatusBody, response: { 200: maintenanceOut } } }, async (req) =>
    setStatus(req.db, req.ctx!, req.params.id, req.body));

  app.post('/:id/assign', { ...write, schema: { params: idParam, body: maintenanceAssignBody, response: { 200: maintenanceOut } } }, async (req) =>
    assignRequest(req.db, req.ctx!, req.params.id, req.body));

  app.post('/:id/events', { ...worker, schema: { params: idParam, body: maintenanceEventBody, response: { 201: maintenanceOut } } }, async (req, reply) =>
    reply.status(201).send(await addEvent(req.db, req.ctx!, req.params.id, req.body)));
};
```

Append one export to `apps/api/src/auth/roles.ts`, after `WRITE_ROLES`:

```ts
/** Spec §10: the roles that may work a maintenance request. A technician is scoped again in the repo. */
export const MAINTENANCE_ROLES: UserRole[] = ['owner', 'accountant', 'technician'];
```

In `apps/api/src/app.ts`, add the import beside the other resource imports:

```ts
import { buildingMaintenanceRoutes, maintenanceRoutes } from './resources/maintenance/routes.js';
```

and the two registrations inside the `/api` plugin, after the `buildingAssemblyRoutes`/`assemblyRoutes` pair:

```ts
    await api.register(buildingMaintenanceRoutes, { prefix: '/buildings/:buildingId/maintenance' });
    await api.register(maintenanceRoutes, { prefix: '/maintenance-requests' });
```

- [ ] **Step 4: Run tests**

Run: `pnpm db:up && pnpm --filter @domar/api test && pnpm --filter @domar/api typecheck && pnpm lint`
Expected: PASS — 15 new cases in `maintenance.test.ts`, and `openapi.test.ts`, `roles.test.ts` and every other API suite still green.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): maintenance requests, their transitions, assignment and event feed" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: API — photos, closing with a cost, and the owner's portal routes

**Files:**
- Modify: `apps/api/src/resources/maintenance/schema.ts`
- Modify: `apps/api/src/resources/maintenance/repo.ts`
- Create: `apps/api/src/resources/maintenance/photos.ts`
- Modify: `apps/api/src/resources/maintenance/routes.ts`
- Create: `apps/api/src/portal/maintenance-repo.ts`
- Create: `apps/api/src/portal/maintenance-routes.ts`
- Modify: `apps/api/src/portal/schema.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/test/maintenance-photos.test.ts`
- Create: `apps/api/test/portal-maintenance.test.ts`

**Interfaces (consumed by Tasks 5, 6 and 7):**
- Routes: `POST /api/maintenance-requests/:id/photos`, `DELETE /api/maintenance-requests/:id/photos/:documentId`, `POST /api/maintenance-requests/:id/status` with a `cost` object; `GET|POST /api/portal/maintenance`, `GET /api/portal/maintenance/:id`, `POST /api/portal/maintenance/:id/events`, `POST /api/portal/maintenance/:id/photos`, `GET /api/portal/maintenance/:id/photos/:documentId`
- `photos.ts`: `PHOTO_MIME`, `MAX_PHOTO_BYTES`, `MAX_PHOTOS_PER_REQUEST`, `addPhoto`, `deletePhoto`, `photoFile`
- `schema.ts`: `maintenanceCost`, `maintenancePhotoParam`
- `portal/schema.ts`: `portalMaintenanceRowOut`, `portalMaintenanceOut`, `portalMaintenanceListOut`, `portalMaintenanceCreateBody`, `portalMaintenanceEventBody`, `portalMaintenancePhotoParam`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/maintenance-photos.test.ts`:

```ts
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupPublishedBuilding } from './billing-fixture.js';
import { createStaffUser, registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

/** A real 1×1 PNG: the store hashes whatever it gets, and a real one keeps the fixture honest. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1');

function multipart(fields: Record<string, string>, file: { filename: string; mime: string; content: Buffer }) {
  const boundary = `----domar${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`, 'utf8'));
  parts.push(file.content, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('maintenance photos and the cost of a closed request', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let A: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  let tech: { id: string; cookie: string };
  let supplierId = '';

  const post = (url: string, payload: unknown, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload: payload as never });
  const get = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? a.cookie } });
  const upload = (id: string, file: { filename: string; mime: string; content: Buffer }, cookie?: string) => {
    const m = multipart({ title: 'Фотографија од дефектот' }, file);
    return t.app.inject({ method: 'POST', url: `/api/maintenance-requests/${id}/photos`, headers: { cookie: cookie ?? a.cookie, ...m.headers }, payload: m.payload });
  };
  const create = async () => (await post(`/api/buildings/${A.buildingId}/maintenance`, {
    title: 'Протекува цевка во визбата', description: 'Вода тече покрај вертикалата.', category: 'plumbing', priority: 'high',
  })).json();

  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-foto');
    A = await setupPublishedBuilding(t.app, a.cookie);
    tech = await createStaffUser(t.app, a.cookie, 'firma-foto', { email: 'stefan@firma-foto.mk', firstName: 'Стефан', lastName: 'Стефановски', role: 'technician' });
    supplierId = (await post('/api/suppliers', { name: 'Водовод Инженеринг ДООЕЛ' })).json().id;
  });
  afterAll(async () => { await t.close(); });

  it('stores a photo as a document of kind photo, linked to the request', async () => {
    const row = await create();
    const res = await upload(row.id, { filename: 'defekt.png', mime: 'image/png', content: PNG });
    expect(res.statusCode, res.body).toBe(201);
    const photos = res.json().photos;
    expect(photos).toHaveLength(1);
    expect(photos[0].fileName).toBe('defekt.png');
    expect(photos[0].mime).toBe('image/png');
    expect(photos[0].sizeBytes).toBe(PNG.length);
    expect(photos[0].uploadedByName).toBe('O firma-foto');
    expect(res.json().photoCount).toBe(1);

    const doc = (await get(`/api/documents/${photos[0].documentId}`)).json();
    expect(doc.kind).toBe('photo');
    expect(doc.buildingId).toBe(A.buildingId);
    const download = await get(`/api/documents/${photos[0].documentId}/download`);
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('image/png');
    expect(Buffer.from(download.rawPayload).equals(PNG)).toBe(true);

    const events = (await get(`/api/maintenance-requests/${row.id}`)).json().events;
    expect(events.at(-1)).toMatchObject({ kind: 'photo_added', visibility: 'owner' });
  });

  it('refuses anything that is not a png or a jpeg', async () => {
    const row = await create();
    const res = await upload(row.id, { filename: 'racun.pdf', mime: 'application/pdf', content: PDF });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('unsupported_media_type');
    expect((await get(`/api/maintenance-requests/${row.id}`)).json().photos).toEqual([]);
  });

  it('lets the assigned technician add a photo and keeps everyone else out', async () => {
    const mine = await create();
    const theirs = await create();
    await post(`/api/maintenance-requests/${mine.id}/assign`, { assigneeUserId: tech.id });
    const ok = await upload(mine.id, { filename: 'popraveno.jpg', mime: 'image/jpeg', content: PNG }, tech.cookie);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().photos[0].uploadedByName).toBe('Стефан Стефановски');
    expect((await upload(theirs.id, { filename: 'x.png', mime: 'image/png', content: PNG }, tech.cookie)).statusCode).toBe(404);
  });

  it('deletes a photo, its document row and its bytes', async () => {
    const row = await create();
    const documentId = (await upload(row.id, { filename: 'za-brisenje.png', mime: 'image/png', content: PNG })).json().photos[0].documentId;
    const year = String(new Date().getUTCFullYear());
    const before = await readdir(join(t.dataDir, 'documents', a.tenantId, year));
    const res = await t.app.inject({ method: 'DELETE', url: `/api/maintenance-requests/${row.id}/photos/${documentId}`, headers: { cookie: a.cookie } });
    expect(res.statusCode).toBe(204);
    expect((await get(`/api/maintenance-requests/${row.id}`)).json().photos).toEqual([]);
    expect((await get(`/api/documents/${documentId}`)).statusCode).toBe(404);
    const after = await readdir(join(t.dataDir, 'documents', a.tenantId, year));
    expect(after.length).toBe(before.length - 1);
    // A technician may add to their own request but never remove evidence.
    expect((await t.app.inject({ method: 'DELETE', url: `/api/maintenance-requests/${row.id}/photos/${documentId}`, headers: { cookie: tech.cookie } })).statusCode).toBe(403);
  });

  it('drops the gallery entry when the document itself is deleted', async () => {
    const row = await create();
    const documentId = (await upload(row.id, { filename: 'preku-dokumenti.png', mime: 'image/png', content: PNG })).json().photos[0].documentId;
    const res = await t.app.inject({ method: 'DELETE', url: `/api/documents/${documentId}`, headers: { cookie: a.cookie } });
    expect(res.statusCode).toBe(204);
    expect((await get(`/api/maintenance-requests/${row.id}`)).json().photos).toEqual([]);
  });

  it('closes with a cost through the existing expense flow and moves the fund', async () => {
    const row = await create();
    await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: tech.id });
    await post(`/api/maintenance-requests/${row.id}/status`, { status: 'in_progress' }, tech.cookie);

    const fundBefore = (await get(`/api/buildings/${A.buildingId}/reserve-fund`)).json().balanceMinor;
    expect(fundBefore).toBe(3_500_000);

    const done = await post(`/api/maintenance-requests/${row.id}/status`, {
      status: 'done', note: 'Заменета спојка.', visibility: 'owner',
      cost: { fund: 'reserve', costMinor: 1_200_000, supplierId },
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().status).toBe('done');
    expect(done.json().fund).toBe('reserve');
    expect(done.json().costMinor).toBe(1_200_000);
    expect(done.json().supplierId).toBe(supplierId);
    const expenseId = done.json().expenseId;
    expect(expenseId).toEqual(expect.any(String));

    const expense = (await get(`/api/buildings/${A.buildingId}/reserve-fund/expenses`)).json().rows.find((e: { id: string }) => e.id === expenseId);
    expect(expense).toMatchObject({
      fund: 'reserve', amountMinor: 1_200_000, supplierId,
      description: 'Одржување: Водовод и канализација — Протекува цевка во визбата',
    });

    const state = (await get(`/api/buildings/${A.buildingId}/reserve-fund`)).json();
    expect(state.balanceMinor).toBe(3_500_000 - 1_200_000);
    const tx = (await get(`/api/buildings/${A.buildingId}/reserve-fund/transactions`)).json().rows;
    expect(tx[0]).toMatchObject({ kind: 'expense', fund: 'reserve', amountMinor: -1_200_000, refType: 'expense', refId: expenseId });
  });

  it('refuses a technician the cost, and books nothing when it does', async () => {
    const row = await create();
    await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: tech.id });
    const before = (await get(`/api/buildings/${A.buildingId}/reserve-fund`)).json().balanceMinor;
    const res = await post(`/api/maintenance-requests/${row.id}/status`, { status: 'done', cost: { fund: 'reserve', costMinor: 500_000 } }, tech.cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('cost_requires_write_role');
    expect((await get(`/api/maintenance-requests/${row.id}`, tech.cookie)).json().status).toBe('assigned');
    expect((await get(`/api/buildings/${A.buildingId}/reserve-fund`)).json().balanceMinor).toBe(before);
    // Without a cost the same technician closes it.
    const ok = await post(`/api/maintenance-requests/${row.id}/status`, { status: 'done', cost: null }, tech.cookie);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().expenseId).toBeNull();
  });

  it('rolls the whole close back when the cost cannot be booked', async () => {
    const row = await create();
    await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: tech.id });
    const before = (await get(`/api/buildings/${A.buildingId}/reserve-fund`)).json().balanceMinor;
    const res = await post(`/api/maintenance-requests/${row.id}/status`, {
      status: 'done', cost: { fund: 'reserve', costMinor: 100_000, supplierId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_reference');
    expect((await get(`/api/maintenance-requests/${row.id}`)).json().status).toBe('assigned');
    expect((await get(`/api/buildings/${A.buildingId}/reserve-fund`)).json().balanceMinor).toBe(before);
  });

  it('refuses a photo on a closed request', async () => {
    const row = await create();
    await post(`/api/maintenance-requests/${row.id}/status`, { status: 'rejected', note: 'Двојна пријава.' });
    const res = await upload(row.id, { filename: 'docna.png', mime: 'image/png', content: PNG });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('status_locked');
  });
});
```

Create `apps/api/test/portal-maintenance.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupPublishedBuilding } from './billing-fixture.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function multipart(fields: Record<string, string>, file: { filename: string; mime: string; content: Buffer }) {
  const boundary = `----domar${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`, 'utf8'));
  parts.push(file.content, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('portal maintenance', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  let A: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  let B: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  let ownerCookie = '';
  let neighbourCookie = '';
  let strangerCookie = '';
  let unitId = '';
  let requestId = '';

  const staffPost = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const staffGet = (url: string) => t.app.inject({ method: 'GET', url, headers: { cookie: a.cookie } });
  const portalGet = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? ownerCookie } });
  const portalPost = (url: string, payload: Record<string, unknown>, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? ownerCookie }, payload });
  const registerOwner = async (contactId: string, email: string, staffCookie: string) => {
    const code = (await staffPost(`/api/contacts/${contactId}/portal-invite`, {}, staffCookie)).json().code;
    const res = await t.app.inject({ method: 'POST', url: '/api/portal/register', payload: { code, email, password: 'correct-horse-1' } });
    expect(res.statusCode, res.body).toBe(201);
    return String(res.headers['set-cookie']).split(';')[0]!;
  };

  beforeAll(async () => {
    t = await createTestApp({ SMTP_URL: 'json' });
    a = await registerTenant(t.app, 'firma-pm');
    b = await registerTenant(t.app, 'firma-pm2');
    A = await setupPublishedBuilding(t.app, a.cookie);
    B = await setupPublishedBuilding(t.app, b.cookie);
    unitId = (await staffGet(`/api/buildings/${A.buildingId}/units`)).json().rows.find((u: { label: string }) => u.label === '1').id;
    ownerCookie = await registerOwner(A.owners.O1, 'o1@owner.mk', a.cookie);
    neighbourCookie = await registerOwner(A.owners.O2, 'o2@owner.mk', a.cookie);
    strangerCookie = await registerOwner(B.owners.O1, 'b1@owner.mk', b.cookie);
  });
  afterAll(async () => { await t.close(); });

  it('an owner reports a problem in their own building', async () => {
    const res = await portalPost('/api/portal/maintenance', {
      contactId: A.owners.O1, buildingId: A.buildingId, unitId,
      title: 'Протекува цевка во визбата', description: 'Вода тече покрај вертикалата под влезот.',
      category: 'plumbing', priority: 'high',
    });
    expect(res.statusCode, res.body).toBe(201);
    requestId = res.json().id;
    expect(res.json()).toMatchObject({
      status: 'new', category: 'plumbing', priority: 'high',
      buildingName: 'Партизанска 12', unitLabel: '1', photoCount: 0,
    });
    // The owner is the reporter, on the manager's board too.
    const board = (await staffGet(`/api/buildings/${A.buildingId}/maintenance`)).json().rows;
    expect(board[0]).toMatchObject({ id: requestId, reporterKind: 'owner', reporterName: 'Тест Анѓеловски' });
  });

  it('refuses a building the owner has no unit in, and another tenant’s building, both with 404', async () => {
    const body = { contactId: A.owners.O1, buildingId: B.buildingId, title: 'т', description: '', category: 'other', priority: 'normal' };
    expect((await portalPost('/api/portal/maintenance', body)).statusCode).toBe(404);
    // A contact id the caller holds no link to is a 404 before a tenant is ever resolved.
    expect((await portalPost('/api/portal/maintenance', { ...body, contactId: B.owners.O1, buildingId: B.buildingId })).statusCode).toBe(404);
  });

  it('refuses a unit somebody else owns', async () => {
    const otherUnit = (await staffGet(`/api/buildings/${A.buildingId}/units`)).json().rows.find((u: { label: string }) => u.label === '2').id;
    const res = await portalPost('/api/portal/maintenance', {
      contactId: A.owners.O1, buildingId: A.buildingId, unitId: otherUnit,
      title: 'т', description: '', category: 'other', priority: 'normal',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_reference');
  });

  it('lists the owner’s own requests and nobody else’s', async () => {
    const mine = (await portalGet(`/api/portal/maintenance?contactId=${A.owners.O1}`)).json();
    expect(mine.rows.map((r: { id: string }) => r.id)).toEqual([requestId]);
    const neighbour = (await portalGet(`/api/portal/maintenance?contactId=${A.owners.O2}`, neighbourCookie)).json();
    expect(neighbour.rows).toEqual([]);
    expect((await portalGet(`/api/portal/maintenance/${requestId}?contactId=${A.owners.O2}`, neighbourCookie)).statusCode).toBe(404);
    expect((await portalGet(`/api/portal/maintenance/${requestId}?contactId=${B.owners.O1}`, strangerCookie)).statusCode).toBe(404);
  });

  it('shows the owner only the owner-visible half of the feed', async () => {
    await staffPost(`/api/maintenance-requests/${requestId}/events`, { note: 'Домаќинот не се јавува, пробај попладне.', visibility: 'internal' });
    await staffPost(`/api/maintenance-requests/${requestId}/status`, { status: 'triaged', note: 'Примено, доаѓаме утре.', visibility: 'owner' });

    const detail = (await portalGet(`/api/portal/maintenance/${requestId}?contactId=${A.owners.O1}`)).json();
    expect(detail.status).toBe('triaged');
    const notes = detail.events.map((e: { note: string }) => e.note);
    expect(notes).toContain('Примено, доаѓаме утре.');
    expect(notes).not.toContain('Домаќинот не се јавува, пробај попладне.');
    // The internal note is not merely unrendered: the field it hid behind never reaches the wire.
    expect(JSON.stringify(detail)).not.toContain('visibility');
    expect(detail.events[0]).toMatchObject({ kind: 'created', authorKind: 'owner', authorName: 'Тест Анѓеловски' });
  });

  it('lets the owner add a note, always visible to themselves and to the manager', async () => {
    const res = await portalPost(`/api/portal/maintenance/${requestId}/events`, { contactId: A.owners.O1, note: 'Стана полошо, водата стигна до визбата.' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().events.at(-1)).toMatchObject({ note: 'Стана полошо, водата стигна до визбата.', authorKind: 'owner' });
    const staff = (await staffGet(`/api/maintenance-requests/${requestId}`)).json();
    expect(staff.events.at(-1)).toMatchObject({ visibility: 'owner', authorKind: 'owner', authorName: 'Тест Анѓеловски' });
  });

  it('accepts the owner’s photo and serves it back to them, but not to a neighbour', async () => {
    const m = multipart({ contactId: A.owners.O1 }, { filename: 'voda.png', mime: 'image/png', content: PNG });
    const res = await t.app.inject({ method: 'POST', url: `/api/portal/maintenance/${requestId}/photos`, headers: { cookie: ownerCookie, ...m.headers }, payload: m.payload });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().photos).toHaveLength(1);
    const documentId = res.json().photos[0].documentId;

    const file = await portalGet(`/api/portal/maintenance/${requestId}/photos/${documentId}?contactId=${A.owners.O1}`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(Buffer.from(file.rawPayload).equals(PNG)).toBe(true);
    expect((await portalGet(`/api/portal/maintenance/${requestId}/photos/${documentId}?contactId=${A.owners.O2}`, neighbourCookie)).statusCode).toBe(404);

    // The manager sees it on the board, attributed to the owner.
    const staff = (await staffGet(`/api/maintenance-requests/${requestId}`)).json();
    expect(staff.photos[0]).toMatchObject({ documentId, uploadedByName: 'Тест Анѓеловски' });
  });

  it('gives the owner no way to change a status', async () => {
    const res = await portalPost(`/api/portal/maintenance/${requestId}/status`, { contactId: A.owners.O1, status: 'done' });
    expect(res.statusCode).toBe(404); // no such route at all
    const staffOnly = await t.app.inject({ method: 'POST', url: `/api/maintenance-requests/${requestId}/status`, headers: { cookie: ownerCookie }, payload: { status: 'done', cost: null } });
    expect(staffOnly.statusCode).toBe(401); // an owner cookie is not a staff session
  });

  it('shows the owner the closed request with the manager’s note', async () => {
    await staffPost(`/api/maintenance-requests/${requestId}/assign`, { assigneeUserId: a.userId });
    await staffPost(`/api/maintenance-requests/${requestId}/status`, { status: 'in_progress' });
    await staffPost(`/api/maintenance-requests/${requestId}/status`, {
      status: 'done', note: 'Заменета спојка, дефектот е отстранет.', visibility: 'owner',
      cost: { fund: 'reserve', costMinor: 1_200_000 },
    });
    const detail = (await portalGet(`/api/portal/maintenance/${requestId}?contactId=${A.owners.O1}`)).json();
    expect(detail.status).toBe('done');
    expect(detail.closedAt).not.toBeNull();
    expect(detail.events.at(-1).note).toBe('Заменета спојка, дефектот е отстранет.');
    // The money is the manager's business: the portal row carries no cost at all.
    expect(JSON.stringify(detail)).not.toContain('costMinor');
    // …but the fund page shows the expense, described in Macedonian (spec §45(4), addendum 14).
    const fund = (await portalGet(`/api/portal/buildings/${A.buildingId}/fund?contactId=${A.owners.O1}`)).json();
    expect(fund.transactions[0]).toMatchObject({ kind: 'expense', fund: 'reserve', amountMinor: -1_200_000 });
    expect(fund.transactions[0].description).toBe('Одржување: Водовод и канализација — Протекува цевка во визбата');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm db:up && pnpm --filter @domar/api test maintenance-photos portal-maintenance`
Expected: FAIL — the photo upload 404s (`Route POST /api/maintenance-requests/…/photos not found`), the cost body is rejected by zod (`cost` only accepts `null`), and every portal case 404s.

- [ ] **Step 3: Implement**

In `apps/api/src/resources/maintenance/schema.ts`, add the cost object and the photo param above `maintenanceStatusBody`:

```ts
/** What a close books. `costMinor` is minor units and positive; `createExpense` signs the posting. */
export const maintenanceCost = z.object({
  fund: fundEnum,
  costMinor: z.number().int().min(1).max(1_000_000_000_000),
  supplierId: z.string().uuid().nullable().optional(),
  documentId: z.string().uuid().nullable().optional(),
});
export const maintenancePhotoParam = z.object({ id: z.string().uuid(), documentId: z.string().uuid() });
```

and replace the one `cost` line inside `maintenanceStatusBody`:

```ts
  cost: z.null().optional(),
```

with

```ts
  cost: maintenanceCost.nullable().optional(),
```

Create `apps/api/src/resources/maintenance/photos.ts`:

```ts
import type { Readable } from 'node:stream';
import { type Db, schema } from '@domar/db';
import { isTerminal } from '@domar/domain';
import { and, count, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { writeAudit } from '../../audit.js';
import type { DocumentStore } from '../../documents/store.js';
import { conflict, notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { createDocument } from '../documents/repo.js';
import { getRequestRow, recordEvent } from './repo.js';

const MP = schema.maintenancePhotos;
const D = schema.documents;

/** Spec §4 stores photos as documents; §11 wants them mime-checked and size-capped. Narrower than `ALLOWED_MIME`. */
export const PHOTO_MIME: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg' };
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const MAX_PHOTOS_PER_REQUEST = 12;

export interface NewPhoto {
  title: string;
  fileName: string;
  mime: string;
  stream: Readable;
  isTruncated: () => boolean;
  /** Set when the upload arrived through the portal; the staff route leaves it out. */
  contactId?: string | undefined;
}

/**
 * The bytes go through the same `createDocument` every other document does — same store, same
 * sha256, same audit row — with a narrower allowlist. The join row follows in its own transaction,
 * and if that fails the document is unwound, because a `photo` document nothing points at is a file
 * no screen can ever show or delete.
 *
 * The caller has already proved it may touch this request: the staff route through `getRequestRow`
 * below, the portal route through `resolveLink` + `assertOwnsUnitIn` + the reporter check.
 */
export async function addPhoto(db: Db, ctx: TenantContext, store: DocumentStore, requestId: string, input: NewPhoto) {
  const request = await getRequestRow(db, ctx, requestId);
  if (isTerminal(request.status)) throw conflict('status_locked', 'A closed request takes no more photos');
  const [existing] = await db.select({ n: count() }).from(MP)
    .where(and(eq(MP.tenantId, ctx.tenantId), eq(MP.maintenanceRequestId, requestId)));
  if (Number(existing?.n ?? 0) >= MAX_PHOTOS_PER_REQUEST) {
    throw conflict('too_many_photos', `A request holds at most ${MAX_PHOTOS_PER_REQUEST} photos`);
  }
  const created = await createDocument(db, ctx, store, {
    buildingId: request.buildingId,
    kind: 'photo',
    title: input.title,
    fileName: input.fileName,
    mime: input.mime,
    stream: input.stream,
    isTruncated: input.isTruncated,
    allow: PHOTO_MIME,
  });
  try {
    await db.transaction(async (tx) => {
      await tx.insert(MP).values({
        tenantId: ctx.tenantId,
        maintenanceRequestId: requestId,
        documentId: created.id,
        uploadedByUserId: input.contactId ? null : ctx.userId,
        uploadedByContactId: input.contactId ?? null,
      });
      await recordEvent(tx, ctx, {
        requestId, kind: 'photo_added', note: created.fileName, visibility: 'owner',
        ...(input.contactId ? { authorContactId: input.contactId } : {}),
      });
      await writeAudit(tx, ctx, {
        action: 'maintenance.photo.create', entityType: 'maintenance_request', entityId: requestId,
        after: { documentId: created.id, fileName: created.fileName, sizeBytes: created.sizeBytes },
      });
    });
  } catch (err) {
    await db.delete(D).where(and(eq(D.tenantId, ctx.tenantId), eq(D.id, created.id)));
    await store.remove(created.storageKey);
    throw err;
  }
}

/** The photo row, its document and its bytes. `WRITE_ROLES` only: a technician adds evidence, never removes it. */
export async function deletePhoto(db: Db, ctx: TenantContext, store: DocumentStore, requestId: string, documentId: string, log?: FastifyBaseLogger): Promise<void> {
  await getRequestRow(db, ctx, requestId);
  const storageKey = await db.transaction(async (tx) => {
    const [row] = await tx.select({ storageKey: D.storageKey, fileName: D.fileName }).from(MP)
      .innerJoin(D, and(eq(D.id, MP.documentId), eq(D.tenantId, MP.tenantId)))
      .where(and(eq(MP.tenantId, ctx.tenantId), eq(MP.maintenanceRequestId, requestId), eq(MP.documentId, documentId))).limit(1);
    if (!row) throw notFound('Photo');
    // The join row goes with it: `maintenance_photos.document_id` is `on delete cascade`.
    await tx.delete(D).where(and(eq(D.tenantId, ctx.tenantId), eq(D.id, documentId)));
    await writeAudit(tx, ctx, {
      action: 'maintenance.photo.delete', entityType: 'maintenance_request', entityId: requestId,
      before: { documentId, fileName: row.fileName },
    });
    return row.storageKey;
  });
  try {
    await store.remove(storageKey);
  } catch (err) {
    log?.warn({ err, documentId }, 'maintenance photo row deleted but its file could not be removed');
  }
}

/** The document row behind one photo of one request, for streaming it back. */
export async function photoFile(db: Db, ctx: TenantContext, requestId: string, documentId: string) {
  const [row] = await db.select({ storageKey: D.storageKey, mime: D.mime, fileName: D.fileName, sizeBytes: D.sizeBytes })
    .from(MP).innerJoin(D, and(eq(D.id, MP.documentId), eq(D.tenantId, MP.tenantId)))
    .where(and(eq(MP.tenantId, ctx.tenantId), eq(MP.maintenanceRequestId, requestId), eq(MP.documentId, documentId))).limit(1);
  if (!row) throw notFound('Photo');
  return row;
}
```

In `apps/api/src/resources/maintenance/repo.ts`, widen the imports:

```ts
import { MAINTENANCE_STATUSES, can, canTransition, getCountryPack, type CountryCode, type MaintenanceCapability, type MaintenanceRole, type MaintenanceStatus } from '@domar/domain';
```

and add, beside the other resource imports:

```ts
import { createExpense } from '../reserve-fund/repo.js';
```

then replace the body of `setStatus`'s `db.transaction` callback — everything from `const before = await claimRequest(…)` to `return getRequest(tx, ctx, id);` — with:

```ts
    const before = await claimRequest(tx, ctx, id, [...froms]);
    const cost = to === 'done' ? input.cost ?? null : null;
    let expenseId: string | null = null;
    let costNote = '';
    if (cost) {
      // Spec §11: the money reaches the ledger through the existing expense flow and no other way.
      // Inside this transaction, so a refused supplier rolls the close back with it (addendum 5).
      const building = await getBuilding(tx, ctx, before.buildingId);
      const pack = getCountryPack(building.countryCode as CountryCode);
      const label = pack.maintenanceCategories.find((c) => c.key === before.category)?.label ?? before.category;
      costNote = `${pack.labels.maintenanceExpense}: ${label} — ${before.title}`.slice(0, 500);
      const expense = await createExpense(tx, ctx, before.buildingId, {
        fund: cost.fund,
        description: costNote,
        supplierText: null,
        supplierId: cost.supplierId ?? before.supplierId,
        documentId: cost.documentId ?? null,
        amountMinor: cost.costMinor,
        paidAt: new Date().toISOString(),
      });
      expenseId = expense.id;
    }
    const [row] = await tx.update(MR).set({
      status: to, updatedAt: new Date(),
      ...(to === 'done' ? { closedAt: new Date() } : {}),
      ...(cost ? { fund: cost.fund, costMinor: cost.costMinor, expenseId, ...(cost.supplierId ? { supplierId: cost.supplierId } : {}) } : {}),
    }).where(and(eq(MR.tenantId, ctx.tenantId), eq(MR.id, id))).returning();
    await recordEvent(tx, ctx, {
      requestId: id, kind: 'status_changed', fromStatus: before.status, toStatus: to,
      note: input.note ?? costNote,
      visibility: input.visibility ?? (OWNER_VISIBLE_STATUSES.includes(to) ? 'owner' : 'internal'),
    });
    await writeAudit(tx, ctx, { action: 'maintenance.status', entityType: 'maintenance_request', entityId: id, before, after: row });
    return getRequest(tx, ctx, id);
```

In `apps/api/src/resources/maintenance/routes.ts`, widen the imports and add the three photo routes to `maintenanceRoutes`:

```ts
import { badRequest } from '../../errors.js';
import { addPhoto, deletePhoto, MAX_PHOTO_BYTES } from './photos.js';
import { maintenancePhotoParam } from './schema.js';
```

```ts
  // Multipart, so no zod `body`: the one field is read off the part before the file (see below).
  app.post('/:id/photos', {
    ...worker,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { params: idParam, response: { 201: maintenanceOut } },
  }, async (req, reply) => {
    // Eight megabytes for a photo, not the twenty a contract may weigh: the per-request limit wins
    // over the global one, so busboy truncates at eight and `createDocument` answers 413.
    const part = await req.file({ limits: { fileSize: MAX_PHOTO_BYTES } });
    if (!part) throw badRequest('file_required', 'A file part is required');
    const filename = part.filename ?? '';
    if (!filename) throw badRequest('file_required', 'The file part must carry a filename');
    const fields = part.fields as Record<string, { value?: unknown } | undefined> | undefined;
    const rawTitle = fields?.['title'];
    const title = (typeof rawTitle?.value === 'string' ? rawTitle.value : filename).slice(0, 200).trim() || filename;
    await addPhoto(req.db, req.ctx!, app.documents, req.params.id, {
      title, fileName: filename.slice(0, 255), mime: part.mimetype, stream: part.file, isTruncated: () => part.file.truncated,
    });
    return reply.status(201).send(await getRequest(req.db, req.ctx!, req.params.id));
  });

  app.delete('/:id/photos/:documentId', { ...write, schema: { params: maintenancePhotoParam } }, async (req, reply) => {
    await deletePhoto(req.db, req.ctx!, app.documents, req.params.id, req.params.documentId, app.log);
    return reply.status(204).send();
  });
```

Create `apps/api/src/portal/maintenance-repo.ts`:

```ts
import { type Db, schema } from '@domar/db';
import type { MaintenanceCategory, MaintenancePriority } from '@domar/domain';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { writeAudit } from '../audit.js';
import type { DocumentStore } from '../documents/store.js';
import { badRequest, notFound } from '../errors.js';
import { addPhoto, photoFile, type NewPhoto } from '../resources/maintenance/photos.js';
import { MR, PHOTO_COUNT, recordEvent, requestEvents, requestPhotos } from '../resources/maintenance/repo.js';
import type { TenantContext } from '../tenant-context.js';
import type { PortalContext } from './context.js';
import { assertOwnsUnitIn, resolveLink } from './repo.js';

const B = schema.buildings; const U = schema.units;

/**
 * Spec §8's portal half. An owner sees the requests **they** reported, never the building's whole
 * board: a neighbour's free-text description is not theirs to read (plan addendum 10). Everything
 * here is `reported_by_contact_id = contactId`, and anything else is a 404.
 */
async function ownedRequest(db: Db, ctx: TenantContext, contactId: string, id: string) {
  const [row] = await db.select().from(MR)
    .where(and(eq(MR.tenantId, ctx.tenantId), eq(MR.id, id), eq(MR.reportedByContactId, contactId))).limit(1);
  if (!row) throw notFound('Maintenance request');
  // The contact must still own a unit in that building: a link that lapsed is not a key.
  await assertOwnsUnitIn(db, ctx, contactId, row.buildingId);
  return row;
}

/** Nothing about the money and nothing about internal handling reaches this shape. */
function toPortalRow(row: typeof MR.$inferSelect, buildingName: string, unitLabel: string | null, photoCount: number) {
  return {
    id: row.id, buildingId: row.buildingId, buildingName, unitLabel,
    title: row.title, category: row.category, priority: row.priority, status: row.status,
    photoCount, closedAt: row.closedAt, createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

async function detail(db: Db, ctx: TenantContext, row: typeof MR.$inferSelect) {
  const [[building], [unit], photos, events] = await Promise.all([
    db.select({ name: B.name }).from(B).where(and(eq(B.tenantId, ctx.tenantId), eq(B.id, row.buildingId))).limit(1),
    row.unitId
      ? db.select({ label: U.label }).from(U).where(and(eq(U.tenantId, ctx.tenantId), eq(U.id, row.unitId))).limit(1)
      : Promise.resolve([] as { label: string }[]),
    requestPhotos(db, ctx, row.id),
    requestEvents(db, ctx, row.id, true), // owner-visible only (plan addendum 11)
  ]);
  return {
    ...toPortalRow(row, building?.name ?? '', unit?.label ?? null, photos.length),
    description: row.description,
    photos: photos.map((p) => ({ documentId: p.documentId, fileName: p.fileName, mime: p.mime, sizeBytes: p.sizeBytes, createdAt: p.createdAt })),
    events: events.map((e) => ({ id: e.id, kind: e.kind, toStatus: e.toStatus, note: e.note, authorName: e.authorName, authorKind: e.authorKind, createdAt: e.createdAt })),
  };
}

export async function portalMaintenanceList(db: Db, portal: PortalContext, contactIdParam: string) {
  const { ctx, contactId } = resolveLink(portal, contactIdParam);
  const owned = await db.selectDistinct({ buildingId: U.buildingId }).from(U)
    .where(and(eq(U.tenantId, ctx.tenantId), eq(U.ownerContactId, contactId)));
  if (owned.length === 0) return { rows: [] };
  const rows = await db.select({ r: MR, buildingName: B.name, unitLabel: U.label, photoCount: PHOTO_COUNT }).from(MR)
    .innerJoin(B, and(eq(B.id, MR.buildingId), eq(B.tenantId, MR.tenantId)))
    .leftJoin(U, and(eq(U.id, MR.unitId), eq(U.tenantId, MR.tenantId)))
    .where(and(eq(MR.tenantId, ctx.tenantId), eq(MR.reportedByContactId, contactId), inArray(MR.buildingId, owned.map((o) => o.buildingId))))
    .orderBy(desc(MR.createdAt), desc(MR.id));
  return { rows: rows.map((r) => toPortalRow(r.r, r.buildingName, r.unitLabel, r.photoCount)) };
}

export async function portalMaintenanceDetail(db: Db, portal: PortalContext, contactIdParam: string, id: string) {
  const { ctx, contactId } = resolveLink(portal, contactIdParam);
  return detail(db, ctx, await ownedRequest(db, ctx, contactId, id));
}

export async function portalMaintenanceCreate(db: Db, portal: PortalContext, input: {
  contactId: string; buildingId: string; unitId?: string | null | undefined;
  title: string; description: string; category: MaintenanceCategory; priority: MaintenancePriority;
}) {
  const { ctx, contactId } = resolveLink(portal, input.contactId);
  await assertOwnsUnitIn(db, ctx, contactId, input.buildingId); // 404 for anything else
  return db.transaction(async (tx) => {
    if (input.unitId) {
      // Their own unit, in that building: an owner reports on what is theirs.
      const [unit] = await tx.select({ id: U.id }).from(U)
        .where(and(eq(U.tenantId, ctx.tenantId), eq(U.buildingId, input.buildingId), eq(U.id, input.unitId), eq(U.ownerContactId, contactId))).limit(1);
      if (!unit) throw badRequest('invalid_reference', 'unitId is not a unit of yours in this building');
    }
    const [row] = await tx.insert(MR).values({
      tenantId: ctx.tenantId, buildingId: input.buildingId, unitId: input.unitId ?? null,
      title: input.title, description: input.description, category: input.category, priority: input.priority,
      reportedByUserId: null, reportedByContactId: contactId,
    }).returning();
    await recordEvent(tx, ctx, { requestId: row!.id, kind: 'created', toStatus: 'new', note: input.title, visibility: 'owner', authorContactId: contactId });
    await writeAudit(tx, ctx, { action: 'maintenance.portal_create', entityType: 'maintenance_request', entityId: row!.id, after: row });
    return detail(tx, ctx, row!);
  });
}

/** Everything an owner writes is `owner`-visible: they cannot hide a note from themselves (addendum 11). */
export async function portalMaintenanceComment(db: Db, portal: PortalContext, contactIdParam: string, id: string, note: string) {
  const { ctx, contactId } = resolveLink(portal, contactIdParam);
  const row = await ownedRequest(db, ctx, contactId, id);
  return db.transaction(async (tx) => {
    await recordEvent(tx, ctx, { requestId: row.id, kind: 'comment', note, visibility: 'owner', authorContactId: contactId });
    await writeAudit(tx, ctx, { action: 'maintenance.portal_event', entityType: 'maintenance_request', entityId: row.id, after: { note, contactId } });
    return detail(tx, ctx, row);
  });
}

export async function portalMaintenancePhoto(db: Db, portal: PortalContext, store: DocumentStore, contactIdParam: string, id: string, input: Omit<NewPhoto, 'contactId'>) {
  const { ctx, contactId } = resolveLink(portal, contactIdParam);
  const row = await ownedRequest(db, ctx, contactId, id);
  await addPhoto(db, ctx, store, row.id, { ...input, contactId });
  return detail(db, ctx, row);
}

export async function portalMaintenancePhotoFile(db: Db, portal: PortalContext, contactIdParam: string, id: string, documentId: string) {
  const { ctx, contactId } = resolveLink(portal, contactIdParam);
  const row = await ownedRequest(db, ctx, contactId, id);
  return photoFile(db, ctx, row.id, documentId);
}
```

Create `apps/api/src/portal/maintenance-routes.ts`:

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { contentDisposition } from '../documents/store.js';
import { badRequest } from '../errors.js';
import { MAX_PHOTO_BYTES } from '../resources/maintenance/photos.js';
import { idParam } from '../resources/common.js';
import { portalMaintenanceComment, portalMaintenanceCreate, portalMaintenanceDetail, portalMaintenanceList, portalMaintenancePhoto, portalMaintenancePhotoFile } from './maintenance-repo.js';
import { portalContactQuery, portalMaintenanceCreateBody, portalMaintenanceEventBody, portalMaintenanceListOut, portalMaintenanceOut, portalMaintenancePhotoParam } from './schema.js';

/** Spec §8 in the portal. Every route is scoped by the link, by unit ownership and by the reporter. */
export const portalMaintenanceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requirePortal);

  app.get('/maintenance', { schema: { querystring: portalContactQuery, response: { 200: portalMaintenanceListOut } } }, async (req) =>
    portalMaintenanceList(req.db, req.portal!, req.query.contactId));

  app.post('/maintenance', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { body: portalMaintenanceCreateBody, response: { 201: portalMaintenanceOut } },
  }, async (req, reply) => reply.status(201).send(await portalMaintenanceCreate(req.db, req.portal!, req.body)));

  app.get('/maintenance/:id', { schema: { params: idParam, querystring: portalContactQuery, response: { 200: portalMaintenanceOut } } }, async (req) =>
    portalMaintenanceDetail(req.db, req.portal!, req.query.contactId, req.params.id));

  app.post('/maintenance/:id/events', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { params: idParam, body: portalMaintenanceEventBody, response: { 201: portalMaintenanceOut } },
  }, async (req, reply) => reply.status(201).send(await portalMaintenanceComment(req.db, req.portal!, req.body.contactId, req.params.id, req.body.note)));

  // Multipart: `contactId` travels as a field, which busboy only exposes if it precedes the file.
  app.post('/maintenance/:id/photos', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { params: idParam, response: { 201: portalMaintenanceOut } },
  }, async (req, reply) => {
    const part = await req.file({ limits: { fileSize: MAX_PHOTO_BYTES } });
    if (!part) throw badRequest('file_required', 'A file part is required');
    const filename = part.filename ?? '';
    if (!filename) throw badRequest('file_required', 'The file part must carry a filename');
    const fields = part.fields as Record<string, { value?: unknown } | undefined> | undefined;
    const raw = fields?.['contactId'];
    const contactId = typeof raw?.value === 'string' ? raw.value : '';
    if (!/^[0-9a-f-]{36}$/i.test(contactId)) throw badRequest('validation', 'contactId is required and must precede the file part');
    const out = await portalMaintenancePhoto(req.db, req.portal!, app.documents, contactId, req.params.id, {
      title: filename.slice(0, 200), fileName: filename.slice(0, 255), mime: part.mimetype,
      stream: part.file, isTruncated: () => part.file.truncated,
    });
    return reply.status(201).send(out);
  });

  app.get('/maintenance/:id/photos/:documentId', { schema: { params: portalMaintenancePhotoParam, querystring: portalContactQuery } }, async (req, reply) => {
    const row = await portalMaintenancePhotoFile(req.db, req.portal!, req.query.contactId, req.params.id, req.params.documentId);
    const stream = await app.documents.open(row.storageKey);
    return reply
      .type(row.mime)
      .header('content-length', String(row.sizeBytes))
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', contentDisposition(row.fileName, 'inline'))
      .send(stream);
  });
};
```

Append to `apps/api/src/portal/schema.ts` (and add the import of the four enums at the top of the file):

```ts
import { maintenanceCategoryEnum, maintenanceEventKindEnum, maintenancePriorityEnum, maintenanceStatusEnum } from '../resources/maintenance/schema.js';
```

```ts
/** The owner's view of a request: no cost, no fund, no assignee, no visibility flag (addendum 10). */
export const portalMaintenanceRowOut = z.object({
  id: z.string(), buildingId: z.string(), buildingName: z.string(), unitLabel: z.string().nullable(),
  title: z.string(), category: maintenanceCategoryEnum, priority: maintenancePriorityEnum, status: maintenanceStatusEnum,
  photoCount: z.number().int(),
  closedAt: z.date().or(z.string()).nullable(), createdAt: z.date().or(z.string()), updatedAt: z.date().or(z.string()),
});
export const portalMaintenanceOut = portalMaintenanceRowOut.extend({
  description: z.string(),
  photos: z.array(z.object({ documentId: z.string(), fileName: z.string(), mime: z.string(), sizeBytes: z.number().int(), createdAt: z.date().or(z.string()) })),
  events: z.array(z.object({
    id: z.string(), kind: maintenanceEventKindEnum, toStatus: maintenanceStatusEnum.nullable(),
    note: z.string(), authorName: z.string(), authorKind: z.enum(['manager', 'owner', 'system']),
    createdAt: z.date().or(z.string()),
  })),
});
export const portalMaintenanceListOut = z.object({ rows: z.array(portalMaintenanceRowOut) });
export const portalMaintenanceCreateBody = z.object({
  contactId: z.string().uuid(),
  buildingId: z.string().uuid(),
  unitId: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).default(''),
  category: maintenanceCategoryEnum,
  priority: maintenancePriorityEnum.default('normal'),
});
export const portalMaintenanceEventBody = z.object({ contactId: z.string().uuid(), note: z.string().min(1).max(2000) });
export const portalMaintenancePhotoParam = z.object({ id: z.string().uuid(), documentId: z.string().uuid() });
```

In `apps/api/src/app.ts`, add the import beside the other portal imports:

```ts
import { portalMaintenanceRoutes } from './portal/maintenance-routes.js';
```

and the registration after `portalAssemblyRoutes`:

```ts
    await api.register(portalMaintenanceRoutes, { prefix: '/portal' });
```

- [ ] **Step 4: Run tests**

Run: `pnpm db:up && pnpm --filter @domar/api test && pnpm --filter @domar/api typecheck && pnpm lint`
Expected: PASS — 9 new cases in `maintenance-photos.test.ts`, 8 in `portal-maintenance.test.ts`, the 15 of Task 3 still green, and `documents.test.ts` unchanged and green (the upload allowlist is untouched; only the two photo routes pass `allow`).

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): maintenance photos, closing with a cost, and the owner's portal routes" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Web — the manager's Maintenance board

**Files:**
- Create: `apps/web/src/components/building/MaintenanceTab.vue`
- Create: `apps/web/src/components/maintenance/MaintenancePanel.vue`
- Modify: `apps/web/src/pages/BuildingDetailPage.vue`
- Modify: `apps/web/src/api/types.ts`
- Modify: `apps/web/src/i18n/mk.ts`
- Modify: `apps/web/src/i18n/en.ts`
- Create: `apps/web/test/MaintenanceTab.test.ts`

**Interfaces (consumed by Task 7):**
- `data-test` hooks: `tab-maintenance`, `maintenance-title`, `maintenance-description`, `maintenance-category`, `maintenance-priority`, `maintenance-unit`, `maintenance-create`, `maintenance-filter-status`, `maintenance-filter-category`, `maintenance-column-<status>`, `maintenance-count-<status>`, `maintenance-card`, `maintenance-panel`, `maintenance-panel-status`, `maintenance-triage`, `maintenance-reject`, `maintenance-start`, `maintenance-assignee`, `maintenance-supplier`, `maintenance-assign`, `maintenance-close-open`, `maintenance-close-fund`, `maintenance-close-amount`, `maintenance-close-supplier`, `maintenance-close-note`, `maintenance-close-submit`, `maintenance-close-free`, `maintenance-photo-file`, `maintenance-photo-upload`, `maintenance-photo`, `maintenance-photo-delete`, `maintenance-note`, `maintenance-note-visibility`, `maintenance-note-add`, `maintenance-event`, `maintenance-error`
- Types: `MaintenanceStatus`, `MaintenanceCategory`, `MaintenancePriority`, `MaintenanceEventKind`, `MaintenanceVisibility`, `MaintenancePhoto`, `MaintenanceEvent`, `MaintenanceRow`, `MaintenanceRequest`
- i18n: the `maintenance.*` group in both locales

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/MaintenanceTab.test.ts`:

```ts
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MaintenanceRequest, MaintenanceRow, User } from '@/api/types';
import MaintenanceTab from '@/components/building/MaintenanceTab.vue';
import { i18n } from '@/i18n';
import { useAuthStore } from '@/stores/auth';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

const units = { rows: [{ id: 'u1', buildingId: 'b1', label: '1', floor: null, kind: 'apartment', areaM2: 50, ownershipShare: null, ownerContactId: 'c1', attachedToUnitId: null, owner: { id: 'c1', firstName: 'Марко', lastName: 'Марков' } }] };
const users: { rows: User[] } = {
  rows: [
    { id: 'usr-1', email: 'stefan@f.mk', firstName: 'Стефан', lastName: 'Стефановски', role: 'technician', isActive: true },
    { id: 'usr-2', email: 'ro@f.mk', firstName: 'Р', lastName: 'О', role: 'readonly', isActive: true },
  ],
};
const suppliers = { rows: [{ id: 'sup-1', name: 'Водовод Инженеринг ДООЕЛ', companyNumber: null, vatNumber: null, email: null, phone: null, iban: null, notes: null, isActive: true }] };

const row = (over: Partial<MaintenanceRow> = {}): MaintenanceRow => ({
  id: 'mr-1', buildingId: 'b1', unitId: 'u1', unitLabel: '1',
  title: 'Протекува цевка во визбата', category: 'plumbing', priority: 'high', status: 'new',
  reporterName: 'Марко Марков', reporterKind: 'owner',
  assigneeUserId: null, assigneeName: null, supplierId: null, supplierName: null,
  fund: null, costMinor: null, expenseId: null, photoCount: 1,
  closedAt: null, createdAt: '2026-09-25T09:00:00.000Z', updatedAt: '2026-09-25T09:00:00.000Z',
  ...over,
});
const detail = (over: Partial<MaintenanceRequest> = {}): MaintenanceRequest => ({
  ...row(), description: 'Вода тече покрај вертикалата под влезот.',
  photos: [{ documentId: 'doc-1', title: 'voda.png', fileName: 'voda.png', mime: 'image/png', sizeBytes: 1024, uploadedByName: 'Марко Марков', createdAt: '2026-09-25T09:00:00.000Z' }],
  events: [{ id: 'ev-1', kind: 'created', fromStatus: null, toStatus: 'new', note: 'Протекува цевка во визбата', visibility: 'owner', authorName: 'Марко Марков', authorKind: 'owner', createdAt: '2026-09-25T09:00:00.000Z' }],
  ...over,
});

function signIn(role: User['role']) {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  auth.user = { id: 'me', email: 'me@f.mk', firstName: 'И', lastName: 'Т', role, isActive: true };
  return auth;
}

/** units, users, suppliers, board — the four calls every mount makes, in that order. */
const boot = (rows: MaintenanceRow[]) => [json(units), json(users), json(suppliers), json({ rows })];

async function mountTab(responses: Response[], role: User['role'] = 'owner') {
  signIn(role);
  const fetchMock = vi.fn();
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fetchMock);
  const w = mount(MaintenanceTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
  await vi.waitFor(() => expect(w.find('[data-test=maintenance-create]').exists() || w.find('[data-test=maintenance-column-new]').exists()).toBe(true));
  await flushPromises();
  return { w, fetchMock };
}

describe('MaintenanceTab', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('draws one column per status and counts the cards', async () => {
    const { w } = await mountTab(boot([row(), row({ id: 'mr-2', status: 'done', title: 'Изгорена сијалица', category: 'electrical' })]));
    expect(w.get('[data-test=maintenance-count-new]').text()).toBe('1');
    expect(w.get('[data-test=maintenance-count-done]').text()).toBe('1');
    expect(w.get('[data-test=maintenance-count-assigned]').text()).toBe('0');
    expect(w.findAll('[data-test=maintenance-card]')).toHaveLength(2);
    expect(w.get('[data-test=maintenance-column-new]').text()).toContain('Протекува цевка во визбата');
    expect(w.get('[data-test=maintenance-column-new]').text()).toContain('Водовод');
  });

  it('creates a request with the typed values', async () => {
    const { w, fetchMock } = await mountTab([...boot([]), json(detail()), json({ rows: [row()] })]);
    await w.get('[data-test=maintenance-title]').setValue('Протекува цевка во визбата');
    await w.get('[data-test=maintenance-description]').setValue('Вода тече покрај вертикалата под влезот.');
    await w.get('[data-test=maintenance-category]').setValue('plumbing');
    await w.get('[data-test=maintenance-priority]').setValue('high');
    await w.get('[data-test=maintenance-unit]').setValue('u1');
    await w.get('[data-test=maintenance-create]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));

    const post = fetchMock.mock.calls[4]!;
    expect(String(post[0])).toBe('http://localhost:3001/api/buildings/b1/maintenance');
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({
      title: 'Протекува цевка во визбата', description: 'Вода тече покрај вертикалата под влезот.',
      category: 'plumbing', priority: 'high', unitId: 'u1',
    });
  });

  it('opens a card and shows its feed, its photo and its description', async () => {
    const { w, fetchMock } = await mountTab([...boot([row()]), json(detail())]);
    await w.get('[data-test=maintenance-card]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=maintenance-panel]').exists()).toBe(true));
    expect(String(fetchMock.mock.calls[4]![0])).toBe('http://localhost:3001/api/maintenance-requests/mr-1');
    expect(w.get('[data-test=maintenance-panel]').text()).toContain('Вода тече покрај вертикалата под влезот.');
    expect(w.get('[data-test=maintenance-panel-status]').text()).toBe('Ново');
    expect(w.findAll('[data-test=maintenance-event]')).toHaveLength(1);
    const photo = w.get('[data-test=maintenance-photo]');
    expect(photo.attributes('href')).toBe('http://localhost:3001/api/documents/doc-1/download');
  });

  it('triages and assigns from the panel', async () => {
    const triaged = detail({ status: 'triaged' });
    const assigned = detail({ status: 'assigned', assigneeUserId: 'usr-1', assigneeName: 'Стефан Стефановски', supplierId: 'sup-1', supplierName: 'Водовод Инженеринг ДООЕЛ' });
    const { w, fetchMock } = await mountTab([
      ...boot([row()]), json(detail()),
      json(triaged), json({ rows: [row({ status: 'triaged' })] }),
      json(assigned), json({ rows: [row({ status: 'assigned' })] }),
    ]);
    await w.get('[data-test=maintenance-card]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=maintenance-triage]').exists()).toBe(true));
    await w.get('[data-test=maintenance-triage]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));

    const status = fetchMock.mock.calls[5]!;
    expect(String(status[0])).toBe('http://localhost:3001/api/maintenance-requests/mr-1/status');
    expect(JSON.parse(String((status[1] as RequestInit).body))).toEqual({ status: 'triaged' });

    // Only assignable roles are offered: `readonly` is not in the list.
    const options = w.get('[data-test=maintenance-assignee]').findAll('option').map((o) => o.attributes('value'));
    expect(options).toEqual(['', 'usr-1']);
    await w.get('[data-test=maintenance-assignee]').setValue('usr-1');
    await w.get('[data-test=maintenance-supplier]').setValue('sup-1');
    await w.get('[data-test=maintenance-assign]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(9));
    const assign = fetchMock.mock.calls[7]!;
    expect(String(assign[0])).toBe('http://localhost:3001/api/maintenance-requests/mr-1/assign');
    expect(JSON.parse(String((assign[1] as RequestInit).body))).toEqual({ assigneeUserId: 'usr-1', supplierId: 'sup-1' });
  });

  it('closes with a cost, sending the typed amount as minor units', async () => {
    const started = detail({ status: 'in_progress', assigneeUserId: 'usr-1', assigneeName: 'Стефан Стефановски' });
    const closed = detail({ status: 'done', costMinor: 1_200_000, fund: 'reserve', expenseId: 'exp-1', closedAt: '2026-09-25T12:00:00.000Z' });
    const { w, fetchMock } = await mountTab([
      ...boot([row({ status: 'in_progress' })]), json(started),
      json(closed), json({ rows: [row({ status: 'done' })] }),
    ]);
    await w.get('[data-test=maintenance-card]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=maintenance-close-open]').exists()).toBe(true));
    await w.get('[data-test=maintenance-close-open]').trigger('click');
    await w.get('[data-test=maintenance-close-fund]').setValue('reserve');
    await w.get('[data-test=maintenance-close-amount]').setValue('12.000,00');
    await w.get('[data-test=maintenance-close-supplier]').setValue('sup-1');
    await w.get('[data-test=maintenance-close-note]').setValue('Заменета спојка.');
    await w.get('[data-test=maintenance-close-submit]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));

    const close = fetchMock.mock.calls[5]!;
    expect(String(close[0])).toBe('http://localhost:3001/api/maintenance-requests/mr-1/status');
    expect(JSON.parse(String((close[1] as RequestInit).body))).toEqual({
      status: 'done', note: 'Заменета спојка.', visibility: 'owner',
      cost: { fund: 'reserve', costMinor: 1_200_000, supplierId: 'sup-1' },
    });
  });

  it('refuses to send a close whose amount is not an amount', async () => {
    const started = detail({ status: 'in_progress' });
    const { w, fetchMock } = await mountTab([...boot([row({ status: 'in_progress' })]), json(started)]);
    await w.get('[data-test=maintenance-card]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=maintenance-close-open]').exists()).toBe(true));
    await w.get('[data-test=maintenance-close-open]').trigger('click');
    await w.get('[data-test=maintenance-close-amount]').setValue('дванаесет илјади');
    await w.get('[data-test=maintenance-close-submit]').trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(5); // nothing was sent
    expect(w.get('[data-test=maintenance-error]').text()).toBe('Проверете ги внесените податоци.');
  });

  it('closes without a cost through its own button', async () => {
    const started = detail({ status: 'in_progress' });
    const { w, fetchMock } = await mountTab([
      ...boot([row({ status: 'in_progress' })]), json(started),
      json(detail({ status: 'done' })), json({ rows: [row({ status: 'done' })] }),
    ]);
    await w.get('[data-test=maintenance-card]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=maintenance-close-free]').exists()).toBe(true));
    await w.get('[data-test=maintenance-close-free]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));
    expect(JSON.parse(String((fetchMock.mock.calls[5]![1] as RequestInit).body))).toEqual({ status: 'done', cost: null });
  });

  it('shows a technician only the buttons they may press', async () => {
    const assigned = detail({ status: 'assigned', assigneeUserId: 'usr-1', assigneeName: 'Стефан Стефановски' });
    const { w } = await mountTab([...boot([row({ status: 'assigned' })]), json(assigned)], 'technician');
    await w.get('[data-test=maintenance-card]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=maintenance-panel]').exists()).toBe(true));
    expect(w.find('[data-test=maintenance-start]').exists()).toBe(true);
    expect(w.find('[data-test=maintenance-close-free]').exists()).toBe(true);
    expect(w.find('[data-test=maintenance-note-add]').exists()).toBe(true);
    expect(w.find('[data-test=maintenance-photo-upload]').exists()).toBe(true);
    // The three that book money or hand out work are not rendered at all.
    expect(w.find('[data-test=maintenance-close-open]').exists()).toBe(false);
    expect(w.find('[data-test=maintenance-assign]').exists()).toBe(false);
    expect(w.find('[data-test=maintenance-triage]').exists()).toBe(false);
    expect(w.find('[data-test=maintenance-create]').exists()).toBe(false);
  });

  it('adds an owner-visible note', async () => {
    const { w, fetchMock } = await mountTab([
      ...boot([row()]), json(detail()),
      json(detail()), json({ rows: [row()] }),
    ]);
    await w.get('[data-test=maintenance-card]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=maintenance-note]').exists()).toBe(true));
    await w.get('[data-test=maintenance-note]').setValue('Мајсторот доаѓа утре во 9.');
    await w.get('[data-test=maintenance-note-visibility]').setValue('owner');
    await w.get('[data-test=maintenance-note-add]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));
    const post = fetchMock.mock.calls[5]!;
    expect(String(post[0])).toBe('http://localhost:3001/api/maintenance-requests/mr-1/events');
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ note: 'Мајсторот доаѓа утре во 9.', visibility: 'owner' });
  });

  it('filters the board through the query string', async () => {
    const { w, fetchMock } = await mountTab([...boot([row()]), json({ rows: [] })]);
    await w.get('[data-test=maintenance-filter-status]').setValue('done');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(String(fetchMock.mock.calls[4]![0])).toBe('http://localhost:3001/api/buildings/b1/maintenance?status=done');
  });

  it('turns a 409 from the server into the Macedonian sentence for it', async () => {
    const { w } = await mountTab([
      ...boot([row()]), json(detail()),
      json({ error: { code: 'status_locked', message: 'x' } }, 409),
    ]);
    await w.get('[data-test=maintenance-card]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=maintenance-triage]').exists()).toBe(true));
    await w.get('[data-test=maintenance-triage]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=maintenance-error]').exists()).toBe(true));
    expect(w.get('[data-test=maintenance-error]').text()).toBe('Статусот веќе е променет од некој друг. Освежете ја страницата.');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @domar/web test MaintenanceTab`
Expected: FAIL — `Failed to resolve import "@/components/building/MaintenanceTab.vue"`.

- [ ] **Step 3: Implement**

Append to `apps/web/src/api/types.ts`:

```ts
export type MaintenanceStatus = 'new' | 'triaged' | 'assigned' | 'in_progress' | 'done' | 'rejected';
export type MaintenanceCategory = 'plumbing' | 'electrical' | 'lift' | 'heating' | 'cleaning' | 'common_area' | 'other';
export type MaintenancePriority = 'low' | 'normal' | 'high' | 'urgent';
export type MaintenanceEventKind = 'created' | 'status_changed' | 'assigned' | 'comment' | 'photo_added';
export type MaintenanceVisibility = 'internal' | 'owner';
export interface MaintenancePhoto {
  documentId: string; title: string; fileName: string; mime: string; sizeBytes: number; uploadedByName: string; createdAt: string;
}
export interface MaintenanceEvent {
  id: string; kind: MaintenanceEventKind; fromStatus: MaintenanceStatus | null; toStatus: MaintenanceStatus | null;
  note: string; visibility: MaintenanceVisibility; authorName: string; authorKind: 'manager' | 'owner' | 'system'; createdAt: string;
}
export interface MaintenanceRow {
  id: string; buildingId: string; unitId: string | null; unitLabel: string | null;
  title: string; category: MaintenanceCategory; priority: MaintenancePriority; status: MaintenanceStatus;
  reporterName: string; reporterKind: 'manager' | 'owner';
  assigneeUserId: string | null; assigneeName: string | null; supplierId: string | null; supplierName: string | null;
  fund: Fund | null; costMinor: number | null; expenseId: string | null; photoCount: number;
  closedAt: string | null; createdAt: string; updatedAt: string;
}
export interface MaintenanceRequest extends MaintenanceRow {
  description: string; photos: MaintenancePhoto[]; events: MaintenanceEvent[];
}
export interface PortalMaintenancePhoto { documentId: string; fileName: string; mime: string; sizeBytes: number; createdAt: string }
export interface PortalMaintenanceEvent {
  id: string; kind: MaintenanceEventKind; toStatus: MaintenanceStatus | null; note: string;
  authorName: string; authorKind: 'manager' | 'owner' | 'system'; createdAt: string;
}
export interface PortalMaintenanceRow {
  id: string; buildingId: string; buildingName: string; unitLabel: string | null;
  title: string; category: MaintenanceCategory; priority: MaintenancePriority; status: MaintenanceStatus;
  photoCount: number; closedAt: string | null; createdAt: string; updatedAt: string;
}
export interface PortalMaintenanceRequest extends PortalMaintenanceRow {
  description: string; photos: PortalMaintenancePhoto[]; events: PortalMaintenanceEvent[];
}
```

Create `apps/web/src/components/maintenance/MaintenancePanel.vue`:

```vue
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, API_BASE } from '@/api/client';
import type { Fund, MaintenanceRequest, MaintenanceVisibility, Supplier, User } from '@/api/types';
import ModalDialog from '@/components/ModalDialog.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { formatMoney, toMinor } from '@/utils/money';

const props = defineProps<{ request: MaintenanceRequest; users: User[]; suppliers: Supplier[]; canWrite: boolean }>();
const emit = defineEmits<{ (e: 'updated', request: MaintenanceRequest): void; (e: 'error', message: string): void }>();
const { t, te } = useI18n();

const assign = ref({ assigneeUserId: '', supplierId: '' });
const closing = ref(false);
const close = ref({ fund: 'reserve' as Fund, amount: '', supplierId: '', note: '' });
const note = ref({ text: '', visibility: 'internal' as MaintenanceVisibility });
const file = ref<File | null>(null);
const busy = ref('');

const status = computed(() => props.request.status);
const open = computed(() => status.value !== 'done' && status.value !== 'rejected');
const mayTriage = computed(() => props.canWrite && status.value === 'new');
const mayReject = computed(() => props.canWrite && (status.value === 'new' || status.value === 'triaged'));
const mayAssign = computed(() => props.canWrite && open.value);
const mayStart = computed(() => status.value === 'assigned');
const mayClose = computed(() => status.value === 'assigned' || status.value === 'in_progress');
const downloadUrl = (id: string) => `${API_BASE}/api/documents/${id}/download`;
const dateTime = (iso: string) => new Date(iso).toLocaleString('mk-MK', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function fail(e: unknown) {
  const code = (e as { code?: string }).code ?? 'generic';
  emit('error', te(`maintenance.errors.${code}`) ? t(`maintenance.errors.${code}`) : t('app.error'));
}

async function send(label: string, run: () => Promise<MaintenanceRequest>) {
  busy.value = label;
  try { emit('updated', await run()); } catch (e) { fail(e); } finally { busy.value = ''; }
}

const setStatus = (body: Record<string, unknown>, label: string) =>
  send(label, () => api.post<MaintenanceRequest>(`/api/maintenance-requests/${props.request.id}/status`, body));

function submitAssign() {
  if (!assign.value.assigneeUserId) { emit('error', t('maintenance.errors.validation')); return; }
  void send('assign', () => api.post<MaintenanceRequest>(`/api/maintenance-requests/${props.request.id}/assign`, {
    assigneeUserId: assign.value.assigneeUserId,
    supplierId: assign.value.supplierId || null,
  }));
}

function submitClose() {
  const costMinor = toMinor(close.value.amount);
  // An unparsed amount would silently become a zero and book a 0,00 den expense on the fund.
  if (costMinor === null || costMinor <= 0) { emit('error', t('maintenance.errors.validation')); return; }
  closing.value = false;
  void setStatus({
    status: 'done', note: close.value.note.trim() || undefined, visibility: 'owner',
    cost: { fund: close.value.fund, costMinor, ...(close.value.supplierId ? { supplierId: close.value.supplierId } : {}) },
  }, 'close');
}

function submitNote() {
  if (!note.value.text.trim()) { emit('error', t('maintenance.errors.validation')); return; }
  const body = { note: note.value.text.trim(), visibility: note.value.visibility };
  note.value = { text: '', visibility: 'internal' };
  void send('note', () => api.post<MaintenanceRequest>(`/api/maintenance-requests/${props.request.id}/events`, body));
}

function onFile(e: Event) { file.value = (e.target as HTMLInputElement).files?.[0] ?? null; }

function uploadPhoto() {
  if (!file.value) { emit('error', t('maintenance.errors.file_required')); return; }
  const fd = new FormData();
  // Order matters: busboy only exposes the fields that precede the file part.
  fd.append('title', file.value.name);
  fd.append('file', file.value, file.value.name);
  file.value = null;
  void send('photo', () => api.upload<MaintenanceRequest>(`/api/maintenance-requests/${props.request.id}/photos`, fd));
}

async function removePhoto(documentId: string) {
  if (!window.confirm(t('app.confirmDelete'))) return;
  busy.value = documentId;
  try {
    await api.del(`/api/maintenance-requests/${props.request.id}/photos/${documentId}`);
    emit('updated', await api.get<MaintenanceRequest>(`/api/maintenance-requests/${props.request.id}`));
  } catch (e) { fail(e); } finally { busy.value = ''; }
}
</script>
<template>
  <section class="rounded-xl bg-white p-4 shadow-sm" data-test="maintenance-panel">
    <div class="mb-1 flex flex-wrap items-center gap-2">
      <h3 class="text-lg font-semibold">{{ request.title }}</h3>
      <span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs" data-test="maintenance-panel-status">{{ t(`maintenance.statuses.${request.status}`) }}</span>
      <span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{{ t(`maintenance.categories.${request.category}`) }}</span>
      <span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{{ t(`maintenance.priorities.${request.priority}`) }}</span>
    </div>
    <p class="mb-3 whitespace-pre-line text-sm text-slate-700">{{ request.description }}</p>
    <dl class="mb-4 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
      <div><dt class="text-slate-500">{{ t('maintenance.reporter') }}</dt><dd>{{ request.reporterName }}</dd></div>
      <div><dt class="text-slate-500">{{ t('maintenance.unit') }}</dt><dd>{{ request.unitLabel ?? t('maintenance.noUnit') }}</dd></div>
      <div><dt class="text-slate-500">{{ t('maintenance.assignee') }}</dt><dd>{{ request.assigneeName ?? '—' }}</dd></div>
      <div><dt class="text-slate-500">{{ t('maintenance.supplier') }}</dt><dd>{{ request.supplierName ?? '—' }}</dd></div>
      <div v-if="request.costMinor !== null"><dt class="text-slate-500">{{ t('maintenance.cost') }}</dt>
        <dd data-test="maintenance-panel-cost">{{ formatMoney(request.costMinor) }} · {{ t(`maintenance.funds.${request.fund}`) }}</dd></div>
      <div v-if="request.closedAt"><dt class="text-slate-500">{{ t('maintenance.closedAt') }}</dt><dd>{{ dateTime(request.closedAt) }}</dd></div>
    </dl>

    <div class="mb-4 flex flex-wrap gap-2">
      <AppButton v-if="mayTriage" :loading="busy === 'triage'" data-test="maintenance-triage" @click="setStatus({ status: 'triaged' }, 'triage')">{{ t('maintenance.triage') }}</AppButton>
      <AppButton v-if="mayReject" variant="danger" :loading="busy === 'reject'" data-test="maintenance-reject" @click="setStatus({ status: 'rejected' }, 'reject')">{{ t('maintenance.reject') }}</AppButton>
      <AppButton v-if="mayStart" :loading="busy === 'start'" data-test="maintenance-start" @click="setStatus({ status: 'in_progress' }, 'start')">{{ t('maintenance.start') }}</AppButton>
      <AppButton v-if="mayClose" variant="secondary" :loading="busy === 'free'" data-test="maintenance-close-free" @click="setStatus({ status: 'done', cost: null }, 'free')">{{ t('maintenance.closeWithoutCost') }}</AppButton>
      <AppButton v-if="mayClose && canWrite" data-test="maintenance-close-open" @click="closing = true">{{ t('maintenance.closeWithCost') }}</AppButton>
    </div>

    <form v-if="mayAssign" class="mb-4 grid grid-cols-3 items-end gap-3" @submit.prevent="submitAssign">
      <AppSelect v-model="assign.assigneeUserId" :label="t('maintenance.assignee')" data-test="maintenance-assignee"
        :options="[{ value: '', label: t('maintenance.pickAssignee') }, ...users.map((u) => ({ value: u.id, label: `${u.firstName} ${u.lastName}` }))]" />
      <AppSelect v-model="assign.supplierId" :label="t('maintenance.supplier')" data-test="maintenance-supplier"
        :options="[{ value: '', label: t('maintenance.noSupplier') }, ...suppliers.map((s) => ({ value: s.id, label: s.name }))]" />
      <AppButton type="button" :loading="busy === 'assign'" data-test="maintenance-assign" @click="submitAssign">{{ t('maintenance.assign') }}</AppButton>
    </form>

    <section class="mb-4">
      <h4 class="mb-2 font-medium">{{ t('maintenance.photos') }}</h4>
      <div class="mb-2 flex flex-wrap gap-3">
        <div v-for="p in request.photos" :key="p.documentId" class="text-xs">
          <a :href="downloadUrl(p.documentId)" target="_blank" rel="noopener" class="text-emerald-700 underline" data-test="maintenance-photo">{{ p.fileName }}</a>
          <span class="ml-1 text-slate-500">{{ p.uploadedByName }}</span>
          <button v-if="canWrite" class="ml-2 text-red-600 underline" data-test="maintenance-photo-delete" @click="removePhoto(p.documentId)">{{ t('app.delete') }}</button>
        </div>
        <p v-if="request.photos.length === 0" class="text-sm text-slate-500">{{ t('app.empty') }}</p>
      </div>
      <div v-if="open" class="flex items-end gap-3">
        <label class="block text-sm"><span class="mb-1 block font-medium text-slate-700">{{ t('maintenance.file') }}</span>
          <input type="file" class="text-sm" accept="image/png,image/jpeg" data-test="maintenance-photo-file" @change="onFile" /></label>
        <AppButton type="button" :loading="busy === 'photo'" data-test="maintenance-photo-upload" @click="uploadPhoto">{{ t('maintenance.upload') }}</AppButton>
      </div>
    </section>

    <section>
      <h4 class="mb-2 font-medium">{{ t('maintenance.events') }}</h4>
      <ol class="mb-3 space-y-2 text-sm">
        <li v-for="e in request.events" :key="e.id" class="rounded-lg bg-slate-50 p-2" data-test="maintenance-event">
          <span class="font-medium">{{ t(`maintenance.eventKinds.${e.kind}`) }}</span>
          <span v-if="e.toStatus" class="text-slate-600"> → {{ t(`maintenance.statuses.${e.toStatus}`) }}</span>
          <span class="ml-2 text-xs text-slate-500">{{ e.authorName }} · {{ dateTime(e.createdAt) }} · {{ t(`maintenance.visibilities.${e.visibility}`) }}</span>
          <p v-if="e.note" class="whitespace-pre-line">{{ e.note }}</p>
        </li>
      </ol>
      <form v-if="open" class="grid grid-cols-3 items-end gap-3" @submit.prevent="submitNote">
        <AppInput v-model="note.text" :label="t('maintenance.note')" data-test="maintenance-note" />
        <AppSelect v-model="note.visibility" :label="t('maintenance.visibility')" data-test="maintenance-note-visibility"
          :options="[{ value: 'internal', label: t('maintenance.visibilities.internal') }, { value: 'owner', label: t('maintenance.visibilities.owner') }]" />
        <AppButton type="button" :loading="busy === 'note'" data-test="maintenance-note-add" @click="submitNote">{{ t('maintenance.addNote') }}</AppButton>
      </form>
    </section>

    <ModalDialog :open="closing" :title="t('maintenance.closeWithCost')" @close="closing = false">
      <form class="space-y-3" @submit.prevent="submitClose">
        <AppSelect v-model="close.fund" :label="t('maintenance.fund')" data-test="maintenance-close-fund"
          :options="[{ value: 'reserve', label: t('maintenance.funds.reserve') }, { value: 'regular', label: t('maintenance.funds.regular') }]" />
        <AppInput v-model="close.amount" :label="t('maintenance.cost')" placeholder="0,00" data-test="maintenance-close-amount" />
        <AppSelect v-model="close.supplierId" :label="t('maintenance.supplier')" data-test="maintenance-close-supplier"
          :options="[{ value: '', label: t('maintenance.noSupplier') }, ...suppliers.map((s) => ({ value: s.id, label: s.name }))]" />
        <AppInput v-model="close.note" :label="t('maintenance.note')" data-test="maintenance-close-note" />
        <AppButton type="button" :loading="busy === 'close'" data-test="maintenance-close-submit" @click="submitClose">{{ t('maintenance.close') }}</AppButton>
      </form>
    </ModalDialog>
  </section>
</template>
```

Create `apps/web/src/components/building/MaintenanceTab.vue`:

```vue
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { MaintenanceCategory, MaintenancePriority, MaintenanceRequest, MaintenanceRow, MaintenanceStatus, Supplier, Unit, User } from '@/api/types';
import MaintenancePanel from '@/components/maintenance/MaintenancePanel.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { useAuthStore } from '@/stores/auth';

const props = defineProps<{ buildingId: string }>();
const { t, te } = useI18n();
const auth = useAuthStore();

/** The board's columns, in the order the domain declares the statuses. */
const STATUSES: MaintenanceStatus[] = ['new', 'triaged', 'assigned', 'in_progress', 'done', 'rejected'];
const CATEGORIES: MaintenanceCategory[] = ['plumbing', 'electrical', 'lift', 'heating', 'cleaning', 'common_area', 'other'];
const PRIORITIES: MaintenancePriority[] = ['low', 'normal', 'high', 'urgent'];
/** Spec §8: a request is given to a person who can work it, never to a readonly account. */
const ASSIGNABLE: User['role'][] = ['owner', 'accountant', 'technician'];

const rows = ref<MaintenanceRow[]>([]);
const units = ref<Unit[]>([]);
const users = ref<User[]>([]);
const suppliers = ref<Supplier[]>([]);
const selected = ref<MaintenanceRequest | null>(null);
const filter = ref({ status: '', category: '' });
const blank = () => ({ title: '', description: '', category: 'other' as MaintenanceCategory, priority: 'normal' as MaintenancePriority, unitId: '' });
const form = ref(blank());
const error = ref('');
const saving = ref(false);
const loaded = ref(false);

const canWrite = computed(() => auth.user?.role === 'owner' || auth.user?.role === 'accountant');
const columnRows = (s: MaintenanceStatus) => rows.value.filter((r) => r.status === s);
const message = (e: unknown) => {
  const code = (e as { code?: string }).code ?? 'generic';
  return te(`maintenance.errors.${code}`) ? t(`maintenance.errors.${code}`) : t('app.error');
};

async function load() {
  const q: Record<string, string> = {};
  if (filter.value.status) q.status = filter.value.status;
  if (filter.value.category) q.category = filter.value.category;
  rows.value = (await api.get<{ rows: MaintenanceRow[] }>(`/api/buildings/${props.buildingId}/maintenance`, q)).rows;
}

onMounted(async () => {
  try {
    // Three independent reads, fired together; the board follows because it is the one that can fail
    // on a filter the user has not set yet.
    const [u, us, sup] = await Promise.all([
      api.get<{ rows: Unit[] }>(`/api/buildings/${props.buildingId}/units`),
      api.get<{ rows: User[] }>('/api/users'),
      api.get<{ rows: Supplier[] }>('/api/suppliers'),
    ]);
    units.value = u.rows;
    users.value = us.rows.filter((x) => x.isActive && ASSIGNABLE.includes(x.role));
    suppliers.value = sup.rows;
    await load();
  } catch (e) { error.value = message(e); } finally { loaded.value = true; }
});
// A watcher, not `@change`: AppSelect emits no change event of its own.
watch(filter, () => { void load().catch((e) => { error.value = message(e); }); }, { deep: true });

async function openCard(id: string) {
  error.value = '';
  try { selected.value = await api.get<MaintenanceRequest>(`/api/maintenance-requests/${id}`); }
  catch (e) { error.value = message(e); }
}

async function create() {
  error.value = '';
  if (!form.value.title.trim()) { error.value = t('maintenance.errors.validation'); return; }
  saving.value = true;
  try {
    const created = await api.post<MaintenanceRequest>(`/api/buildings/${props.buildingId}/maintenance`, {
      title: form.value.title.trim(),
      description: form.value.description.trim(),
      category: form.value.category,
      priority: form.value.priority,
      unitId: form.value.unitId || null,
    });
    form.value = blank();
    selected.value = created;
    await load();
  } catch (e) { error.value = message(e); } finally { saving.value = false; }
}

async function onUpdated(request: MaintenanceRequest) {
  selected.value = request;
  error.value = '';
  try { await load(); } catch (e) { error.value = message(e); }
}
</script>
<template>
  <div v-if="loaded" class="space-y-4">
    <form v-if="canWrite" class="grid grid-cols-5 items-end gap-3 rounded-xl bg-white p-4 shadow-sm" @submit.prevent="create">
      <AppInput v-model="form.title" :label="t('maintenance.requestTitle')" data-test="maintenance-title" />
      <AppInput v-model="form.description" :label="t('maintenance.description')" data-test="maintenance-description" />
      <AppSelect v-model="form.category" :label="t('maintenance.category')" data-test="maintenance-category"
        :options="CATEGORIES.map((c) => ({ value: c, label: t(`maintenance.categories.${c}`) }))" />
      <AppSelect v-model="form.priority" :label="t('maintenance.priority')" data-test="maintenance-priority"
        :options="PRIORITIES.map((p) => ({ value: p, label: t(`maintenance.priorities.${p}`) }))" />
      <div class="flex items-end gap-3">
        <AppSelect v-model="form.unitId" :label="t('maintenance.unit')" data-test="maintenance-unit"
          :options="[{ value: '', label: t('maintenance.noUnit') }, ...units.map((u) => ({ value: u.id, label: u.label }))]" />
        <AppButton type="button" :loading="saving" data-test="maintenance-create" @click="create">{{ t('maintenance.add') }}</AppButton>
      </div>
    </form>

    <div class="flex gap-3">
      <AppSelect v-model="filter.status" :label="t('maintenance.filterStatus')" data-test="maintenance-filter-status"
        :options="[{ value: '', label: t('maintenance.all') }, ...STATUSES.map((s) => ({ value: s, label: t(`maintenance.statuses.${s}`) }))]" />
      <AppSelect v-model="filter.category" :label="t('maintenance.filterCategory')" data-test="maintenance-filter-category"
        :options="[{ value: '', label: t('maintenance.all') }, ...CATEGORIES.map((c) => ({ value: c, label: t(`maintenance.categories.${c}`) }))]" />
    </div>

    <p v-if="error" class="text-sm text-red-600" data-test="maintenance-error">{{ error }}</p>

    <!-- A board of buttons, never drag-and-drop: every move is an explicit, audited transition. -->
    <div class="grid grid-cols-2 gap-3 md:grid-cols-6">
      <section v-for="s in STATUSES" :key="s" class="rounded-xl bg-slate-100 p-2" :data-test="`maintenance-column-${s}`">
        <h3 class="mb-2 flex items-center justify-between text-sm font-semibold">
          {{ t(`maintenance.statuses.${s}`) }}
          <span class="rounded-full bg-white px-2 text-xs" :data-test="`maintenance-count-${s}`">{{ columnRows(s).length }}</span>
        </h3>
        <button v-for="r in columnRows(s)" :key="r.id" type="button" data-test="maintenance-card"
          class="mb-2 block w-full rounded-lg bg-white p-2 text-left text-sm shadow-sm hover:ring-2 hover:ring-emerald-400"
          :class="selected?.id === r.id ? 'ring-2 ring-emerald-500' : ''" @click="openCard(r.id)">
          <span class="block font-medium">{{ r.title }}</span>
          <span class="block text-xs text-slate-500">
            {{ t(`maintenance.categories.${r.category}`) }} · {{ t(`maintenance.priorities.${r.priority}`) }}
            <template v-if="r.unitLabel"> · {{ r.unitLabel }}</template>
            <template v-if="r.photoCount > 0"> · {{ r.photoCount }} 📷</template>
          </span>
          <span class="block text-xs text-slate-500">{{ r.assigneeName ?? r.reporterName }}</span>
        </button>
      </section>
    </div>

    <MaintenancePanel v-if="selected" :key="selected.id" :request="selected" :users="users" :suppliers="suppliers" :can-write="canWrite"
      @updated="onUpdated" @error="(m) => (error = m)" />
  </div>
  <p v-else>{{ t('app.loading') }}</p>
</template>
```

In `apps/web/src/pages/BuildingDetailPage.vue`, make four edits:

```ts
import MaintenanceTab from '@/components/building/MaintenanceTab.vue';
```

```ts
const tabs = ['compliance', 'units', 'services', 'reserve-fund', 'opening-balances', 'periods', 'statements', 'reminders', 'assemblies', 'maintenance', 'reports', 'documents', 'contracts', 'extraordinary', 'import'] as const;
```

add `maintenance: t('maintenance.title'),` to the `tabLabel` map (between `assemblies` and `reports`), and add the render line between `<AssembliesTab …/>` and `<ReportsTab …/>`:

```html
    <MaintenanceTab v-else-if="tab === 'maintenance'" :building-id="id" />
```

Add the `maintenance` group to `apps/web/src/i18n/mk.ts`, after the `assemblies` group:

```ts
  maintenance: {
    title: 'Одржување', add: 'Ново барање', requestTitle: 'Наслов', description: 'Опис',
    category: 'Категорија', priority: 'Приоритет', unit: 'Единица', noUnit: '— заедничка просторија —',
    reporter: 'Пријавил', assignee: 'Задолжен', pickAssignee: '— изберете —', supplier: 'Добавувач', noSupplier: '— без добавувач —',
    cost: 'Трошок', fund: 'Фонд', closedAt: 'Затворено', photos: 'Фотографии', file: 'Фотографија', upload: 'Качи',
    events: 'Дневник', note: 'Белешка', addNote: 'Додади белешка', visibility: 'Видливост',
    filterStatus: 'Статус', filterCategory: 'Категорија', all: 'Сите',
    triage: 'Прими', reject: 'Одбиј', assign: 'Додели', start: 'Започни', close: 'Затвори',
    closeWithCost: 'Затвори со трошок', closeWithoutCost: 'Затвори без трошок',
    statuses: { new: 'Ново', triaged: 'Примено', assigned: 'Доделено', in_progress: 'Во тек', done: 'Завршено', rejected: 'Одбиено' },
    priorities: { low: 'Низок', normal: 'Нормален', high: 'Висок', urgent: 'Итен' },
    categories: { plumbing: 'Водовод', electrical: 'Електрика', lift: 'Лифт', heating: 'Греење', cleaning: 'Чистење', common_area: 'Заеднички простории', other: 'Друго' },
    visibilities: { internal: 'Интерна', owner: 'Видлива за сопственикот' },
    funds: { regular: 'Редовен фонд', reserve: 'Резервен фонд' },
    eventKinds: { created: 'Пријавено', status_changed: 'Променет статус', assigned: 'Доделено', comment: 'Белешка', photo_added: 'Додадена фотографија' },
    errors: {
      status_locked: 'Статусот веќе е променет од некој друг. Освежете ја страницата.',
      cost_decision_required: 'Изберете дали затворањето носи трошок или не.',
      cost_requires_write_role: 'Само управител или сметководител може да затвори барање со трошок.',
      too_many_photos: 'Барањето има максимален број фотографии.',
      unsupported_media_type: 'Дозволени се само слики (PNG или JPEG).',
      file_too_large: 'Фотографијата е преголема (најмногу 8 MB).',
      file_required: 'Изберете фотографија.',
      invalid_reference: 'Изберете постоечки корисник, добавувач или единица од оваа зграда.',
      not_found: 'Барањето не е пронајдено.',
      forbidden: 'Немате право за оваа акција.',
      validation: 'Проверете ги внесените податоци.',
    },
  },
```

and the same group, in the same place, to `apps/web/src/i18n/en.ts`:

```ts
  maintenance: {
    title: 'Maintenance', add: 'New request', requestTitle: 'Title', description: 'Description',
    category: 'Category', priority: 'Priority', unit: 'Unit', noUnit: '— common area —',
    reporter: 'Reported by', assignee: 'Assigned to', pickAssignee: '— choose —', supplier: 'Supplier', noSupplier: '— no supplier —',
    cost: 'Cost', fund: 'Fund', closedAt: 'Closed', photos: 'Photos', file: 'Photo', upload: 'Upload',
    events: 'Activity', note: 'Note', addNote: 'Add note', visibility: 'Visibility',
    filterStatus: 'Status', filterCategory: 'Category', all: 'All',
    triage: 'Accept', reject: 'Reject', assign: 'Assign', start: 'Start', close: 'Close',
    closeWithCost: 'Close with cost', closeWithoutCost: 'Close without cost',
    statuses: { new: 'New', triaged: 'Accepted', assigned: 'Assigned', in_progress: 'In progress', done: 'Done', rejected: 'Rejected' },
    priorities: { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' },
    categories: { plumbing: 'Plumbing', electrical: 'Electrical', lift: 'Lift', heating: 'Heating', cleaning: 'Cleaning', common_area: 'Common areas', other: 'Other' },
    visibilities: { internal: 'Internal', owner: 'Visible to the owner' },
    funds: { regular: 'Regular fund', reserve: 'Reserve fund' },
    eventKinds: { created: 'Reported', status_changed: 'Status changed', assigned: 'Assigned', comment: 'Note', photo_added: 'Photo added' },
    errors: {
      status_locked: 'Somebody has already changed the status. Refresh the page.',
      cost_decision_required: 'Choose whether closing books a cost or not.',
      cost_requires_write_role: 'Only an owner or an accountant may close a request with a cost.',
      too_many_photos: 'This request already holds the maximum number of photos.',
      unsupported_media_type: 'Only images are accepted (PNG or JPEG).',
      file_too_large: 'The photo is too large (8 MB at most).',
      file_required: 'Choose a photo.',
      invalid_reference: 'Choose an existing user, supplier or unit of this building.',
      not_found: 'The request was not found.',
      forbidden: 'You are not allowed to do this.',
      validation: 'Check the values you entered.',
    },
  },
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @domar/web test && pnpm --filter @domar/web typecheck && pnpm lint`
Expected: PASS — 11 new cases in `MaintenanceTab.test.ts` and `LoginPage.test.ts`'s mk/en parity case still green.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): the Maintenance board, its panel and the close-with-cost dialog" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Web — the owner's Maintenance pages in the portal

**Files:**
- Create: `apps/web/src/pages/portal/PortalMaintenancePage.vue`
- Create: `apps/web/src/pages/portal/PortalMaintenanceRequestPage.vue`
- Modify: `apps/web/src/router/index.ts`
- Modify: `apps/web/src/layouts/PortalShell.vue`
- Modify: `apps/web/src/i18n/mk.ts`
- Modify: `apps/web/src/i18n/en.ts`
- Create: `apps/web/test/PortalMaintenance.test.ts`

**Interfaces (consumed by Task 7):**
- Routes `/portal/maintenance` and `/portal/maintenance/:id`
- `data-test` hooks: `portal-nav-maintenance`, `portal-maintenance-building`, `portal-maintenance-title`, `portal-maintenance-description`, `portal-maintenance-category`, `portal-maintenance-priority`, `portal-maintenance-file`, `portal-maintenance-submit`, `portal-maintenance-row`, `portal-maintenance-link`, `portal-maintenance-status`, `portal-maintenance-event`, `portal-maintenance-note`, `portal-maintenance-send`, `portal-maintenance-photo`, `portal-maintenance-photo-file`, `portal-maintenance-add-photo`, `portal-page-error`

**Decision recorded here:** the portal's create form has **no unit picker**. The portal has no route that lists an owner's units, and adding one for a dropdown would be a new surface to keep scoped for a field the description already covers in words. The API's `unitId` stays optional and unused from the portal; a manager who needs the flat asks in the feed.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/PortalMaintenance.test.ts`:

```ts
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PortalMaintenanceRequest, PortalMaintenanceRow } from '@/api/types';
import { i18n } from '@/i18n';
import PortalMaintenancePage from '@/pages/portal/PortalMaintenancePage.vue';
import PortalMaintenanceRequestPage from '@/pages/portal/PortalMaintenanceRequestPage.vue';
import { usePortalStore } from '@/stores/portal';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const me = {
  account: { id: 'a1', email: 'marko@owner.mk' },
  links: [{ tenantId: 't1', tenantName: 'Фирма 1', contactId: 'c1', contactName: 'Марко Марков', buildings: [{ id: 'b1', name: 'Партизанска 12' }] }],
};
const row: PortalMaintenanceRow = {
  id: 'mr-1', buildingId: 'b1', buildingName: 'Партизанска 12', unitLabel: '1',
  title: 'Протекува цевка во визбата', category: 'plumbing', priority: 'high', status: 'in_progress',
  photoCount: 1, closedAt: null, createdAt: '2026-09-25T09:00:00.000Z', updatedAt: '2026-09-25T10:00:00.000Z',
};
const detail: PortalMaintenanceRequest = {
  ...row, description: 'Вода тече покрај вертикалата под влезот.',
  photos: [{ documentId: 'doc-1', fileName: 'voda.png', mime: 'image/png', sizeBytes: 1024, createdAt: '2026-09-25T09:00:00.000Z' }],
  events: [
    { id: 'ev-1', kind: 'created', toStatus: 'new', note: 'Протекува цевка во визбата', authorName: 'Марко Марков', authorKind: 'owner', createdAt: '2026-09-25T09:00:00.000Z' },
    { id: 'ev-2', kind: 'status_changed', toStatus: 'in_progress', note: 'Мајсторот е на пат.', authorName: 'Ива Тест', authorKind: 'manager', createdAt: '2026-09-25T10:00:00.000Z' },
  ],
};

async function primedStore(fetchMock: ReturnType<typeof vi.fn>) {
  setActivePinia(createPinia());
  vi.stubGlobal('fetch', fetchMock);
  const store = usePortalStore();
  await store.fetchMe();
  return store;
}

describe('PortalMaintenancePage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists the owner’s own requests with their status', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(me)).mockResolvedValueOnce(json({ rows: [row] }));
    await primedStore(fetchMock);
    const w = mount(PortalMaintenancePage, { global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await flushPromises();
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/portal/maintenance?contactId=c1');
    expect(w.findAll('[data-test=portal-maintenance-row]')).toHaveLength(1);
    expect(w.get('[data-test=portal-maintenance-status]').text()).toBe('Во тек');
    expect(w.get('[data-test=portal-maintenance-row]').text()).toContain('Протекува цевка во визбата');
  });

  it('reports a problem and then uploads the chosen photo to it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(me))
      .mockResolvedValueOnce(json({ rows: [] }))
      .mockResolvedValueOnce(json(detail))        // POST /portal/maintenance
      .mockResolvedValueOnce(json(detail))        // POST …/photos
      .mockResolvedValueOnce(json({ rows: [row] })); // reload
    await primedStore(fetchMock);
    const w = mount(PortalMaintenancePage, { global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await vi.waitFor(() => expect(w.find('[data-test=portal-maintenance-submit]').exists()).toBe(true));

    await w.get('[data-test=portal-maintenance-title]').setValue('Протекува цевка во визбата');
    await w.get('[data-test=portal-maintenance-description]').setValue('Вода тече покрај вертикалата под влезот.');
    await w.get('[data-test=portal-maintenance-category]').setValue('plumbing');
    await w.get('[data-test=portal-maintenance-priority]').setValue('high');
    // The file input is set directly: jsdom will not let a test click through a real file dialog.
    const input = w.get('[data-test=portal-maintenance-file]').element as HTMLInputElement;
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'voda.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await w.get('[data-test=portal-maintenance-file]').trigger('change');
    await w.get('[data-test=portal-maintenance-submit]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));

    const post = fetchMock.mock.calls[2]!;
    expect(String(post[0])).toBe('http://localhost:3001/api/portal/maintenance');
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({
      contactId: 'c1', buildingId: 'b1',
      title: 'Протекува цевка во визбата', description: 'Вода тече покрај вертикалата под влезот.',
      category: 'plumbing', priority: 'high',
    });
    const upload = fetchMock.mock.calls[3]!;
    expect(String(upload[0])).toBe('http://localhost:3001/api/portal/maintenance/mr-1/photos');
    const form = (upload[1] as RequestInit).body as FormData;
    expect(form.get('contactId')).toBe('c1');
    expect((form.get('file') as File).name).toBe('voda.png');
  });

  it('refuses to send a request with no title', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(me)).mockResolvedValueOnce(json({ rows: [] }));
    await primedStore(fetchMock);
    const w = mount(PortalMaintenancePage, { global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await vi.waitFor(() => expect(w.find('[data-test=portal-maintenance-submit]').exists()).toBe(true));
    await w.get('[data-test=portal-maintenance-submit]').trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(w.get('[data-test=portal-page-error]').text()).toBe('Проверете ги внесените податоци.');
  });
});

describe('PortalMaintenanceRequestPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows the timeline, the manager’s note and the photo', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(me)).mockResolvedValueOnce(json(detail));
    await primedStore(fetchMock);
    const w = mount(PortalMaintenanceRequestPage, { props: { id: 'mr-1' }, global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await flushPromises();
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/portal/maintenance/mr-1?contactId=c1');
    expect(w.get('[data-test=portal-maintenance-status]').text()).toBe('Во тек');
    expect(w.findAll('[data-test=portal-maintenance-event]')).toHaveLength(2);
    expect(w.text()).toContain('Мајсторот е на пат.');
    expect(w.get('[data-test=portal-maintenance-photo]').attributes('src'))
      .toBe('http://localhost:3001/api/portal/maintenance/mr-1/photos/doc-1?contactId=c1');
  });

  it('sends a note from the owner', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(me)).mockResolvedValueOnce(json(detail)).mockResolvedValueOnce(json(detail));
    await primedStore(fetchMock);
    const w = mount(PortalMaintenanceRequestPage, { props: { id: 'mr-1' }, global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await vi.waitFor(() => expect(w.find('[data-test=portal-maintenance-send]').exists()).toBe(true));
    await w.get('[data-test=portal-maintenance-note]').setValue('Стана полошо, водата стигна до визбата.');
    await w.get('[data-test=portal-maintenance-send]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const post = fetchMock.mock.calls[2]!;
    expect(String(post[0])).toBe('http://localhost:3001/api/portal/maintenance/mr-1/events');
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ contactId: 'c1', note: 'Стана полошо, водата стигна до визбата.' });
  });

  it('hides the writing half once the request is closed', async () => {
    const closed = { ...detail, status: 'done' as const, closedAt: '2026-09-25T12:00:00.000Z' };
    const fetchMock = vi.fn().mockResolvedValueOnce(json(me)).mockResolvedValueOnce(json(closed));
    await primedStore(fetchMock);
    const w = mount(PortalMaintenanceRequestPage, { props: { id: 'mr-1' }, global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await vi.waitFor(() => expect(w.find('[data-test=portal-maintenance-status]').exists()).toBe(true));
    expect(w.get('[data-test=portal-maintenance-status]').text()).toBe('Завршено');
    expect(w.find('[data-test=portal-maintenance-send]').exists()).toBe(false);
    expect(w.find('[data-test=portal-maintenance-add-photo]').exists()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @domar/web test PortalMaintenance`
Expected: FAIL — `Failed to resolve import "@/pages/portal/PortalMaintenancePage.vue"`.

- [ ] **Step 3: Implement**

Create `apps/web/src/pages/portal/PortalMaintenancePage.vue`:

```vue
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { MaintenanceCategory, MaintenancePriority, PortalMaintenanceRequest, PortalMaintenanceRow } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { usePortalStore } from '@/stores/portal';

const { t, te } = useI18n();
const portal = usePortalStore();

const CATEGORIES: MaintenanceCategory[] = ['plumbing', 'electrical', 'lift', 'heating', 'cleaning', 'common_area', 'other'];
const PRIORITIES: MaintenancePriority[] = ['low', 'normal', 'high', 'urgent'];

const rows = ref<PortalMaintenanceRow[]>([]);
const buildings = computed(() => portal.current?.buildings ?? []);
const blank = () => ({ buildingId: '', title: '', description: '', category: 'other' as MaintenanceCategory, priority: 'normal' as MaintenancePriority });
const form = ref(blank());
const file = ref<File | null>(null);
const error = ref('');
const saving = ref(false);

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('mk-MK');
const message = (e: unknown) => {
  const code = (e as { code?: string }).code ?? 'generic';
  return te(`maintenance.errors.${code}`) ? t(`maintenance.errors.${code}`) : t('app.error');
};

async function load() {
  const contactId = portal.selectedContactId;
  if (!contactId) { rows.value = []; return; }
  error.value = '';
  try { rows.value = (await api.get<{ rows: PortalMaintenanceRow[] }>('/api/portal/maintenance', { contactId })).rows; }
  catch (e) { error.value = message(e); }
}
onMounted(load);
watch(() => portal.selectedContactId, () => { form.value = blank(); void load(); });

function onFile(e: Event) { file.value = (e.target as HTMLInputElement).files?.[0] ?? null; }

async function submit() {
  const contactId = portal.selectedContactId;
  const buildingId = form.value.buildingId || buildings.value[0]?.id;
  if (!contactId || !buildingId || !form.value.title.trim()) { error.value = t('maintenance.errors.validation'); return; }
  error.value = '';
  saving.value = true;
  try {
    const created = await api.post<PortalMaintenanceRequest>('/api/portal/maintenance', {
      contactId, buildingId,
      title: form.value.title.trim(),
      description: form.value.description.trim(),
      category: form.value.category,
      priority: form.value.priority,
    });
    // The photo follows the request, because it has to be attached to something that exists.
    if (file.value) {
      const fd = new FormData();
      // Order matters: busboy only exposes the fields that precede the file part.
      fd.append('contactId', contactId);
      fd.append('file', file.value, file.value.name);
      await api.upload<PortalMaintenanceRequest>(`/api/portal/maintenance/${created.id}/photos`, fd);
    }
    form.value = blank();
    file.value = null;
    await load();
  } catch (e) { error.value = message(e); } finally { saving.value = false; }
}
</script>
<template>
  <h1 class="mb-1 text-2xl font-semibold">{{ t('portal.maintenance') }}</h1>
  <p class="mb-4 text-sm text-slate-600">{{ t('portal.maintenanceIntro') }}</p>
  <p v-if="error" class="mb-2 text-sm text-red-600" data-test="portal-page-error">{{ error }}</p>

  <form class="mb-6 space-y-3 rounded-xl bg-white p-4 shadow-sm" @submit.prevent="submit">
    <h2 class="font-semibold">{{ t('portal.maintenanceNew') }}</h2>
    <AppSelect v-if="buildings.length > 1" v-model="form.buildingId" :label="t('portal.buildings')" data-test="portal-maintenance-building"
      :options="buildings.map((b) => ({ value: b.id, label: b.name }))" />
    <AppInput v-model="form.title" :label="t('maintenance.requestTitle')" data-test="portal-maintenance-title" />
    <label class="block text-sm"><span class="mb-1 block font-medium text-slate-700">{{ t('maintenance.description') }}</span>
      <textarea v-model="form.description" rows="3" data-test="portal-maintenance-description"
        class="w-full rounded-md border border-slate-300 px-3 py-2 focus:border-emerald-500 focus:outline-none"></textarea></label>
    <div class="grid grid-cols-2 gap-3">
      <AppSelect v-model="form.category" :label="t('maintenance.category')" data-test="portal-maintenance-category"
        :options="CATEGORIES.map((c) => ({ value: c, label: t(`maintenance.categories.${c}`) }))" />
      <AppSelect v-model="form.priority" :label="t('maintenance.priority')" data-test="portal-maintenance-priority"
        :options="PRIORITIES.map((p) => ({ value: p, label: t(`maintenance.priorities.${p}`) }))" />
    </div>
    <label class="block text-sm"><span class="mb-1 block font-medium text-slate-700">{{ t('portal.maintenancePhoto') }}</span>
      <input type="file" class="text-sm" accept="image/png,image/jpeg" data-test="portal-maintenance-file" @change="onFile" /></label>
    <AppButton type="button" :loading="saving" data-test="portal-maintenance-submit" @click="submit">{{ t('portal.maintenanceSubmit') }}</AppButton>
  </form>

  <DataTable :columns="[{ key: 'createdAt', label: t('portal.date') }, { key: 'title', label: t('maintenance.requestTitle') }, { key: 'buildingName', label: t('portal.buildings') }, { key: 'status', label: t('portal.status') }]" :rows="rows">
    <template #cell-createdAt="{ row }">
      <RouterLink :to="`/portal/maintenance/${row.id}`" class="text-emerald-700 underline" data-test="portal-maintenance-link">
        <span data-test="portal-maintenance-row">{{ fmtDate(row.createdAt) }}</span>
      </RouterLink>
    </template>
    <template #cell-status="{ row }"><span data-test="portal-maintenance-status">{{ t(`maintenance.statuses.${row.status}`) }}</span></template>
  </DataTable>
  <p v-if="rows.length === 0" class="mt-2 text-sm text-slate-500">{{ t('portal.maintenanceEmpty') }}</p>
</template>
```

Create `apps/web/src/pages/portal/PortalMaintenanceRequestPage.vue`:

```vue
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api, API_BASE } from '@/api/client';
import type { PortalMaintenanceRequest } from '@/api/types';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import { usePortalStore } from '@/stores/portal';

const props = defineProps<{ id: string }>();
const { t, te } = useI18n();
const portal = usePortalStore();
const router = useRouter();

const request = ref<PortalMaintenanceRequest | null>(null);
const note = ref('');
const file = ref<File | null>(null);
const error = ref('');
const busy = ref('');

const contactId = computed(() => portal.selectedContactId);
const open = computed(() => request.value !== null && request.value.status !== 'done' && request.value.status !== 'rejected');
const photoSrc = (documentId: string) => `${API_BASE}/api/portal/maintenance/${props.id}/photos/${documentId}?contactId=${contactId.value ?? ''}`;
const dateTime = (iso: string) => new Date(iso).toLocaleString('mk-MK', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const message = (e: unknown) => {
  const code = (e as { code?: string }).code ?? 'generic';
  return te(`maintenance.errors.${code}`) ? t(`maintenance.errors.${code}`) : t('app.error');
};

async function load() {
  if (!contactId.value) { request.value = null; return; }
  error.value = '';
  try { request.value = await api.get<PortalMaintenanceRequest>(`/api/portal/maintenance/${props.id}`, { contactId: contactId.value }); }
  catch (e) { error.value = message(e); }
}
onMounted(load);
// The request belongs to the contact that was selected when the page loaded; switching the shell's
// contact makes it somebody else's, so the page steps back to the list (mirrors PortalAssemblyPage).
watch(() => portal.selectedContactId, () => { void router.push('/portal/maintenance'); });

async function send() {
  if (!contactId.value || !note.value.trim()) { error.value = t('maintenance.errors.validation'); return; }
  busy.value = 'note';
  try {
    request.value = await api.post<PortalMaintenanceRequest>(`/api/portal/maintenance/${props.id}/events`, { contactId: contactId.value, note: note.value.trim() });
    note.value = '';
  } catch (e) { error.value = message(e); } finally { busy.value = ''; }
}

function onFile(e: Event) { file.value = (e.target as HTMLInputElement).files?.[0] ?? null; }

async function addPhoto() {
  if (!contactId.value) return;
  if (!file.value) { error.value = t('maintenance.errors.file_required'); return; }
  busy.value = 'photo';
  try {
    const fd = new FormData();
    fd.append('contactId', contactId.value);
    fd.append('file', file.value, file.value.name);
    request.value = await api.upload<PortalMaintenanceRequest>(`/api/portal/maintenance/${props.id}/photos`, fd);
    file.value = null;
  } catch (e) { error.value = message(e); } finally { busy.value = ''; }
}
</script>
<template>
  <div v-if="request">
    <RouterLink to="/portal/maintenance" class="text-sm text-emerald-700 underline">{{ t('portal.back') }}</RouterLink>
    <h1 class="mb-1 mt-2 text-2xl font-semibold">{{ request.title }}</h1>
    <p class="mb-4 text-sm text-slate-600">
      {{ request.buildingName }}<template v-if="request.unitLabel"> · {{ request.unitLabel }}</template> ·
      {{ t(`maintenance.categories.${request.category}`) }} ·
      <span data-test="portal-maintenance-status">{{ t(`maintenance.statuses.${request.status}`) }}</span>
    </p>
    <p v-if="error" class="mb-2 text-sm text-red-600" data-test="portal-page-error">{{ error }}</p>
    <p class="mb-6 whitespace-pre-line text-sm">{{ request.description }}</p>

    <section class="mb-6">
      <h2 class="mb-2 font-semibold">{{ t('portal.maintenancePhotos') }}</h2>
      <div class="mb-3 flex flex-wrap gap-3">
        <img v-for="p in request.photos" :key="p.documentId" :src="photoSrc(p.documentId)" :alt="p.fileName"
          class="h-28 w-28 rounded-lg object-cover" data-test="portal-maintenance-photo" />
        <p v-if="request.photos.length === 0" class="text-sm text-slate-500">{{ t('app.empty') }}</p>
      </div>
      <div v-if="open" class="flex items-end gap-3">
        <input type="file" class="text-sm" accept="image/png,image/jpeg" data-test="portal-maintenance-photo-file" @change="onFile" />
        <AppButton type="button" :loading="busy === 'photo'" data-test="portal-maintenance-add-photo" @click="addPhoto">{{ t('portal.maintenanceAddPhoto') }}</AppButton>
      </div>
    </section>

    <section>
      <h2 class="mb-2 font-semibold">{{ t('portal.maintenanceTimeline') }}</h2>
      <ol class="mb-3 space-y-2 text-sm">
        <li v-for="e in request.events" :key="e.id" class="rounded-lg bg-white p-2 shadow-sm" data-test="portal-maintenance-event">
          <span class="font-medium">{{ t(`maintenance.eventKinds.${e.kind}`) }}</span>
          <span v-if="e.toStatus" class="text-slate-600"> → {{ t(`maintenance.statuses.${e.toStatus}`) }}</span>
          <span class="ml-2 text-xs text-slate-500">{{ e.authorName }} · {{ dateTime(e.createdAt) }}</span>
          <p v-if="e.note" class="whitespace-pre-line">{{ e.note }}</p>
        </li>
      </ol>
      <form v-if="open" class="flex items-end gap-3" @submit.prevent="send">
        <AppInput v-model="note" :label="t('portal.maintenanceNote')" data-test="portal-maintenance-note" />
        <AppButton type="button" :loading="busy === 'note'" data-test="portal-maintenance-send" @click="send">{{ t('portal.maintenanceAddNote') }}</AppButton>
      </form>
      <p v-else class="text-sm text-slate-500">{{ t('portal.maintenanceClosed') }}</p>
    </section>
  </div>
  <p v-else-if="error" class="text-sm text-red-600" data-test="portal-page-error">{{ error }}</p>
  <p v-else>{{ t('app.loading') }}</p>
</template>
```

In `apps/web/src/router/index.ts`, add two children to the `/portal` route, after the two assembly routes:

```ts
        { path: 'maintenance', component: () => import('@/pages/portal/PortalMaintenancePage.vue') },
        { path: 'maintenance/:id', component: () => import('@/pages/portal/PortalMaintenanceRequestPage.vue'), props: true },
```

In `apps/web/src/layouts/PortalShell.vue`, add one entry to `nav`, after the assemblies entry:

```ts
  { to: '/portal/maintenance', key: 'portal.maintenance', test: 'portal-nav-maintenance' },
```

Add these keys to the `portal` group in `apps/web/src/i18n/mk.ts`, after the `assemblyInvitation`/`assemblyMinutes` line:

```ts
    maintenance: 'Одржување', maintenanceNew: 'Пријави проблем',
    maintenanceIntro: 'Пријавете дефект или проблем во заедничките делови. Управителот го гледа барањето веднаш и го следите тука.',
    maintenanceEmpty: 'Сè уште немате пријавено барање.',
    maintenanceSubmit: 'Испрати барање', maintenancePhoto: 'Фотографија', maintenancePhotos: 'Фотографии',
    maintenanceAddPhoto: 'Додади фотографија', maintenanceTimeline: 'Тек на барањето',
    maintenanceNote: 'Порака до управителот', maintenanceAddNote: 'Испрати',
    maintenanceClosed: 'Барањето е затворено.',
```

and the same keys to `apps/web/src/i18n/en.ts`:

```ts
    maintenance: 'Maintenance', maintenanceNew: 'Report a problem',
    maintenanceIntro: 'Report a fault or a problem in the common parts. Your manager sees it immediately and you follow it here.',
    maintenanceEmpty: 'You have not reported anything yet.',
    maintenanceSubmit: 'Send request', maintenancePhoto: 'Photo', maintenancePhotos: 'Photos',
    maintenanceAddPhoto: 'Add photo', maintenanceTimeline: 'Activity',
    maintenanceNote: 'Message to the manager', maintenanceAddNote: 'Send',
    maintenanceClosed: 'This request is closed.',
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @domar/web test && pnpm --filter @domar/web typecheck && pnpm lint`
Expected: PASS — 6 new cases in `PortalMaintenance.test.ts`, the 11 of Task 5 still green, and `LoginPage.test.ts`'s mk/en parity case green with the twelve new `portal.*` keys in both files.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): owners report and follow maintenance requests in the portal" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: End-to-end — a leak reported at night, fixed by a technician, closed with a cost

**Files:**
- Create: `e2e/tests/maintenance.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `e2e/tests/maintenance.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

const API = 'http://localhost:3001';
const slug = `e2e-odrzuvanje-${Date.now().toString(36)}`;
const password = 'correct-horse-1';
const ownerPassword = 'battery-staple-7';
/** A 1×1 PNG: the photo routes accept png and jpeg and nothing else. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('an owner reports a leak, a technician fixes it and the manager closes it with a cost', async ({ page, browser }) => {
  // --- the manager opens the organisation ---
  await page.goto('/register');
  await page.getByTestId('orgName').fill('Е2Е Одржување');
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
  await post(`/api/buildings/${building.id}/units`, { label: '1', kind: 'apartment', areaM2: 50, ownerContactId: owner.id });
  await post('/api/suppliers', { name: 'Водовод Инженеринг ДООЕЛ' });
  // 35.000,00 den in the reserve fund: enough to pay for the repair and leave a readable remainder.
  await post(`/api/buildings/${building.id}/reserve-fund/opening-balance`, { amountMinor: 3_500_000 });
  // The technician who will do the work, signed in later in their own browser context.
  const technician = await post('/api/users', { email: `stefan@${slug}.mk`, firstName: 'Стефан', lastName: 'Стефановски', role: 'technician' });

  // The owner's portal code, read off the manager's screen exactly once.
  await page.goto(`/app/contacts/${owner.id}`);
  await page.getByTestId('portal-issue').click();
  const code = (await page.getByTestId('portal-issued-code').innerText()).trim();

  // --- the owner reports the leak, with a photo ---
  const ownerContext = await browser.newContext();
  const owners = await ownerContext.newPage();
  try {
    await owners.goto('/portal/register');
    await owners.getByTestId('portal-code').fill(code);
    await owners.getByTestId('portal-email').fill(`marko@${slug}.mk`);
    await owners.getByTestId('portal-password').fill(ownerPassword);
    await owners.getByTestId('portal-submit').click();
    await expect(owners).toHaveURL(/\/portal$/);

    await owners.getByTestId('portal-nav-maintenance').click();
    await owners.getByTestId('portal-maintenance-title').fill('Протекува цевка во визбата');
    await owners.getByTestId('portal-maintenance-description').fill('Вода тече покрај вертикалата под влезот, веќе трет ден.');
    await owners.getByTestId('portal-maintenance-category').selectOption('plumbing');
    await owners.getByTestId('portal-maintenance-priority').selectOption('high');
    await owners.getByTestId('portal-maintenance-file').setInputFiles({ name: 'voda.png', mimeType: 'image/png', buffer: PNG });
    await owners.getByTestId('portal-maintenance-submit').click();
    await expect(owners.getByTestId('portal-maintenance-row')).toHaveCount(1);
    await expect(owners.getByTestId('portal-maintenance-status')).toHaveText('Ново');

    // --- the manager triages and assigns ---
    await page.goto(`/app/buildings/${building.id}?tab=maintenance`);
    await expect(page.getByTestId('maintenance-count-new')).toHaveText('1');
    await expect(page.getByTestId('maintenance-card')).toContainText('Протекува цевка во визбата');
    await page.getByTestId('maintenance-card').click();
    await expect(page.getByTestId('maintenance-panel-status')).toHaveText('Ново');
    // The owner's photo is already on the manager's panel.
    await expect(page.getByTestId('maintenance-photo')).toHaveCount(1);
    await page.getByTestId('maintenance-triage').click();
    await expect(page.getByTestId('maintenance-panel-status')).toHaveText('Примено');
    await page.getByTestId('maintenance-assignee').selectOption(technician.user.id);
    await page.getByTestId('maintenance-assign').click();
    await expect(page.getByTestId('maintenance-panel-status')).toHaveText('Доделено');
    await expect(page.getByTestId('maintenance-count-assigned')).toHaveText('1');
    const requestUrl = page.url();

    // --- the technician signs in and starts the job ---
    const techContext = await browser.newContext();
    try {
      const tech = await techContext.newPage();
      await tech.goto('/login');
      await tech.getByTestId('tenantSlug').fill(slug);
      await tech.getByTestId('email').fill(`stefan@${slug}.mk`);
      await tech.getByTestId('password').fill(technician.temporaryPassword);
      await tech.getByRole('button', { name: /Најави се|Sign in/ }).click();
      await expect(tech).toHaveURL(/\/app$/);

      await tech.goto(requestUrl);
      // A technician sees their own queue and no create form at all.
      await expect(tech.getByTestId('maintenance-card')).toHaveCount(1);
      await expect(tech.getByTestId('maintenance-create')).toHaveCount(0);
      await tech.getByTestId('maintenance-card').click();
      await expect(tech.getByTestId('maintenance-panel-status')).toHaveText('Доделено');
      await expect(tech.getByTestId('maintenance-close-open')).toHaveCount(0); // never books money
      await tech.getByTestId('maintenance-start').click();
      await expect(tech.getByTestId('maintenance-panel-status')).toHaveText('Во тек');
      await tech.getByTestId('maintenance-note').fill('Заменета спојка, фатено во 40 минути.');
      await tech.getByTestId('maintenance-note-add').click();
      // created, photo_added, triaged, assigned, in_progress, comment — six, in that order.
      await expect(tech.getByTestId('maintenance-event')).toHaveCount(6);
    } finally {
      await techContext.close();
    }

    // --- the manager closes it with a 12.000 den cost on the reserve fund ---
    await page.reload();
    await page.getByTestId('maintenance-card').click();
    await expect(page.getByTestId('maintenance-panel-status')).toHaveText('Во тек');
    await page.getByTestId('maintenance-close-open').click();
    await page.getByTestId('maintenance-close-fund').selectOption('reserve');
    await page.getByTestId('maintenance-close-amount').fill('12.000,00');
    await page.getByTestId('maintenance-close-supplier').selectOption({ label: 'Водовод Инженеринг ДООЕЛ' });
    await page.getByTestId('maintenance-close-note').fill('Заменета спојка, дефектот е отстранет.');
    await page.getByTestId('maintenance-close-submit').click();
    await expect(page.getByTestId('maintenance-panel-status')).toHaveText('Завршено');
    await expect(page.getByTestId('maintenance-panel-cost')).toContainText('12.000,00');
    await expect(page.getByTestId('maintenance-count-done')).toHaveText('1');

    // --- the money is in the fund, through the ordinary expense flow ---
    await page.goto(`/app/buildings/${building.id}?tab=reserve-fund`);
    await expect(page.getByText('Одржување: Водовод и канализација — Протекува цевка во визбата').first()).toBeVisible();
    const state = await (await page.request.get(`${API}/api/buildings/${building.id}/reserve-fund`)).json();
    expect(state.balanceMinor).toBe(3_500_000 - 1_200_000);
    const tx = await (await page.request.get(`${API}/api/buildings/${building.id}/reserve-fund/transactions`)).json();
    expect(tx.rows[0]).toMatchObject({ kind: 'expense', fund: 'reserve', amountMinor: -1_200_000 });

    // --- the owner sees the closed request and the manager's note ---
    await owners.reload();
    await expect(owners.getByTestId('portal-maintenance-status')).toHaveText('Завршено');
    await owners.getByTestId('portal-maintenance-link').click();
    await expect(owners.getByTestId('portal-maintenance-status')).toHaveText('Завршено');
    await expect(owners.locator('body')).toContainText('Заменета спојка, дефектот е отстранет.');
    // The technician's internal note is not theirs to read.
    await expect(owners.locator('body')).not.toContainText('фатено во 40 минути');
    await expect(owners.getByTestId('portal-maintenance-photo')).toHaveCount(1);
    // Closed means closed: the portal offers no way to write to it any more.
    await expect(owners.getByTestId('portal-maintenance-send')).toHaveCount(0);

    // …and the money is visible where Art. 45(4) puts it.
    await owners.getByTestId('portal-nav-fund').click();
    await expect(owners.getByTestId('portal-fund-reserve')).toHaveText('23.000,00 ден.');
  } finally {
    await ownerContext.close();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm db:up && pnpm e2e -- maintenance.spec.ts`
Expected: FAIL — on a branch without Task 6 the portal has no `portal-nav-maintenance` link; on a fully built branch this step is the one that proves the whole chain, portal to ledger.

- [ ] **Step 3: Implement**

Nothing to implement: every route, screen and hook this spec touches was built in Tasks 1–6. If the spec fails here, fix the task that owns the failing hook rather than the spec. Three places where it depends on real behaviour and may legitimately need its own adjustment:

- **`maintenance-event` count is 6** after the technician's note: `created` and `photo_added` from the owner's report, then `status_changed → triaged`, `assigned`, `status_changed → in_progress` and the technician's `comment`. If the count comes out at 5, a photo upload stopped writing its event and Task 4 is what to fix, not this number.
- **The technician's `maintenance-close-free` button is visible to them**; the spec deliberately does not press it, because the manager is the one who closes with the cost. A technician pressing it first would close the request with no cost and the manager could not then book the expense — that is the designed behaviour (addendum 2: no reopening), not a bug, and the spec's order is the supported workflow.
- **The reserve fund figure `23.000,00 ден.`** is `35.000,00 − 12.000,00`. If the portal fund page shows the *billed* figure in a different hook, use `portal-fund-reserve` exactly as `portal.spec.ts` does.

- [ ] **Step 4: Run tests**

Run: `pnpm db:up && pnpm -r test && pnpm lint && pnpm typecheck && pnpm e2e`
Expected: PASS — every package's suite plus the whole Playwright suite (`smoke`, `billing`, `payments`, `pilot`, `reminders`, `portal`, `import-xlsx`, `compliance`, `assembly`, `reports`, `maintenance`).

- [ ] **Step 5: Commit**

```bash
git add e2e
git commit -m "test(e2e): a leak reported from the portal, fixed by a technician and paid from the reserve fund" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes

**Spec coverage — Phase 2 §8 (maintenance), phrase by phrase**

- *"`maintenance_requests`: `tenant_id`, `building_id`, `unit_id` (nullable)"* — Task 1, exactly those, `unit_id` `on delete set null` and validated against the building on every write.
- *"`reported_by` (contact or user)"* — two nullable columns plus the database check `num_nonnulls(…) = 1`, so "contact **or** user" is enforced by Postgres and not by convention (addendum 1). `reporterKind` on the wire tells the two apart without the client inspecting ids.
- *"`title`, `description`, `category`, `priority`"* — all four, `category` and `priority` as Postgres enums whose labels the country pack also carries (addendum 14).
- *"`status` (`new`, `triaged`, `assigned`, `in_progress`, `done`, `rejected`)"* — that exact enum, in that order, plus the transition graph in `@domar/domain` (addendum 2) and a claim-first `UPDATE … WHERE status IN (…) RETURNING` on every move (addendum 4). Task 2 locks the graph by `toEqual`, Task 3 locks the 409s through HTTP.
- *"`assignee_user_id`, `supplier_id`"* — both, independent of each other; the assignee must be an active `technician`, `accountant` or `owner` of the tenant (Task 3 asserts a foreign user and a `readonly` user are both `400 invalid_reference`); the supplier goes through the existing `assertSupplierInTenant`.
- *"`fund`, `cost_minor` (nullable), `expense_id` (nullable)"* — all three, filled only by a close that books money, and `expense_id` points at the row the **existing** `createExpense` wrote.
- *"photos as documents (`kind photo`)"* — `documents.kind = 'photo'` plus the `maintenance_photos` join table (addendum 8), the narrower `PHOTO_MIME` allowlist and the 8 MiB per-request cap (addendum 9).
- *"`created_at`, `closed_at`"* — both; `closed_at` is stamped only by the `done` transition.
- *"`maintenance_events` (status changes with note, author, timestamp)"* — that table, widened by `kind` (so an assignment, a comment and a photo are in the same feed) and by `visibility` (so the portal has something to filter on, addendum 11). Author is a user **or** a contact, checked `<= 1` (addendum 12).
- *"Portal: owner creates a request with photos, follows status"* — `POST /api/portal/maintenance` then `POST …/photos`, which is what `PortalMaintenancePage.vue` does in one press; `GET …/:id` is the timeline.
- *"gets notifications"* — **not implemented, and deliberately.** Spec §9 owns `push_subscriptions`, `notifications` and the triggers, one of which is explicitly "maintenance status change"; sub-plan 5 is where that table and that trigger belong. Building half a notification here would either invent a table §9 already specifies or bolt an email onto a status change nobody asked to be emailed about. The seam is clean: the status transition already writes a `maintenance_events` row, which is exactly the hook §9 will read.
- *"Manager: board by status"* — `MaintenanceTab.vue`, six columns, counts, filters by status and category.
- *"assign to technician user or supplier"* — one `POST …/assign` taking both, the supplier optional and independent (addendum 3).
- *"close with cost → creates an expense on the chosen fund (existing expense flow) and links it"* — `POST …/status { status: 'done', cost: { fund, costMinor, supplierId?, documentId? } }` calling `createExpense` inside the same transaction and stamping `expense_id` (addendum 5). Task 4 asserts the fund balance moves, the posting exists with `refType 'expense'` and `refId` the new expense, and the description is the pack's Macedonian sentence; Task 7 asserts the same thing through two browsers.
- *"Technician role: sees and updates assigned requests only"* — `scope(ctx)` on every statement, `404` (never `403`) for anybody else's request, `MAINTENANCE_CAPABILITIES.technician` for what they may do, `403 cost_requires_write_role` for the one thing they may not (addenda 6 and 7). Task 3 and Task 7 both assert the isolation.

**Phase 2 §10 (roles)**

- *"`technician` gains maintenance access (assigned requests, photos, status)"* — `MAINTENANCE_ROLES` gates `/status`, `/events` and `/photos`; the repo narrows each to their own queue; the board's list is filtered for them; a photo upload to somebody else's request is `404`. This is the **first write a technician has anywhere in domar** — `WRITE_ROLES` stays `['owner','accountant']` and is not touched.
- *"and read on buildings"* — already true: `GET /api/buildings/:id` and `GET /api/buildings/:id/units` are behind `requireAuth` alone. Task 3 **asserts** it rather than changing it, so a future tightening of that route breaks a test that says why it must not.
- *"`readonly` sees compliance and reports"* — unchanged, and `readonly` additionally reads the maintenance board (every `GET` here is behind `requireAuth`) and writes nothing (`MAINTENANCE_CAPABILITIES.readonly` is empty and the routes refuse it first). Task 3 asserts both halves.
- *"Owner/accountant unchanged"* — they hold every capability, exactly as they hold every other write in the system.

**Phase 2 §4 and §11**

- §4: a photo is an ordinary `documents` row — same `DATA_DIR/documents/<tenant>/<year>/` layout, same sha256, same `uploaded_by`, same audit row, same tenant-checked `GET /api/documents/:id/download`. The only narrowing is the allowlist and the cap the two photo routes pass; `ALLOWED_MIME` and the building upload route are untouched, so `documents.test.ts` keeps passing unchanged.
- §11, invariant by invariant: **legal events** — none written, none read, `legal_event_kind` unchanged, the compliance snapshot and evaluator untouched (addendum 13). **Document downloads** — the staff route checks the tenant; the portal route checks link, unit ownership **and** that the request is the caller's own, before a byte is opened; `portalDocumentFile`'s `minutes`/`report` filter is untouched, so a maintenance photo is deliberately *not* reachable through the generic portal document route. **Uploads** — stored under `DATA_DIR`, outside the web root, streamed through `LocalDiskStore.put` (never buffered whole), never executed, served with `x-content-type-options: nosniff`, mime-checked against a two-entry allowlist and capped at 8 MiB. **Costs reach the ledger only through the existing expense flow; no new posting kinds** — `createExpense` is called, no `addPosting` appears anywhere in this plan, `posting_kind` gains no value, and Task 4 asserts the resulting posting is the ordinary `expense` one. **Push payloads** — nothing in this sub-plan sends a notification.

**Phase 1 §16 and the project conventions** — three new tables, each with `tenant_id uuid not null` and an index leading with it (the migration suite's generic sweep covers them automatically, and Task 1 names each index explicitly as well). One new money column, `cost_minor`, `bigint`, suffixed `_minor`, and every amount on the wire is `costMinor`. Every repo function takes `(db, ctx, …)` and every `where` starts with `eq(X.tenantId, ctx.tenantId)`; the portal's queries add the contact filter on top. Every mutation writes `writeAudit` inside its own transaction — `maintenance.create`, `maintenance.portal_create`, `maintenance.update`, `maintenance.status`, `maintenance.assign`, `maintenance.event`, `maintenance.portal_event`, `maintenance.photo.create`, `maintenance.photo.delete`, plus the `expense.create` and `document.create` rows the reused flows write themselves. Cross-tenant is `404`; so is a technician's or an owner's out-of-scope row. `exactOptionalPropertyTypes` is respected by conditional spreads (`...(cost ? { … } : {})`, `...(input.contactId ? { authorContactId: input.contactId } : {})`) and by `stripUndefined` in `updateRequest`. Every local import carries `.js` and every type-only import is `import type`. Every user-facing string is a `vue-i18n` key added to **both** `mk.ts` and `en.ts`, Macedonian first. Every element the e2e touches carries `data-test`. No new dependency, no new environment variable, so `.env.example` is untouched. Seven tasks, seven conventional commits, each after a green run.

**Interfaces consumed across tasks**

- T1 → T2/T3/T4: `schema.maintenanceRequests`, `schema.maintenanceEvents`, `schema.maintenancePhotos` and the five pg enums (whose `.enumValues` become every zod enum in T3).
- T2 → T3/T4/T5/T6: `MAINTENANCE_STATUSES`, `ALLOWED_TRANSITIONS`, `canTransition`, `nextStatus`, `isTerminal`, `can`, `MAINTENANCE_CAPABILITIES`, `MaintenanceStatus`/`MaintenanceCategory`/`MaintenancePriority`, `pack.maintenanceCategories`, `pack.labels.maintenanceExpense`.
- T3 → T4: `MR`, `PHOTO_COUNT`, `getRequestRow`, `getRequest`, `claimRequest`, `recordEvent`, `requestPhotos`, `requestEvents`, `maintenanceStatusBody` (whose `cost` field T4 widens), `MAINTENANCE_ROLES`, `createStaffUser`.
- T3/T4 → T5/T6/T7: the eleven HTTP routes.
- T5 → T7: every `data-test` hook of the board and the panel, and `?tab=maintenance`.
- T6 → T7: `/portal/maintenance`, `/portal/maintenance/:id` and the portal hooks.
- Unchanged existing interfaces reused: `writeAudit`, `getBuilding`, `assertSupplierInTenant`, `assertDocumentInTenant` (via `createExpense`), `createExpense`, `createDocument` (with its `allow` parameter), `DocumentStore`/`LocalDiskStore`, `contentDisposition`, `MAX_DOCUMENT_BYTES`, `requireRole`/`WRITE_ROLES`, `buildingParam`, `idParam`, `stripUndefined`, `fundEnum`, `resolveLink`, `assertOwnsUnitIn`, `portalContactQuery`, `createTestApp`, `registerTenant`, `setupPublishedBuilding`, `DataTable`, `ModalDialog`, `AppButton`/`AppInput`/`AppSelect`, `formatMoney`/`toMinor`, `usePortalStore`, `useAuthStore`. **Two existing files change behaviour, both additively:** `apps/api/src/auth/roles.ts` gains one exported constant, and `apps/api/src/app.ts` gains three registrations. **No existing signature is changed or narrowed, and `WRITE_ROLES` keeps its two members.**

**Numbers and strings the tests lock**

- T1: the 19 columns of `maintenance_requests` and the 11 of `maintenance_events` by `toEqual`; the six statuses, four priorities, seven categories, five event kinds and two visibilities in declaration order; the four leading-`tenant_id` indexes; `maintenance_requests_reporter_chk` refusing `(null, null)` and `(user, contact)` and accepting `(user, null)`; `maintenance_photos.document_id` unique and `CASCADE`.
- T2: `ALLOWED_TRANSITIONS` and `MAINTENANCE_CAPABILITIES` whole, by `toEqual`; every status reachable from `new`; every non-terminal status having an exit; `'Одржување: Водовод и канализација — Протекува цевка во визбата'`.
- T3: the five-step walk and its five events in order; `409 status_locked` on `new → in_progress`, on a reopen and on editing a closed request; `400 cost_decision_required`; `400 invalid_reference` for a foreign and for a `readonly` assignee; a technician's list containing their request and not the other; `404` (not `403`) for the request they were not given; `403` for create, assign and patch; `403` for `readonly` on both writes; `200` for a technician reading `/api/buildings/:id`; the three audit actions sorted.
- T4: `image/png` round-tripping byte-identical; `400 unsupported_media_type` for a PDF; `uploadedByName` 'Стефан Стефановски' and 'Тест Анѓеловски'; one fewer file on disk after a delete; `403` for a technician deleting; `3_500_000 → 2_300_000` on the reserve fund; the posting `{ kind: 'expense', fund: 'reserve', amountMinor: -1_200_000 }`; `403 cost_requires_write_role` with the balance unmoved; a rolled-back close on a bad supplier; `409 status_locked` for a photo on a closed request; the portal seeing `'Примено, доаѓаме утре.'` and not `'Домаќинот не се јавува, пробај попладне.'`; `visibility` and `costMinor` absent from the portal payload; `'Одржување: Водовод и канализација — Протекува цевка во визбата'` on the owner's fund page.
- T5: counts per column; the create body; `?status=done`; the assign body `{ assigneeUserId: 'usr-1', supplierId: 'sup-1' }`; the close body with `costMinor: 1_200_000`; `{ status: 'done', cost: null }`; `'Проверете ги внесените податоци.'` with nothing sent; `'Статусот веќе е променет од некој друг. Освежете ја страницата.'`; the assignee list being `['', 'usr-1']` — `readonly` excluded.
- T6: `?contactId=c1` on the list; the create body with no `unitId`; the FormData carrying `contactId` and the file; the photo `src`; six events; nothing writable once `done`.
- T7: `Ново → Примено → Доделено → Во тек → Завршено`; the technician seeing one card, no create form and no close-with-cost button; six events; `12.000,00`; `35.000,00 − 12.000,00 = 23.000,00 ден.` on the owner's fund page; the owner reading the manager's note and not the technician's internal one.

**Diff size** — T4 ≈590 lines across 10 files (≈280 of them the two test files), T3 ≈580 across 7 (≈250 the test), T5 ≈540 across 7 (≈230 the test), T6 ≈420 across 7, T1 ≈330 across 4, T2 ≈300 across 6, T7 ≈130. T4 is the one a reviewer could split; see addendum 16 for why it is not.

**Placeholder scan** — every new file is given in full; every change to an existing file is given as an exact quoted block with the line it goes after, or as a before/after pair. There is no `TODO`, no `...`, no "implement similarly", and no test whose expected value is left to the implementer — including Task 7's event count, which is stated as 6 with the six events named. The files changed rather than created are `packages/db/src/schema/index.ts`, `packages/db/test/migrations.test.ts`, `packages/domain/src/{index,country/types,country/mk}.ts`, `packages/domain/test/country.test.ts`, `apps/api/src/{app,auth/roles,portal/schema}.ts`, `apps/api/src/resources/maintenance/{schema,repo,routes}.ts` (Task 4's additions to Task 3's files), `apps/api/test/fixtures.ts`, `apps/web/src/{api/types,router/index,pages/BuildingDetailPage.vue,layouts/PortalShell.vue}` and the two i18n files. The one file name nobody can write down in advance is the generated `packages/db/migrations/0012_*.sql`, whose suffix drizzle-kit assigns; Task 1 says so and says what to verify in it instead.

**Signatures double-checked against the code** — `writeAudit(db, ctx, { action, entityType, entityId?, before?, after? })`; `getBuilding(db, ctx, id)` throws `notFound('Building')` and returns the row **including `countryCode`**, which is what feeds `getCountryPack`; `createExpense(db, ctx, buildingId, { fund, description, supplierText?, supplierId?, documentId?, amountMinor, paidAt })` opens its own `db.transaction` — a savepoint when handed a `tx` — writes the `expense` posting through `addPosting` and its own `expense.create` audit row, and returns the inserted expense; `assertSupplierInTenant(db, ctx, id | null | undefined)` throws `400 invalid_reference`; `createDocument(db, ctx, store, { buildingId, kind, title, fileName, mime, stream, isTruncated, allow? })` returns the public row **plus `storageKey`** and answers `413 file_too_large` / `400 unsupported_media_type` / `400 empty_file` itself, and `allow` defaults to `ALLOWED_MIME` so no other caller is affected; `deleteDocument` checks contracts, expenses and assemblies and is **not** edited, because `maintenance_photos.document_id` cascades; `contentDisposition(fileName, 'inline')` exists and takes that second argument; `req.file({ limits: { fileSize } })` is `@fastify/multipart@9`'s per-request override and `part.file.truncated` is what `throwFileSizeLimit: false` leaves behind; `resolveLink(portal, contactId)` returns `{ ctx, contactId }` with `ctx.role === 'readonly'` and `ctx.userId === null` — which is why `scope(ctx)` never fires for a portal caller and why `recordEvent` signs a portal event with the contact and not a user; `assertOwnsUnitIn(db, ctx, contactId, buildingId)` throws `notFound('Building')`; `POST /api/users` answers `201` with `{ user, temporaryPassword }` and `GET /api/users` and `GET /api/suppliers` are behind `requireAuth` alone, which is what lets an accountant and a technician fill the board's selects; `alias(table, name)` comes from `drizzle-orm/pg-core` and `check(name, sql)` exists in drizzle-orm 0.36.4; `num_nonnulls` is core Postgres; `AppSelect` takes `label`, `options: { value, label }[]` and `v-model`, and emits no change event — hence the watcher; `toMinor` returns `number | null`; `DataTable` renders `data-test="row"` per row and exposes `#cell-<key>` and `#actions`.

**Four risks called out rather than hidden**

1. **A technician can close a request without a cost before the manager books one.** `close` is theirs by design (addendum 6) and `done` is terminal (addendum 2), so a premature close means the expense has to be entered on the Trošoci tab by hand and the request keeps `cost_minor` null. The alternative — taking `close` away from the technician — would leave a finished job sitting in `in_progress` until an accountant notices, which is worse for the building and worse for the board's honesty. Task 7 documents the supported order; the mitigation if it bites in the pilot is a per-tenant setting, not a schema change.
2. **`no action` on the two reporter columns pins a user and a contact in place.** Neither has a delete route today (users are deactivated, contacts are `restrict`-ed by reminders and invitations already), and a whole-tenant delete still works because `no action` is checked at end of statement. But a future "delete contact" feature will have to reckon with maintenance history, exactly as it already has to reckon with `assembly_invitations`.
3. **The close renders no document and holds no browser, but it does hold `createExpense` inside the claim.** The transaction is short — one update, one insert, one posting, two audit rows — and the claim-first update means a second manager pressing the same button waits and then gets `409`, never a second expense. The residue a crash can leave is nothing at all: no file is written on this path.
4. **The portal shows an owner only their own requests (addendum 10).** A building where three neighbours report the same leak will carry three requests and none of the three will see the others. That is the deliberate privacy trade; the manager sees all three on one board and closes two with `rejected` and a note. If the pilot asks for a shared building feed, it is a new read on `visibility = 'owner'` across the building — additive, and not something this sub-plan forecloses.
