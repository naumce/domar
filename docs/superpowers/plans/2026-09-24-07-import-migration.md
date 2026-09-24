# Domar Import and Domexa Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A building manager who keeps their units in an Excel file with their own column names opens the building's "Import" tab, picks the `.xlsx`, connects each column to a target field once (the obvious ones are connected already), and commits — the same preview, the same row errors, the same commit the CSV template has always produced. A manager who keeps their whole portfolio in Domexa runs one command against a read-only export of their Domexa account and gets the same file, plus their tax rates, services, buildings, recurring services and reserve funds, posted into a fresh domar tenant through domar's own API, twice if they like, without duplicating a row.

**Architecture:** `@domar/domain` gains three exports on the existing parser (`matchImportHeader`, `normaliseKind`, `IMPORT_FIELDS`, all refactored out of the alias tables that `parseUnitImport` already owns) plus `src/import/serialize.ts` (the inverse of the parser: mapped cells → the canonical `;` CSV) and `src/migration/domexa.ts` (pure, tolerant transforms from Domexa's JSON to domar's request bodies, with a `MigrationReport`). `apps/web` gains `src/utils/spreadsheet.ts` (lazy SheetJS, first sheet → rows, the mapping-memory key) and a mapping step inside `ImportTab.vue`; nothing about the API changes. `apps/api` gains `scripts/domexa/{client,export,transform,apply,cli}.ts` — a GET-only Domexa client, a raw export into the git-ignored `domexa-export/`, a transform into `domexa-export/domar/` and an idempotent `apply` that talks to domar's own HTTP API with an injectable `fetch`. `docs/MIGRATION.md` and `e2e/tests/import-xlsx.spec.ts` close it.

**Tech Stack:** unchanged (Node 24, pnpm 10, TS strict, Fastify 5 + zod, Drizzle + Postgres 16, Vue 3 + Vite + vue-i18n + Tailwind 4, Vitest, Playwright 1.63.0, `tsx` already a dependency of `@domar/api`) plus exactly one new package: `xlsx@0.18.5` (SheetJS community build from npm, Apache-2.0) as a dependency of `@domar/web` and a devDependency of `@domar/e2e`. No new API dependency: the scripts use global `fetch` and `node:fs`.

**Spec:** `docs/superpowers/specs/2026-09-21-domar-phase1-design.md` §20 (the four points of this sub-plan), §17.3 (the CSV import this plan extends without touching it), §3.4 ("import/export are products"), §11 (API shape — unchanged here), §12 (web), §16 (global constraints). Previous plans: `2026-09-24-04-pilot-ready.md` (the CSV import, the parser, `ImportTab.vue`, the opening-balance rules), `2026-09-24-06-owner-portal.md` (the plan style, the two-cookie precedent, the e2e seeding pattern this plan's `apply` test mirrors).

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

- **Money is integer minor units** everywhere (`number` in TS, `bigint` in Postgres). Amounts on the wire end in `Minor`. A Domexa string like `"1234.56"` or number `1234.56` becomes `123456` exactly once, in `packages/domain/src/migration/domexa.ts`, and never again downstream.
- **Tenant filter on every statement.** This plan adds no repo and no query; every write it performs goes through an existing HTTP route that already carries `req.ctx`. No script ever opens a database connection.
- **An audit row is written inside the same transaction as every mutation.** Also inherited rather than added: `apply` posts to routes that already audit (`import.units` among them).
- **Role gating:** every route `apply` calls is already behind `app.requireAuth` + `requireRole(...WRITE_ROLES)`; the migration therefore logs in as an `owner`.
- **Error envelope:** `{ error: { code, message, details? } }`. The scripts read `body.error.code` and `body.error.message` when a call fails and re-throw a `DomarApiError` carrying status, code and path.
- **TS strict with `exactOptionalPropertyTypes`**: never pass an explicit `undefined` into an object typed with an optional property; spread conditionally (`...(x ? { x } : {})`).
- **ESM `.js` import specifiers** in every TS import of a local file (`./serialize.js`, `../../src/app.js`), `import type` for type-only imports (`@typescript-eslint/consistent-type-imports` is an error).
- **i18n mk/en parity**: `apps/web/test/LoginPage.test.ts` asserts `flatKeys(messages.en).sort()` equals `flatKeys(messages.mk).sort()`. Every key added in this plan goes into both files, Macedonian first.
- **`data-test` hooks** on every element an e2e test touches (`testIdAttribute: 'data-test'` in `e2e/playwright.config.ts`).
- Run everything from the repo root. Postgres for tests is the docker-compose service on port 54329 (`pnpm db:up`).
- **Conventional commits**, each ending with the trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

Safety rules from spec §20.4, binding on Tasks 4, 5 and 6:

- **No credentials in the repo or in the export folder.** `DOMEXA_ORG`, `DOMEXA_EMAIL`, `DOMEXA_PASSWORD`, `DOMEXA_COOKIE`, `DOMAR_URL`, `DOMAR_SLUG`, `DOMAR_EMAIL`, `DOMAR_PASSWORD` are documented empty in `.env.example` and read from the environment only. No script writes a credential, a cookie or an `Authorization` header into a file, into a log line or into `report.md`.
- **`domexa-export/` is git-ignored and dockerignored.** Both entries are added in Task 4, in the same commit that can first create the folder.
- **`apply` refuses a `DOMAR_URL` that is not `http://localhost*` or `http://127.0.0.1*` unless `--yes` is passed.** The refusal is a thrown `Error`, before the login call, and it is unit-tested.
- **Every network call is logged with method and path** — never with a body, a query string carrying a secret, a cookie or a header. The Domexa client is GET-only by construction: one private `send`, one literal exception (`POST /api/auth/login`), and an exported `assertReadOnly(method, path)` that throws for anything else.

## Design addendum (decisions not spelled out in the spec)

1. **SheetJS is `xlsx@0.18.5` from npm — the Apache-2.0 community build.** That is the last version published to the npm registry (later versions ship only from the vendor's own CDN); pinning it exactly (`"xlsx": "0.18.5"`, no caret) keeps the lockfile reproducible and keeps a registry install working offline from the pnpm store. It is a `dependency` of `@domar/web` (the web build bundles it) and a `devDependency` of `@domar/e2e` (the spec writes a workbook). The API never sees it.
2. **The import is lazy: `const { read, utils } = await import('xlsx')` inside `apps/web/src/utils/spreadsheet.ts`, called only when the chosen file's name ends in `.xlsx` or `.xls`, or when the operator clicks "Map columns".** The package is ~7 MB unpacked and would otherwise sit in the first chunk of every page load, including the owner portal's. The image grows by roughly the same amount because the runtime stage copies `/app` whole; that is accepted, and noted here so nobody hunts for it later.
2b. **Two interop facts about `xlsx@0.18.5`, because they decide how each environment imports it.** The package has **no `exports` map**: `module` points at `xlsx.mjs` (real ESM, **named exports only, no default export**) and `main` points at `xlsx.js` (CJS whose exports are attached by a function call, so Node's `cjs-module-lexer` detects no named exports). Therefore: (a) Vite and vite-node pick `module`, so the web source and the web test use named/namespace imports; (b) native Node picks `main`, so **`e2e/tests/import-xlsx.spec.ts` uses a default import** (`import XLSX from 'xlsx'`), which Node's CJS interop always fills; (c) Vitest externalises node_modules and would hand the component the CJS build under jsdom, so `apps/web/vitest.config.ts` gains `server: { deps: { inline: ['xlsx'] } }` — one line that makes both the test's `import * as XLSX` and the component's `await import('xlsx')` resolve to the same ESM build. Without it the destructuring in `readWorkbookRows` gets `undefined` under Vitest while working perfectly in the browser.
3. **First sheet only.** `workbook.SheetNames[0]`. A manager whose second sheet holds the real data renames or reorders the sheets; a sheet picker is a feature nobody asked for, and the file name is shown so a wrong pick is visible in the preview.
4. **The header row is the first row with at least one non-empty cell**, and every row after it that is entirely empty is dropped. `sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: false })` gives that with one pass; `raw: false` is deliberate — it returns each cell **as the spreadsheet displays it**, so a date stays `31.12.2025`, an amount stays `1.200,00`, and a number formatted with two decimals does not arrive as `1200.0000000001`. Every cell is then `String(...)`-ed and trimmed, so the mapping step and the parser both see plain text, exactly as the CSV path does.
5. **The CSV path is unchanged by default.** A `.csv` file is still read with `FileReader.readAsText` and its text is posted byte-for-byte (the API strips the BOM, sniffs `;` vs `,` and accepts both locales' decimals). The mapping step is opt-in for CSV, behind a "Map columns" button (`import-map-open`), for the file whose header the parser does not recognise. Nothing about the existing two tests in `apps/web/test/ImportTab.test.ts` changes.
6. **Mapping is stored per browser under `localStorage['domar.importMapping.<hash>']`, where `<hash>` is an 8-hex FNV-1a of the trimmed, lower-cased, sorted source headers joined with `|`.** Sorting makes the key survive a column reordering; the stored value maps each target field to the **source header text**, not to a column index, so the recalled mapping also survives a reordering. Every read and every write is wrapped in `try/catch` — a private window with storage disabled must still import.
7. **A target mapped twice is an error, not a silent last-wins.** "Number" and "Label" both pointing at column 3 means the operator mis-clicked; the message names the offending target fields. A source column mapped nowhere is fine and is listed (`import-unmapped`) so a forgotten "Почетно салдо" is visible before the commit rather than after it.
8. **`rowsToCanonicalCsv` writes the Macedonian canonical header** — `број;кат;тип;површина;удел;име;презиме;е-пошта;телефон;почетно салдо` — the same line `ImportTab.vue`'s downloadable template already carries. The template constant is rebuilt from the exported `CANONICAL_HEADER` so the two cannot drift.
9. **Quoting, and what happens to a newline inside a cell.** A cell is wrapped in `"` when it contains `;` or `"`, and every `"` inside is doubled. A cell's own line breaks (`\r\n`, `\r`, `\n` — Alt+Enter in Excel) are collapsed to a single space **before** quoting. This is a deliberate departure from RFC 4180: `parseUnitImport` splits the file into lines before it splits a line into cells, so a quoted newline would split one unit into two rows. A unit label or an owner's surname has no business containing a line break, and collapsing it is visible in the preview table.
10. **The kind column of a generated CSV carries the canonical English `UnitKind`** (`apartment`, `commercial`, `parking`, `storage`, `other`), not a Macedonian label. The value is a domain enum member, `normaliseKind` accepts it in either locale, and emitting it avoids a second label table that would have to stay in sync with the alias table. The *headers* stay Macedonian because a human reads them.
11. **Domexa numbers arrive as either a JSON number or a string, and both are handled in one place** (`domexaAmountToMinor`). A number is `Math.round(v * 100)`. A string that already looks canonical (`/^-?\d+(\.\d+)?$/`, the shape `"18.00"` and `"1234.56"` were observed on `/api/tax-rates`) goes straight to `mkPack.parseAmountToMinor`. Any other string is first normalised with the separators from `/api/organization` (`thousandSeparator: "."`, `decimalSeparator: ","` on the demo account): thousands separators are removed, the decimal separator becomes `.`, and the result goes to the same parser. Unparseable → `null`, and the caller records a report entry instead of throwing (§20.3).
12. **Percent × 100 = basis points.** A Domexa tax rate `"18.00"` through `domexaAmountToMinor` is `1800`, which is exactly domar's `rateBp`. That pun is used on purpose and is asserted in the test so a future reader does not "fix" it.
13. **The opening balance is the contact statement's closing balance, positive = the owner owes**, matching §17.1's sign convention (`positive = owner owes`) and the manager-facing meaning of a Domexa statement. It is read from the first of `closingBalance`, `balance`, `outstandingBalance`, `totalOutstanding`, `closing.balance` that is present; absent or unparseable → `0` plus a report note.
14. **An owner's opening balance is written on their *first* unit only.** The import books one posting per row with a non-zero balance, so repeating a contact's closing balance on their three units would triple their debt. Later rows for the same owner carry `0` and the report says where the balance went.
15. **A Domexa unit's `type` is resolved by `normaliseKind` first** (which already knows `apartment`/`стан`, `commercial`/`деловен`, `parking`/`паркинг`, `storage`/`подрум`/`остава`, `other`/`друго`), and only then by `DOMEXA_UNIT_KINDS`, a guess table for the English words the Domexa guide's five types suggest (`flat`, `residential`, `office`, `business`, `shop`, `garage`, `basement`, `cellar`, …). Anything left over becomes `other` and is reported by name, so one glance at `report.md` says what to add to the table.
16. **A Domexa service's pricing model maps to domar's three**: `fixed_per_unit` ← `fixed_per_unit`/`fixed`/`per_unit`/`fixedPerUnit`/`по единица`; `per_m2` ← `per_m2`/`perM2`/`area`/`by_area`/`по m2`/`по м2`; `shared_total` ← `shared_total`/`shared`/`total`/`split`/`заедничко`. Unknown → `fixed_per_unit` with a report note, because that is the model that charges every covered unit the stated amount and is therefore the one whose mistake is most visible on the first invoice.
17. **The transform cannot know domar's ids, so it emits names.** `services.json` carries `taxRateName`, `building-services.json` carries `serviceName` and `buildingKey`, `reserve-fund.json` carries `buildingKey`. `apply` resolves each name against the target tenant. `buildingKey` is the Domexa building id with every character outside `[A-Za-z0-9_-]` replaced by `-`; it is also the suffix of `units-<buildingKey>.csv`.
18. **Idempotency keys, one per entity:** tax rate by `name`, service by `name`, building by `name`, unit by `label` within the building (delegated to the import's own `mode: 'skip'`), building service by `serviceId` within the building, reserve-fund setting by "PUT is idempotent", reserve-fund opening balance by "only when the fund's balance is exactly 0". Contacts are matched by the import itself (email, else exact first+last name), so a second run creates none.
19. **`apply` talks HTTP, never Drizzle.** Everything it does is available as a route, the routes carry the tenant filter, the role check and the audit row, and an HTTP client is what a future "migrate into production" run needs anyway. This is why the module takes an injectable `fetchImpl` and a `baseUrl`, and why its test starts the real server with `app.listen({ port: 0 })` instead of using `app.inject`.
20. **The Domexa base URL is one variable.** §20.2 writes the API as `https://domexa.mk/<org>/api`, while the observed login page takes the org as a form field and the bundle's paths all start at `/api/`. `DOMEXA_BASE_URL` (default `https://domexa.mk`) is joined with the literal paths, so if the real deployment nests the API under the org, setting `DOMEXA_BASE_URL=https://domexa.mk/<org>` covers it with no code change. The login body is `{ tenantSlug, email, password }` — the same three fields domar's own login takes and the same three the Domexa login form shows. Both are flagged as guesses in `docs/MIGRATION.md`; when Turnstile blocks the API login, `DOMEXA_COOKIE` (a session cookie captured from a logged-in browser) skips the login entirely.
21. **Task 4 of the spec is split across two tasks here** (client + export, then transform + apply). Together they are ~800 lines; separately each is independently testable — the client against a stubbed `fetch`, the apply against a listening test server — and neither depends on the other's internals, only on the file layout of `domexa-export/`.

---

### Task 1: Domain — shared header/kind aliases and the canonical CSV writer

**Files:**
- Modify: `packages/domain/src/import/units.ts`
- Create: `packages/domain/src/import/serialize.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/domain/src/statements/index.ts`
- Modify: `packages/domain/test/unit-import.test.ts`
- Create: `packages/domain/test/import-serialize.test.ts`

**Interfaces (consumed by Tasks 2, 3, 5 and 6):**
- `type ImportField = 'label' | 'floor' | 'kind' | 'areaM2' | 'ownershipShare' | 'ownerFirstName' | 'ownerLastName' | 'ownerEmail' | 'ownerPhone' | 'openingBalance'` — exported (it was the file-private `Field`).
- `IMPORT_FIELDS: readonly ImportField[]` — the ten fields in canonical column order.
- `matchImportHeader(name: string): ImportField | null` — the alias table `parseUnitImport` already uses, trimmed/lower-cased/whitespace-collapsed.
- `normaliseKind(value: string): UnitKind | null` — the kind alias table, same normalisation.
- `CANONICAL_HEADER: string` — `'број;кат;тип;површина;удел;име;презиме;е-пошта;телефон;почетно салдо'`.
- `emptyImportRow(): Record<ImportField, string>` — all ten fields, all `''`.
- `rowsToCanonicalCsv(rows: Record<ImportField, string>[]): string` — header + rows + trailing `\n`.
- `splitCsvLine(line, delim)` becomes reachable from the package root (re-exported by `statements/index.ts`); Task 2 needs it for the CSV mapping path.
- `parseUnitImport` keeps its exact signature and behaviour; the existing 98 domain tests must stay green.

- [ ] **Step 1: Write the failing test**

Append two `describe` blocks to `packages/domain/test/unit-import.test.ts` (keep the existing import line and add the new names to it):

```ts
import { IMPORT_FIELDS, matchImportHeader, normaliseKind, parseUnitImport } from '../src/import/units.js';
```

```ts
describe('matchImportHeader', () => {
  it('accepts both locales, ignores case, padding and repeated spaces', () => {
    expect(matchImportHeader('  Е-Пошта ')).toBe('ownerEmail');
    expect(matchImportHeader('епошта')).toBe('ownerEmail');
    expect(matchImportHeader('ownerFirstName')).toBe('ownerFirstName');
    expect(matchImportHeader('Почетно  салдо')).toBe('openingBalance');
    expect(matchImportHeader('AreaM2')).toBe('areaM2');
    expect(matchImportHeader('Опис')).toBeNull();
    expect(matchImportHeader('')).toBeNull();
  });

  it('lists the ten target fields in canonical column order', () => {
    expect(IMPORT_FIELDS).toEqual([
      'label', 'floor', 'kind', 'areaM2', 'ownershipShare',
      'ownerFirstName', 'ownerLastName', 'ownerEmail', 'ownerPhone', 'openingBalance',
    ]);
  });
});

describe('normaliseKind', () => {
  it('maps both locales onto the unit kinds and refuses the rest', () => {
    expect(normaliseKind('  Деловен Простор ')).toBe('commercial');
    expect(normaliseKind('СТАН')).toBe('apartment');
    expect(normaliseKind('storage')).toBe('storage');
    expect(normaliseKind('остава')).toBe('storage');
    expect(normaliseKind('кутија')).toBeNull();
  });
});
```

Create `packages/domain/test/import-serialize.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CANONICAL_HEADER, emptyImportRow, rowsToCanonicalCsv } from '../src/import/serialize.js';
import { parseUnitImport } from '../src/import/units.js';

describe('rowsToCanonicalCsv', () => {
  it('writes the Macedonian canonical header even for no rows', () => {
    expect(CANONICAL_HEADER).toBe('број;кат;тип;површина;удел;име;презиме;е-пошта;телефон;почетно салдо');
    expect(rowsToCanonicalCsv([])).toBe(`${CANONICAL_HEADER}\n`);
  });

  it('writes one line per row in canonical column order', () => {
    const csv = rowsToCanonicalCsv([
      { ...emptyImportRow(), label: '1', floor: '1', kind: 'apartment', areaM2: '54,5', ownershipShare: '0,085', ownerFirstName: 'Марко', ownerLastName: 'Марков', ownerEmail: 'marko@example.mk', ownerPhone: '070111222', openingBalance: '1.200,00' },
      { ...emptyImportRow(), label: 'P-1', kind: 'parking' },
    ]);
    expect(csv).toBe(
      `${CANONICAL_HEADER}\n`
      + '1;1;apartment;54,5;0,085;Марко;Марков;marko@example.mk;070111222;1.200,00\n'
      + 'P-1;;parking;;;;;;;\n',
    );
  });

  it('quotes a cell with a semicolon or a quote, doubles the quote and flattens a line break', () => {
    const csv = rowsToCanonicalCsv([
      { ...emptyImportRow(), label: 'A;1', floor: '1\n2', kind: 'apartment', ownerLastName: 'Марков "Мар"', openingBalance: '0' },
    ]);
    expect(csv).toBe(`${CANONICAL_HEADER}\n"A;1";1 2;apartment;;;;"Марков ""Мар""";;;0\n`);
  });

  it('round-trips through the parser it feeds', () => {
    const csv = rowsToCanonicalCsv([
      { ...emptyImportRow(), label: 'A;1', kind: 'apartment', areaM2: '54.5', ownerLastName: 'Марков "Мар"', openingBalance: '-450.50' },
    ]);
    const { rows, errors } = parseUnitImport(csv);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: 'A;1', kind: 'apartment', areaM2: 54.5, ownerLastName: 'Марков "Мар"', openingBalanceMinor: -45050 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @domar/domain test`
Expected: FAIL — `Failed to resolve import "../src/import/serialize.js"` and `matchImportHeader is not a function`.

- [ ] **Step 3: Implement**

In `packages/domain/src/import/units.ts`, replace the `type Field = …` declaration and the two alias tables with the exported forms, and route the parser through them. Replace this block:

```ts
type Field =
  | 'label' | 'floor' | 'kind' | 'areaM2' | 'ownershipShare'
  | 'ownerFirstName' | 'ownerLastName' | 'ownerEmail' | 'ownerPhone' | 'openingBalance';

const HEADERS: Record<string, Field> = {
```

with:

```ts
export type ImportField =
  | 'label' | 'floor' | 'kind' | 'areaM2' | 'ownershipShare'
  | 'ownerFirstName' | 'ownerLastName' | 'ownerEmail' | 'ownerPhone' | 'openingBalance';

/** The ten target columns, in the order the canonical template writes them. */
export const IMPORT_FIELDS: readonly ImportField[] = [
  'label', 'floor', 'kind', 'areaM2', 'ownershipShare',
  'ownerFirstName', 'ownerLastName', 'ownerEmail', 'ownerPhone', 'openingBalance',
];

const HEADERS: Record<string, ImportField> = {
```

Replace the two remaining `Field` mentions:

```ts
const KINDS: Record<string, UnitKind> = {
```
stays as it is, and

```ts
const LIMITS: Partial<Record<Field, number>> = { label: 50, floor: 20, ownerFirstName: 100, ownerLastName: 200, ownerEmail: 200, ownerPhone: 50 };
```
becomes

```ts
const LIMITS: Partial<Record<ImportField, number>> = { label: 50, floor: 20, ownerFirstName: 100, ownerLastName: 200, ownerEmail: 200, ownerPhone: 50 };
```

Directly after `const norm = …`, add the two lookups (they are the parser's own tables; the web mapping step and the Domexa transform read them through these functions rather than copying them):

```ts
/**
 * The target column a source header names, or null when the template does not know it. Exported so
 * the web's mapping step can prefill itself from the same aliases the parser accepts (spec §20.1).
 */
export function matchImportHeader(name: string): ImportField | null {
  return HEADERS[norm(name)] ?? null;
}

/** The unit kind a source value names, in either locale, or null. */
export function normaliseKind(value: string): UnitKind | null {
  return KINDS[norm(value)] ?? null;
}
```

Inside `parseUnitImport`, replace the three table reads with the functions:

```ts
  const cols = headerCells.map((c) => matchImportHeader(c));
```
```ts
    if (name !== '' && matchImportHeader(c) === null) errors.push({ line: headerIdx + 1, message: `unknown column: ${name}` });
```
```ts
    const kind = normaliseKind(kindRaw);
```

and change the two local signatures that mention `Field`:

```ts
  const at = (f: ImportField): number => cols.indexOf(f);
```
```ts
    const cell = (f: ImportField): string => { const j = at(f); return j === -1 ? '' : (cells[j] ?? '').trim(); };
```
```ts
    const tooLong = (Object.keys(LIMITS) as ImportField[]).find((f) => cell(f).length > LIMITS[f]!);
```

Create `packages/domain/src/import/serialize.ts`:

```ts
import { IMPORT_FIELDS, type ImportField } from './units.js';

/** The header `parseUnitImport` reads back, and the one the downloadable template carries. */
export const CANONICAL_HEADER = 'број;кат;тип;површина;удел;име;презиме;е-пошта;телефон;почетно салдо';

/** A row with every target column present and empty; callers fill in what they mapped. */
export function emptyImportRow(): Record<ImportField, string> {
  return Object.fromEntries(IMPORT_FIELDS.map((f) => [f, ''])) as Record<ImportField, string>;
}

/**
 * A cell's own line breaks are flattened to one space before quoting: `parseUnitImport` splits the
 * file into lines before it splits a line into cells, so a quoted newline would cut one unit in two.
 */
function cell(value: string): string {
  const flat = value.replace(/\r\n|[\r\n]/g, ' ');
  return /[;"]/.test(flat) ? `"${flat.replace(/"/g, '""')}"` : flat;
}

/** Mapped cells → the canonical `;` CSV the units import accepts. The inverse of `parseUnitImport`. */
export function rowsToCanonicalCsv(rows: Record<ImportField, string>[]): string {
  const lines = rows.map((r) => IMPORT_FIELDS.map((f) => cell(r[f] ?? '')).join(';'));
  return [CANONICAL_HEADER, ...lines, ''].join('\n');
}
```

In `packages/domain/src/index.ts`, add the serializer next to the parser:

```ts
export * from './import/units.js';
export * from './import/serialize.js';
```

In `packages/domain/src/statements/index.ts`, widen the csv re-export so the web can split a delimited line with the same code the parser uses:

```ts
export { csvParser, splitCsvLine } from './csv.js';
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @domar/domain test && pnpm --filter @domar/domain typecheck && pnpm lint`
Expected: PASS — 11 files, 109 tests (the 98 that existed plus 4 serializer + 7 assertions across the 3 new cases; the count line must read `Tests  109 passed` or more, and no previously passing test may change).

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): share the import aliases and write the canonical CSV" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Web — read a spreadsheet and map its columns onto the template

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/vitest.config.ts`
- Create: `apps/web/src/utils/spreadsheet.ts`
- Modify: `apps/web/src/components/building/ImportTab.vue`
- Modify: `apps/web/src/i18n/mk.ts`
- Modify: `apps/web/src/i18n/en.ts`
- Modify: `apps/web/test/ImportTab.test.ts`

**Interfaces:**
- Consumes from Task 1: `matchImportHeader`, `normaliseKind` (unused here — the server reports unknown kinds per row), `IMPORT_FIELDS`, `ImportField`, `CANONICAL_HEADER`, `emptyImportRow`, `rowsToCanonicalCsv`, `splitCsvLine`, all from `@domar/domain`.
- Produces for Task 6 (`e2e/tests/import-xlsx.spec.ts`): `data-test` hooks `import-map-open`, `import-map-<field>` (ten of them, `import-map-label` … `import-map-openingBalance`), `import-map-apply`, `import-map-error`, `import-map-ready`, `import-unmapped`. Every `import-map-<field>` is a `<select>` whose option values are the source column index as a string, `''` for "do not import".
- Produces for its own test: `apps/web/src/utils/spreadsheet.ts` exports `readWorkbookRows(file: File): Promise<string[][]>`, `splitDelimitedRows(text: string): string[][]` and `mappingKey(headers: string[]): string`.
- The API contract is untouched: the preview/commit body stays `{ content, mode, dryRun?, force? }` against `POST /api/buildings/:buildingId/import/units`.

- [ ] **Step 1: Write the failing test**

Add `xlsx` to `apps/web/package.json` first (the test imports it):

```json
  "dependencies": {
    "@domar/domain": "workspace:*",
    "pinia": "^2.2.4",
    "vue": "^3.5.12",
    "vue-i18n": "^10.0.4",
    "vue-router": "^4.4.5",
    "xlsx": "0.18.5"
  },
```

and make Vitest resolve `xlsx` through Vite rather than through Node, so the test and the component share the ESM build (design addendum 2b) — `apps/web/vitest.config.ts` becomes:

```ts
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // `xlsx` has no exports map: Node would load its CJS build, whose exports are attached by a
  // function call, so `import { read, utils }` would be undefined under jsdom. Inlining makes Vite
  // resolve the `module` field (xlsx.mjs) here exactly as it does in the browser build.
  test: { environment: 'jsdom', globals: false, setupFiles: ['./test/setup.ts'], server: { deps: { inline: ['xlsx'] } } },
});
```

Run `pnpm install` once, then append to `apps/web/test/ImportTab.test.ts` (extend the existing import list at the top with the two new imports):

```ts
import * as XLSX from 'xlsx';
import { mappingKey } from '@/utils/spreadsheet';
```

```ts
const AOA = [
  ['Стан', 'Кат', 'Намена', 'Квадратура', 'Сопственик', 'Презиме', 'Маил'],
  ['1', '1', 'стан', '54,5', 'Марко', 'Марков', 'marko@example.mk'],
  ['2', '1', 'стан', '62', 'Ана', 'Бошковска', 'ana@example.mk'],
];

const HEADER = 'број;кат;тип;површина;удел;име;презиме;е-пошта;телефон;почетно салдо';
const MAPPED_CSV = `${HEADER}\n`
  + '1;1;стан;54,5;;Марко;Марков;;;\n'
  + '2;1;стан;62;;Ана;Бошковска;;;\n';

function xlsxFile(): File {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(AOA), 'Единици');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new File([new Uint8Array(buf)], 'единици.xlsx');
}

async function choose(w: ReturnType<typeof mount>, file: File) {
  const input = w.get('[data-test=import-file]');
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
  await input.trigger('change');
}

describe('ImportTab column mapping', () => {
  afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

  it('reads an xlsx, prefills what it recognises and previews the canonical CSV', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(preview));
    vi.stubGlobal('fetch', fetchMock);

    const w = mount(ImportTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    await choose(w, xlsxFile());
    // The mapping step opens by itself for a spreadsheet.
    await vi.waitFor(() => expect(w.find('[data-test=import-map-label]').exists()).toBe(true));

    // "Кат" and "Презиме" are header aliases, so they arrive already mapped.
    expect((w.get('[data-test=import-map-floor]').element as HTMLSelectElement).value).toBe('1');
    expect((w.get('[data-test=import-map-ownerLastName]').element as HTMLSelectElement).value).toBe('5');
    expect((w.get('[data-test=import-map-label]').element as HTMLSelectElement).value).toBe('');

    await w.get('[data-test=import-map-label]').setValue('0');
    await w.get('[data-test=import-map-kind]').setValue('2');
    await w.get('[data-test=import-map-areaM2]').setValue('3');
    await w.get('[data-test=import-map-ownerFirstName]').setValue('4');
    expect(w.get('[data-test=import-unmapped]').text()).toContain('Маил');

    await w.get('[data-test=import-map-apply]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=import-map-ready]').exists()).toBe(true));

    await w.get('[data-test=import-preview]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ content: MAPPED_CSV, mode: 'fail', dryRun: true });
  });

  it('refuses two targets on one column and never sends anything', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(preview));
    vi.stubGlobal('fetch', fetchMock);

    const w = mount(ImportTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    await choose(w, xlsxFile());
    await vi.waitFor(() => expect(w.find('[data-test=import-map-label]').exists()).toBe(true));

    await w.get('[data-test=import-map-label]').setValue('0');
    await w.get('[data-test=import-map-kind]').setValue('0');
    await w.get('[data-test=import-map-apply]').trigger('click');

    expect(w.get('[data-test=import-map-error]').text()).toContain('иста колона');
    expect(w.find('[data-test=import-map-ready]').exists()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names the required targets when they are missing', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const w = mount(ImportTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    await choose(w, xlsxFile());
    await vi.waitFor(() => expect(w.find('[data-test=import-map-label]').exists()).toBe(true));

    await w.get('[data-test=import-map-apply]').trigger('click');
    expect(w.get('[data-test=import-map-error]').text()).toContain('број');
  });

  it('remembers a mapping per header set and recalls it by header name', async () => {
    const key = mappingKey(AOA[0]!);
    expect(key).toMatch(/^domar\.importMapping\.[0-9a-f]{8}$/);
    expect(mappingKey(['b', 'a'])).toBe(mappingKey(['A', ' b '])); // sorted, trimmed, case-folded
    localStorage.setItem(key, JSON.stringify({ label: 'Стан', kind: 'Намена', areaM2: 'Квадратура', ownerFirstName: 'Сопственик' }));

    const fetchMock = vi.fn().mockResolvedValue(json(preview));
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(ImportTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    await choose(w, xlsxFile());
    await vi.waitFor(() => expect(w.find('[data-test=import-map-label]').exists()).toBe(true));

    expect((w.get('[data-test=import-map-label]').element as HTMLSelectElement).value).toBe('0');
    expect((w.get('[data-test=import-map-kind]').element as HTMLSelectElement).value).toBe('2');

    await w.get('[data-test=import-map-apply]').trigger('click');
    await w.get('[data-test=import-preview]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).content).toBe(MAPPED_CSV);
  });

  it('maps a CSV whose header the parser does not know', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(preview));
    vi.stubGlobal('fetch', fetchMock);

    const w = mount(ImportTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    await choose(w, new File(['Стан;Кат;Намена\n1;1;стан\n'], 'units.csv', { type: 'text/csv' }));
    expect(w.find('[data-test=import-map-label]').exists()).toBe(false); // the CSV path stays as it was

    await w.get('[data-test=import-map-open]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=import-map-label]').exists()).toBe(true));
    await w.get('[data-test=import-map-label]').setValue('0');
    await w.get('[data-test=import-map-kind]').setValue('2');
    await w.get('[data-test=import-map-apply]').trigger('click');
    await w.get('[data-test=import-preview]').trigger('click');

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).content).toBe(`${HEADER}\n1;1;стан;;;;;;;\n`);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @domar/web test`
Expected: FAIL — `Failed to resolve import "@/utils/spreadsheet"`; the two pre-existing `ImportTab` tests still pass.

- [ ] **Step 3: Implement**

Create `apps/web/src/utils/spreadsheet.ts`:

```ts
import { splitCsvLine } from '@domar/domain';

/** Every cell as text, trimmed; fully empty rows dropped. */
function tidy(rows: unknown[][]): string[][] {
  return rows
    .map((r) => r.map((c) => String(c ?? '').trim()))
    .filter((r) => r.some((c) => c !== ''));
}

function readArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/**
 * The first sheet of a workbook as text rows. SheetJS is ~7 MB, so it is imported only when a
 * spreadsheet is actually chosen (spec §20.1). `raw: false` returns each cell as the spreadsheet
 * displays it, so dates and amounts keep the formatting the operator sees.
 */
export async function readWorkbookRows(file: File): Promise<string[][]> {
  const { read, utils } = await import('xlsx');
  const wb = read(new Uint8Array(await readArrayBuffer(file)), { type: 'array' });
  const name = wb.SheetNames[0];
  const sheet = name ? wb.Sheets[name] : undefined;
  if (!sheet) return [];
  return tidy(utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '', blankrows: false }));
}

/** A delimited text file as rows, with the same `;`-over-`,` sniffing the parser uses. */
export function splitDelimitedRows(text: string): string[][] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const first = lines.find((l) => l.trim() !== '') ?? '';
  const delim = first.split(';').length >= first.split(',').length ? ';' : ',';
  return tidy(lines.filter((l) => l.trim() !== '').map((l) => splitCsvLine(l, delim)));
}

/**
 * Where this file's mapping is remembered. The headers are sorted, so a reordered file keeps its
 * mapping; the stored value maps a target field to a header *name*, so the reordering survives too.
 */
export function mappingKey(headers: string[]): string {
  const joined = headers.map((h) => h.trim().toLowerCase()).sort().join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `domar.importMapping.${(h >>> 0).toString(16).padStart(8, '0')}`;
}

export function loadMapping(headers: string[]): Record<string, string> {
  try {
    const raw = localStorage.getItem(mappingKey(headers));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function saveMapping(headers: string[], byField: Record<string, string>): void {
  try {
    localStorage.setItem(mappingKey(headers), JSON.stringify(byField));
  } catch {
    // A private window with storage disabled must still be able to import.
  }
}
```

In `apps/web/src/components/building/ImportTab.vue`, replace the whole `<script setup>` block's head (imports, `TEMPLATE`, state) and add the mapping functions. The new script section reads:

```ts
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { CANONICAL_HEADER, emptyImportRow, IMPORT_FIELDS, type ImportField, matchImportHeader, rowsToCanonicalCsv } from '@domar/domain';
import { api } from '@/api/client';
import type { UnitImportResult } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import AppButton from '@/components/ui/AppButton.vue';
import { formatMoney } from '@/utils/money';
import { loadMapping, readWorkbookRows, saveMapping, splitDelimitedRows } from '@/utils/spreadsheet';

const TEMPLATE = `${CANONICAL_HEADER}\n`
  + '1;1;стан;54,5;0,085;Марко;Марков;marko@example.mk;070111222;1.200,00\n'
  + '2;1;стан;62;0,095;Ана;Бошковска;ana@example.mk;;0\n'
  + 'P-1;;паркинг;;;;;;;\n';

const props = defineProps<{ buildingId: string }>();
const emit = defineEmits<{ imported: [] }>();
const { t } = useI18n();
const url = `/api/buildings/${props.buildingId}/import/units`;
const file = ref<File | null>(null);
const fileName = ref('');
const mode = ref<'fail' | 'skip'>('fail');
const result = ref<UnitImportResult | null>(null);
const done = ref(false);
const error = ref('');
const busy = ref(false);
const force = ref(false);

const fields = IMPORT_FIELDS;
const mapOpen = ref(false);
const sourceHeaders = ref<string[]>([]);
const sourceRows = ref<string[][]>([]);
const mapping = ref<Record<ImportField, string>>(blankMapping());
const mappedCsv = ref<string | null>(null);
const mapError = ref('');

function blankMapping(): Record<ImportField, string> {
  return Object.fromEntries(IMPORT_FIELDS.map((f) => [f, ''])) as Record<ImportField, string>;
}
```

Keep `readText`, `resetPreview`, `fail`, `preview`, `commit` and `downloadTemplate` exactly as they are, and change only `onFile` and `buildBody`:

```ts
function onFile(e: Event) {
  file.value = (e.target as HTMLInputElement).files?.[0] ?? null;
  fileName.value = file.value?.name ?? '';
  mapOpen.value = false;
  mappedCsv.value = null;
  mapError.value = '';
  sourceHeaders.value = [];
  sourceRows.value = [];
  mapping.value = blankMapping();
  resetPreview();
  // A spreadsheet has no canonical header, so mapping is the only way in; a CSV keeps its old path.
  if (file.value && /\.xlsx?$/i.test(file.value.name)) void openMapping();
}

/** The mapped rows win when a mapping was applied; otherwise the file's own text is sent unchanged. */
async function buildBody(dryRun: boolean): Promise<{ content: string; mode: 'fail' | 'skip'; dryRun?: true; force?: true }> {
  const content = mappedCsv.value ?? await readText(file.value as File);
  const body: { content: string; mode: 'fail' | 'skip'; dryRun?: true; force?: true } = { content, mode: mode.value };
  if (dryRun) body.dryRun = true;
  if (force.value) body.force = true;
  return body;
}
```

Add the mapping functions after `buildBody`:

```ts
async function openMapping() {
  if (!file.value) { error.value = t('imports.chooseFile'); return; }
  busy.value = true; error.value = ''; mapError.value = '';
  try {
    const rows = /\.xlsx?$/i.test(file.value.name)
      ? await readWorkbookRows(file.value)
      : splitDelimitedRows(await readText(file.value));
    sourceHeaders.value = rows[0] ?? [];
    sourceRows.value = rows.slice(1);
    mapping.value = prefill(sourceHeaders.value);
    mapOpen.value = true;
    mappedCsv.value = null;
    resetPreview();
  } catch {
    error.value = t('imports.map.readError');
  } finally {
    busy.value = false;
  }
}

/** Remembered mapping first (by header name), then the parser's own header aliases. */
function prefill(headers: string[]): Record<ImportField, string> {
  const remembered = loadMapping(headers);
  const next = blankMapping();
  for (const f of IMPORT_FIELDS) {
    const byName = remembered[f] ? headers.indexOf(remembered[f]!) : -1;
    if (byName >= 0) { next[f] = String(byName); continue; }
    const byAlias = headers.findIndex((h) => matchImportHeader(h) === f);
    if (byAlias >= 0) next[f] = String(byAlias);
  }
  return next;
}

function unmappedHeaders(): string[] {
  const used = new Set(Object.values(mapping.value).filter((v) => v !== ''));
  return sourceHeaders.value.filter((_, i) => !used.has(String(i)));
}

function applyMapping() {
  mapError.value = '';
  const seen = new Map<string, ImportField>();
  const clash: string[] = [];
  for (const f of IMPORT_FIELDS) {
    const v = mapping.value[f];
    if (v === '') continue;
    const first = seen.get(v);
    if (first) clash.push(`${t(`imports.map.fields.${first}`)} + ${t(`imports.map.fields.${f}`)}`);
    else seen.set(v, f);
  }
  if (clash.length > 0) { mapError.value = t('imports.map.duplicate', { fields: clash.join(', ') }); return; }
  if (mapping.value.label === '' || mapping.value.kind === '') { mapError.value = t('imports.map.required'); return; }

  mappedCsv.value = rowsToCanonicalCsv(sourceRows.value.map((cells) => {
    const row = emptyImportRow();
    for (const f of IMPORT_FIELDS) {
      const i = mapping.value[f];
      if (i !== '') row[f] = cells[Number(i)] ?? '';
    }
    return row;
  }));
  saveMapping(sourceHeaders.value, Object.fromEntries(
    IMPORT_FIELDS.filter((f) => mapping.value[f] !== '').map((f) => [f, sourceHeaders.value[Number(mapping.value[f])] ?? '']),
  ));
  mapOpen.value = false;
  resetPreview();
}
```

In the template, change the file input's `accept` and label and add the "Map columns" button next to the template button:

```html
    <label class="text-sm">
      <span class="mb-1 block font-medium text-slate-700">{{ t('imports.file') }}</span>
      <input type="file" accept=".csv,.xlsx,.xls,text/csv" data-test="import-file" @change="onFile" />
    </label>
```
```html
    <AppButton variant="secondary" :disabled="!file" data-test="import-map-open" @click="openMapping">{{ t('imports.map.open') }}</AppButton>
```

and insert the mapping panel directly after the toolbar `</div>`, before the `import-error` paragraph:

```html
  <div v-if="mapOpen" class="mb-4 rounded-xl bg-white p-4 shadow-sm" data-test="import-map">
    <h3 class="mb-3 font-medium text-slate-700">{{ t('imports.map.title') }} — {{ fileName }}</h3>
    <div class="mb-3 grid grid-cols-2 gap-3 md:grid-cols-5">
      <label v-for="f in fields" :key="f" class="text-sm">
        <span class="mb-1 block text-slate-600">{{ t(`imports.map.fields.${f}`) }}</span>
        <select v-model="mapping[f]" :data-test="`import-map-${f}`" class="w-full rounded-md border border-slate-300 bg-white px-2 py-1">
          <option value="">{{ t('imports.map.none') }}</option>
          <option v-for="(h, i) in sourceHeaders" :key="i" :value="String(i)">{{ h }}</option>
        </select>
      </label>
    </div>
    <p v-if="unmappedHeaders().length" class="mb-3 text-sm text-slate-500" data-test="import-unmapped">
      {{ t('imports.map.unmapped') }}: {{ unmappedHeaders().join(', ') }}
    </p>
    <p v-if="mapError" class="mb-3 text-sm text-red-600" data-test="import-map-error">{{ mapError }}</p>
    <AppButton data-test="import-map-apply" @click="applyMapping">{{ t('imports.map.apply') }}</AppButton>
  </div>
  <p v-if="mappedCsv && !mapOpen" class="mb-2 text-sm text-emerald-800" data-test="import-map-ready">
    {{ t('imports.map.ready', { rows: sourceRows.length }) }}
  </p>
```

In `apps/web/src/i18n/mk.ts`, replace the `file` entry and append the `map` block inside `imports`:

```ts
  imports: {
    title: 'Увоз', file: 'Датотека (CSV, XLSX)', mode: 'Постоечки броеви', modeFail: 'Прекини', modeSkip: 'Прескокни',
    preview: 'Преглед', commit: 'Увези', template: 'Преземи шаблон', errors: 'Грешки во датотеката', line: 'Ред',
    conflicts: 'Постоечки броеви', chooseFile: 'Изберете датотека.',
    counts: { units: 'Единици', contacts: 'Нови / постоечки контакти', balances: 'Почетни салда', conflicts: 'Конфликти' },
    done: 'Увезени се {units} единици, {contacts} нови контакти и {balances} почетни салда.',
    failure: {
      label_conflict: 'Овие единици веќе постојат: {labels}. Изберете „прескокни“ или сменете ги броевите.',
      period_published: 'Зградата има објавен период; означете „Внеси почетни салда и покрај објавен период“ за да продолжите.',
      too_many_rows: 'Датотеката има повеќе од 5000 редови.',
    },
    map: {
      open: 'Мапирај колони', title: 'Поврзи ги колоните', none: '— не увезувај —', apply: 'Потврди мапирање',
      unmapped: 'Неповрзани колони од датотеката', ready: 'Колоните се поврзани: {rows} редови се подготвени за преглед.',
      duplicate: 'Две полиња покажуваат на иста колона: {fields}.',
      required: 'Мора да се поврзат „број“ и „тип“.',
      readError: 'Датотеката не може да се прочита.',
      fields: {
        label: 'Број', floor: 'Кат', kind: 'Тип', areaM2: 'Површина', ownershipShare: 'Удел',
        ownerFirstName: 'Име', ownerLastName: 'Презиме', ownerEmail: 'Е-пошта', ownerPhone: 'Телефон', openingBalance: 'Почетно салдо',
      },
    },
  },
```

In `apps/web/src/i18n/en.ts`, the same shape:

```ts
  imports: {
    title: 'Import', file: 'File (CSV, XLSX)', mode: 'Existing labels', modeFail: 'Stop', modeSkip: 'Skip',
    preview: 'Preview', commit: 'Import', template: 'Download template', errors: 'File errors', line: 'Line',
    conflicts: 'Existing labels', chooseFile: 'Choose a file.',
    counts: { units: 'Units', contacts: 'New / existing contacts', balances: 'Opening balances', conflicts: 'Conflicts' },
    done: 'Imported {units} units, {contacts} new contacts and {balances} opening balances.',
    failure: {
      label_conflict: 'These units already exist: {labels}. Choose “skip” or change the labels.',
      period_published: 'The building has a published period; tick “Enter opening balances despite a published period” to continue.',
      too_many_rows: 'The file has more than 5000 rows.',
    },
    map: {
      open: 'Map columns', title: 'Connect the columns', none: '— do not import —', apply: 'Apply mapping',
      unmapped: 'Columns left out of the import', ready: 'Columns connected: {rows} rows ready to preview.',
      duplicate: 'Two targets point at the same column: {fields}.',
      required: 'Both “label” and “kind” must be mapped.',
      readError: 'The file could not be read.',
      fields: {
        label: 'Label', floor: 'Floor', kind: 'Kind', areaM2: 'Area', ownershipShare: 'Ownership share',
        ownerFirstName: 'First name', ownerLastName: 'Last name', ownerEmail: 'Email', ownerPhone: 'Phone', openingBalance: 'Opening balance',
      },
    },
  },
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @domar/web test && pnpm --filter @domar/web typecheck && pnpm lint`
Expected: PASS — the two pre-existing `ImportTab` tests plus the five new ones, and `LoginPage.test.ts`'s mk/en parity assertion green.

- [ ] **Step 5: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): import xlsx files with a column mapping step" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Domain — the pure Domexa transforms

**Files:**
- Create: `packages/domain/src/migration/domexa.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/domain/test/domexa-migration.test.ts`

**Interfaces (consumed by Task 5):**
- `DEFAULT_FIELD_MAP: DomexaFieldMap` and `DEFAULT_SEPARATORS`, `separatorsFromOrganization(org)`.
- `domexaAmountToMinor(value: unknown, sep?): number | null` — string or number → integer minor units.
- `statementToOpeningBalance(statement: unknown, map?, sep?): number` — signed minor, positive = the owner owes.
- `domexaUnitsToImportRows(units, contactsById, statementsByContactId, map?, sep?) → { rows: Record<ImportField, string>[]; report: MigrationReport }`.
- `domexaTaxRatesToDomar(rows, sep?) → { rows: DomarTaxRatePlan[]; report }`.
- `domexaServicesToDomar(services, taxRates, map?, sep?) → { rows: DomarServicePlan[]; report }`.
- `domexaBuildingsToDomar(buildings, map?) → { rows: DomarBuildingPlan[]; report }` and `buildingKeyOf(id)`.
- `domexaBuildingServicesToDomar(rows, buildingKey, serviceNamesById, fallbackStartsPeriod, map?, sep?) → { rows: DomarBuildingServicePlan[]; report }`.
- `domexaReserveFundToDomar(buildingKey, setting, balance, map?, sep?) → { plan: DomarReserveFundPlan; report }`.
- `MigrationReport`, `emptyReport()`, `mergeReports(reports)`, `reportToMarkdown(report)`.
- Consumes from Task 1: `normaliseKind`, `IMPORT_FIELDS`, `ImportField`, `emptyImportRow`.
- **Every accessor tolerates a missing field, records it and never throws on a row** (§20.3). No function in this file touches I/O, `Date.now()` or `Math.random()`.

- [ ] **Step 1: Write the failing test**

Create `packages/domain/test/domexa-migration.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildingKeyOf, DEFAULT_SEPARATORS, domexaAmountToMinor, domexaBuildingServicesToDomar, domexaBuildingsToDomar,
  domexaReserveFundToDomar, domexaServicesToDomar, domexaTaxRatesToDomar, domexaUnitsToImportRows,
  mergeReports, reportToMarkdown, separatorsFromOrganization, statementToOpeningBalance,
} from '../src/migration/domexa.js';
import { rowsToCanonicalCsv } from '../src/import/serialize.js';
import { parseUnitImport } from '../src/import/units.js';

// Invented but plausible: the demo account was empty, so no real unit or contact row was observable.
const UNITS: unknown[] = [
  { id: 'u1', number: '1', floor: '1', type: 'apartment', areaM2: 54.5, ownerContactId: 'c1' },
  { id: 'u2', label: '2', floor: 1, type: 'стан', area: '62', attachedToUnitId: null,
    owner: { id: 'c2', firstName: 'Ана', lastName: 'Бошковска', email: 'ANA@example.mk', phone: '070222333' } },
  { id: 'u3', number: 'P-1', type: 'garage', ownerContactId: 'c1' },
  { id: 'u4', type: 'apartment', areaM2: 30 },
];
const CONTACTS = { c1: { id: 'c1', firstName: 'Марко', lastName: 'Марков', email: 'marko@example.mk', phone: '070111222' } };
const STATEMENTS = { c1: { closingBalance: '1234.56' }, c2: { balance: -450.5 } };

// Observed on /api/tax-rates of the demo account.
const TAX_RATES: unknown[] = [
  { id: '22a3a272-bc96-46dd-904a-c535340ff7dc', name: '/', rate: '0.00', isDefault: false, isActive: true },
  { id: 'd832b44b-6986-4b38-b2cb-df80c8277f97', name: 'ДДВ', rate: '18.00', isDefault: true, isActive: true },
];
const SERVICES: unknown[] = [
  { id: 's1', name: 'Чистење', categoryName: 'Чистење', pricingModel: 'fixed_per_unit', price: '300.00',
    taxRateId: 'd832b44b-6986-4b38-b2cb-df80c8277f97', appliesTo: ['apartment', 'commercial'], isRecurring: true },
  { id: 's2', name: 'Лифт', pricingModel: 'per_m2', price: 12.5, taxRateId: '22a3a272-bc96-46dd-904a-c535340ff7dc', appliesTo: [], isRecurring: true },
  { id: 's3', name: 'Заменета светилка', pricingModel: 'shared', price: '1200', isRecurring: false },
];

describe('domexaAmountToMinor', () => {
  it('reads the JSON number, the canonical string and the formatted string', () => {
    expect(domexaAmountToMinor(1234.56)).toBe(123456);
    expect(domexaAmountToMinor('1234.56')).toBe(123456);
    expect(domexaAmountToMinor('-450.5')).toBe(-45050);
    expect(domexaAmountToMinor('18.00')).toBe(1800); // percent × 100 is exactly rateBp
    expect(domexaAmountToMinor('1.234,56')).toBe(123456);
    expect(domexaAmountToMinor('1,234.56', { thousandSeparator: ',', decimalSeparator: '.' })).toBe(123456);
    expect(domexaAmountToMinor('')).toBeNull();
    expect(domexaAmountToMinor(null)).toBeNull();
    expect(domexaAmountToMinor('n/a')).toBeNull();
  });

  it('takes the separators from /api/organization and falls back to the mk defaults', () => {
    expect(separatorsFromOrganization({ thousandSeparator: '.', decimalSeparator: ',' })).toEqual(DEFAULT_SEPARATORS);
    expect(separatorsFromOrganization({})).toEqual(DEFAULT_SEPARATORS);
    expect(separatorsFromOrganization(null)).toEqual(DEFAULT_SEPARATORS);
  });
});

describe('statementToOpeningBalance', () => {
  it('is the closing balance, positive when the owner owes, and 0 when unreadable', () => {
    expect(statementToOpeningBalance({ closingBalance: '1234.56' })).toBe(123456);
    expect(statementToOpeningBalance({ balance: -450.5 })).toBe(-45050);
    expect(statementToOpeningBalance({ summary: { closingBalance: '10.00' } })).toBe(1000);
    expect(statementToOpeningBalance({})).toBe(0);
    expect(statementToOpeningBalance(undefined)).toBe(0);
  });
});

describe('domexaUnitsToImportRows', () => {
  const { rows, report } = domexaUnitsToImportRows(UNITS, CONTACTS, STATEMENTS);

  it('writes one canonical CSV row per unit that has a label', () => {
    expect(rowsToCanonicalCsv(rows)).toBe(
      'број;кат;тип;површина;удел;име;презиме;е-пошта;телефон;почетно салдо\n'
      + '1;1;apartment;54.5;;Марко;Марков;marko@example.mk;070111222;1234.56\n'
      + '2;1;apartment;62;;Ана;Бошковска;ANA@example.mk;070222333;-450.50\n'
      + 'P-1;;parking;;;Марко;Марков;marko@example.mk;070111222;0\n',
    );
  });

  it('produces a file our own parser accepts', () => {
    const parsed = parseUnitImport(rowsToCanonicalCsv(rows));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map((r) => r.openingBalanceMinor)).toEqual([123456, -45050, 0]);
    expect(parsed.rows.map((r) => r.kind)).toEqual(['apartment', 'apartment', 'parking']);
    expect(parsed.rows[1]!.ownerEmail).toBe('ana@example.mk');
  });

  it('reports the unknown field, the skipped row, the guessed kind and the moved balance', () => {
    expect(report.counts).toEqual({ units: 4, rows: 3, owners: 2, openingBalances: 2 });
    expect(report.unknownFields).toEqual(['attachedToUnitId']);
    expect(report.skipped).toEqual([{ entity: 'unit', id: 'u4', reason: 'missing label' }]);
    expect(report.notes).toEqual([
      'unit P-1: kind "garage" → parking',
      "unit P-1: the owner's opening balance is on unit 1",
    ]);
  });

  it('never throws on a row that is not an object at all', () => {
    const odd = domexaUnitsToImportRows([null, 42, { number: '5', type: 'кутија' }], {}, {});
    expect(odd.rows).toHaveLength(1);
    expect(odd.rows[0]!.kind).toBe('other');
    expect(odd.report.skipped).toHaveLength(2);
    expect(odd.report.notes).toEqual(['unit 5: kind "кутија" is unknown → other']);
  });
});

describe('domexaTaxRatesToDomar', () => {
  it('turns a percent string into basis points', () => {
    const { rows, report } = domexaTaxRatesToDomar(TAX_RATES);
    expect(rows).toEqual([
      { name: '/', rateBp: 0, isDefault: false },
      { name: 'ДДВ', rateBp: 1800, isDefault: true },
    ]);
    expect(report.counts).toEqual({ taxRates: 2 });
  });
});

describe('domexaServicesToDomar', () => {
  const { rows, report } = domexaServicesToDomar(SERVICES, TAX_RATES);

  it('maps the pricing model, the price and the tax rate by name', () => {
    expect(rows).toEqual([
      { name: 'Чистење', category: 'Чистење', description: null, pricing: 'fixed_per_unit', defaultPriceMinor: 30000, taxRateName: 'ДДВ', appliesTo: ['apartment', 'commercial'], recurring: true },
      { name: 'Лифт', category: null, description: null, pricing: 'per_m2', defaultPriceMinor: 1250, taxRateName: '/', appliesTo: [], recurring: true },
      { name: 'Заменета светилка', category: null, description: null, pricing: 'shared_total', defaultPriceMinor: 120000, taxRateName: null, appliesTo: [], recurring: false },
    ]);
    expect(report.notes).toEqual(['service Заменета светилка: no tax rate — the tenant default applies']);
  });

  it('falls back to fixed_per_unit and says so', () => {
    const { rows: odd, report: r } = domexaServicesToDomar([{ id: 'x', name: 'Х', pricingModel: 'per_owner', price: '1' }], []);
    expect(odd[0]).toMatchObject({ pricing: 'fixed_per_unit', defaultPriceMinor: 100 });
    expect(r.notes).toContain('service Х: pricing "per_owner" is unknown → fixed_per_unit');
  });
});

describe('domexaBuildingsToDomar, building services and the reserve fund', () => {
  it('keeps a file-safe key per building', () => {
    const { rows } = domexaBuildingsToDomar([{ id: 'b/1', name: 'Партизанска 12', address: 'Партизанска 12', city: 'Скопје', postalCode: '1000' }]);
    expect(rows).toEqual([{ key: 'b-1', name: 'Партизанска 12', address: 'Партизанска 12', city: 'Скопје', postalCode: '1000' }]);
    expect(buildingKeyOf('b 1/2')).toBe('b-1-2');
  });

  it('turns a start date into a period and an interval into a frequency', () => {
    const { rows } = domexaBuildingServicesToDomar(
      [
        { id: 'bs1', serviceId: 's1', price: '350.00', frequency: 'monthly', intervalMonths: 1, startsAt: '2026-01-01', endsAt: null },
        { id: 'bs2', serviceId: 's2', intervalMonths: 3 },
      ],
      'b1', { s1: 'Чистење', s2: 'Лифт' }, '2026-09',
    );
    expect(rows).toEqual([
      { buildingKey: 'b1', serviceName: 'Чистење', priceMinor: 35000, pricing: null, frequency: 'monthly', intervalMonths: 1, startsPeriod: '2026-01', endsPeriod: null },
      { buildingKey: 'b1', serviceName: 'Лифт', priceMinor: null, pricing: null, frequency: 'every_n_months', intervalMonths: 3, startsPeriod: '2026-09', endsPeriod: null },
    ]);
  });

  it('reads the reserve fund setting and its balance', () => {
    const { plan } = domexaReserveFundToDomar('b1', { basis: 'per_m2', amount: '10.00', appliesTo: ['apartment'], isActive: true }, { balance: '35000.00' });
    expect(plan).toEqual({
      buildingKey: 'b1',
      setting: { basis: 'per_m2', amountMinor: 1000, appliesTo: ['apartment'], active: true },
      openingBalanceMinor: 3500000,
    });
  });

  it('survives a missing reserve fund entirely', () => {
    const { plan, report } = domexaReserveFundToDomar('b1', null, null);
    expect(plan).toEqual({ buildingKey: 'b1', setting: null, openingBalanceMinor: 0 });
    expect(report.notes).toContain('building b1: no reserve fund setting in the export');
  });
});

describe('the report', () => {
  it('merges and renders as markdown', () => {
    const merged = mergeReports([
      { counts: { units: 4 }, unknownFields: ['a'], skipped: [{ entity: 'unit', id: 'u4', reason: 'missing label' }], notes: ['n1'] },
      { counts: { units: 1, services: 3 }, unknownFields: ['a', 'b'], skipped: [], notes: [] },
    ]);
    expect(merged.counts).toEqual({ units: 5, services: 3 });
    expect(merged.unknownFields).toEqual(['a', 'b']);

    const md = reportToMarkdown(merged);
    expect(md.startsWith('# Domexa migration report\n\n## Counts\n\n- units: 5\n- services: 3\n')).toBe(true);
    expect(md).toContain('## Skipped rows\n\n- unit u4: missing label\n');
    expect(md).toContain('## Notes\n\n- n1\n');
    expect(reportToMarkdown({ counts: {}, unknownFields: [], skipped: [], notes: [] })).toContain('## Unknown fields\n\nNone.\n');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @domar/domain test`
Expected: FAIL — `Failed to resolve import "../src/migration/domexa.js"`.

- [ ] **Step 3: Implement**

Create `packages/domain/src/migration/domexa.ts`:

```ts
import type { UnitKind } from '../calculation/types.js';
import { mkPack } from '../country/mk.js';
import { emptyImportRow } from '../import/serialize.js';
import { type ImportField, normaliseKind } from '../import/units.js';

/**
 * Domexa's unit, contact and building row shapes were never observable — the demo account was empty
 * — so every accessor here takes a list of candidate paths, tolerates a missing field, records what
 * it did not understand and never throws on a row (spec §20.3).
 */

// ---------------------------------------------------------------- the report

export interface MigrationReport {
  counts: Record<string, number>;
  unknownFields: string[];
  skipped: { entity: string; id: string; reason: string }[];
  notes: string[];
}

export function emptyReport(): MigrationReport {
  return { counts: {}, unknownFields: [], skipped: [], notes: [] };
}

export function mergeReports(reports: MigrationReport[]): MigrationReport {
  const out = emptyReport();
  for (const r of reports) {
    for (const [k, v] of Object.entries(r.counts)) out.counts[k] = (out.counts[k] ?? 0) + v;
    for (const f of r.unknownFields) if (!out.unknownFields.includes(f)) out.unknownFields.push(f);
    out.skipped.push(...r.skipped);
    out.notes.push(...r.notes);
  }
  return out;
}

export function reportToMarkdown(report: MigrationReport): string {
  const section = (title: string, lines: string[]): string =>
    `## ${title}\n\n${lines.length > 0 ? lines.map((l) => `- ${l}`).join('\n') : 'None.'}\n`;
  return [
    '# Domexa migration report',
    '',
    section('Counts', Object.entries(report.counts).map(([k, v]) => `${k}: ${v}`)),
    section('Unknown fields', report.unknownFields),
    section('Skipped rows', report.skipped.map((s) => `${s.entity} ${s.id}: ${s.reason}`)),
    section('Notes', report.notes),
  ].join('\n');
}

// ------------------------------------------------------------ tolerant reads

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function readPath(row: unknown, path: string): unknown {
  let cur: unknown = row;
  for (const part of path.split('.')) {
    if (!isRecord(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** The first candidate path that carries something other than undefined, null or an empty string. */
function firstOf(row: unknown, paths: readonly string[]): unknown {
  for (const p of paths) {
    const v = readPath(row, p);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** What a CSV cell can carry. An object or an array never becomes a cell. */
function text(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

// ----------------------------------------------------------------- the numbers

export interface DomexaSeparators { thousandSeparator: string; decimalSeparator: string }
export const DEFAULT_SEPARATORS: DomexaSeparators = { thousandSeparator: '.', decimalSeparator: ',' };

export function separatorsFromOrganization(org: unknown): DomexaSeparators {
  return {
    thousandSeparator: text(readPath(org, 'thousandSeparator')) || DEFAULT_SEPARATORS.thousandSeparator,
    decimalSeparator: text(readPath(org, 'decimalSeparator')) || DEFAULT_SEPARATORS.decimalSeparator,
  };
}

/**
 * Domexa sends amounts as JSON numbers and as strings. `"18.00"` and `"1234.56"` (observed on
 * /api/tax-rates) are already canonical; anything else is normalised with the organization's own
 * separators before the mk parser reads it. Unreadable → null, never an exception.
 */
export function domexaAmountToMinor(value: unknown, sep: DomexaSeparators = DEFAULT_SEPARATORS): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : null;
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw === '') return null;
  const canonical = /^-?\d+(\.\d+)?$/.test(raw)
    ? raw
    : raw.split(sep.thousandSeparator).join('').split(sep.decimalSeparator).join('.');
  try {
    return mkPack.parseAmountToMinor(canonical);
  } catch {
    return null;
  }
}

// -------------------------------------------------------------- the field map

export type DomarPricing = 'fixed_per_unit' | 'per_m2' | 'shared_total';

export interface DomexaFieldMap {
  unit: Record<ImportField, readonly string[]>;
  unitOwnerId: readonly string[];
  contact: Record<'firstName' | 'lastName' | 'email' | 'phone', readonly string[]>;
  statement: Record<'closingBalance', readonly string[]>;
  building: Record<'name' | 'address' | 'city' | 'postalCode', readonly string[]>;
  service: Record<'name' | 'category' | 'description' | 'pricing' | 'price' | 'taxRateId' | 'appliesTo' | 'recurring', readonly string[]>;
  buildingService: Record<'serviceId' | 'price' | 'pricing' | 'frequency' | 'intervalMonths' | 'startsAt' | 'endsAt', readonly string[]>;
  reserveFund: Record<'basis' | 'amount' | 'appliesTo' | 'active' | 'balance', readonly string[]>;
}

/** The starting guess. `transform --map <file>` overrides any subtree of it (docs/MIGRATION.md). */
export const DEFAULT_FIELD_MAP: DomexaFieldMap = {
  unit: {
    label: ['number', 'unitNumber', 'label', 'name', 'code'],
    floor: ['floor', 'floorNumber', 'level'],
    kind: ['type', 'unitType', 'kind'],
    areaM2: ['areaM2', 'area', 'surface', 'squareMeters', 'm2'],
    ownershipShare: ['ownershipShare', 'share', 'coOwnershipShare'],
    ownerFirstName: ['owner.firstName', 'ownerFirstName', 'contact.firstName'],
    ownerLastName: ['owner.lastName', 'ownerLastName', 'contact.lastName'],
    ownerEmail: ['owner.email', 'ownerEmail', 'contact.email'],
    ownerPhone: ['owner.phone', 'ownerPhone', 'contact.phone'],
    openingBalance: [], // never on the unit: it comes from the contact's statement (§20.2)
  },
  unitOwnerId: ['ownerContactId', 'ownerId', 'contactId', 'owner.id', 'contact.id'],
  contact: {
    firstName: ['firstName', 'first_name', 'givenName'],
    lastName: ['lastName', 'last_name', 'familyName', 'surname'],
    email: ['email', 'emailAddress'],
    phone: ['phone', 'phoneNumber', 'mobile'],
  },
  statement: { closingBalance: ['closingBalance', 'balance', 'outstandingBalance', 'totalOutstanding', 'closing.balance', 'summary.closingBalance'] },
  building: {
    name: ['name', 'title', 'label'],
    address: ['address', 'street', 'addressLine1'],
    city: ['city', 'town'],
    postalCode: ['postalCode', 'zip', 'postCode'],
  },
  service: {
    name: ['name', 'title'],
    category: ['categoryName', 'category.name', 'category'],
    description: ['description', 'note'],
    pricing: ['pricingModel', 'pricing', 'priceModel', 'model'],
    price: ['price', 'defaultPrice', 'amount', 'unitPrice'],
    taxRateId: ['taxRateId', 'taxRate.id', 'vatRateId'],
    appliesTo: ['appliesTo', 'unitTypes', 'appliesToUnitTypes'],
    recurring: ['isRecurring', 'recurring'],
  },
  buildingService: {
    serviceId: ['serviceId', 'service.id'],
    price: ['price', 'priceOverride', 'amount'],
    pricing: ['pricingModel', 'pricing', 'priceModel'],
    frequency: ['frequency'],
    intervalMonths: ['intervalMonths', 'everyNMonths', 'interval'],
    startsAt: ['startsAt', 'startDate', 'validFrom', 'startPeriod'],
    endsAt: ['endsAt', 'endDate', 'validTo', 'endPeriod'],
  },
  reserveFund: {
    basis: ['basis', 'calculationBasis', 'mode'],
    amount: ['amount', 'amountPerUnit', 'monthlyAmount', 'rate'],
    appliesTo: ['appliesTo', 'unitTypes'],
    active: ['isActive', 'active', 'enabled'],
    balance: ['balance', 'currentBalance', 'openingBalance', 'total'],
  },
};

/** The five kinds the Domexa guide names, in the English words an API is likely to use. */
const DOMEXA_UNIT_KINDS: Record<string, UnitKind> = {
  flat: 'apartment', residential: 'apartment', home: 'apartment',
  office: 'commercial', business: 'commercial', shop: 'commercial', retail: 'commercial', local: 'commercial',
  garage: 'parking', parkingspot: 'parking', parkingspace: 'parking',
  basement: 'storage', cellar: 'storage', depot: 'storage',
};

const PRICING: Record<string, DomarPricing> = {
  fixedperunit: 'fixed_per_unit', fixed: 'fixed_per_unit', perunit: 'fixed_per_unit', 'поединица': 'fixed_per_unit',
  perm2: 'per_m2', area: 'per_m2', byarea: 'per_m2', 'поm2': 'per_m2', 'пом2': 'per_m2',
  sharedtotal: 'shared_total', shared: 'shared_total', total: 'shared_total', split: 'shared_total', 'заедничко': 'shared_total',
};

const squash = (s: string): string => s.trim().toLowerCase().replace(/[\s_-]+/g, '');

function unitKindOf(raw: string, label: string, report: MigrationReport): UnitKind {
  const direct = normaliseKind(raw);
  if (direct) return direct;
  const guess = DOMEXA_UNIT_KINDS[squash(raw)];
  if (guess) { report.notes.push(`unit ${label}: kind "${raw}" → ${guess}`); return guess; }
  report.notes.push(`unit ${label}: kind "${raw || '(empty)'}" is unknown → other`);
  return 'other';
}

function kindList(value: unknown, owner: string, report: MigrationReport): UnitKind[] {
  if (!Array.isArray(value)) return [];
  const out: UnitKind[] = [];
  for (const v of value) {
    const raw = text(v);
    const kind = normaliseKind(raw) ?? DOMEXA_UNIT_KINDS[squash(raw)];
    if (kind) { if (!out.includes(kind)) out.push(kind); }
    else report.notes.push(`${owner}: unit kind "${raw}" is unknown and was dropped`);
  }
  return out;
}

// -------------------------------------------------------------------- units

const IGNORED_UNIT_KEYS = ['id', 'buildingId', 'propertyId', 'organizationId', 'tenantId', 'createdAt', 'updatedAt'];

function consumedRoots(map: DomexaFieldMap): Set<string> {
  const roots = new Set<string>(IGNORED_UNIT_KEYS);
  for (const paths of Object.values(map.unit)) for (const p of paths) roots.add(p.split('.')[0]!);
  for (const p of map.unitOwnerId) roots.add(p.split('.')[0]!);
  return roots;
}

/**
 * Domexa units (+ the contacts and statements they point at) → canonical import rows. An owner's
 * closing balance lands on their *first* unit only: the import books one posting per row with a
 * balance, so repeating it would multiply the debt (design addendum 14).
 */
export function domexaUnitsToImportRows(
  units: unknown[],
  contactsById: Record<string, unknown>,
  statementsByContactId: Record<string, unknown>,
  map: DomexaFieldMap = DEFAULT_FIELD_MAP,
  sep: DomexaSeparators = DEFAULT_SEPARATORS,
): { rows: Record<ImportField, string>[]; report: MigrationReport } {
  const report = emptyReport();
  const rows: Record<ImportField, string>[] = [];
  const known = consumedRoots(map);
  const balanceOn = new Map<string, string>();
  const owners = new Set<string>();
  let openingBalances = 0;

  for (const unit of units) {
    if (isRecord(unit)) {
      for (const key of Object.keys(unit)) {
        if (!known.has(key) && !report.unknownFields.includes(key)) report.unknownFields.push(key);
      }
    }
    const id = text(firstOf(unit, ['id', 'number', 'label'])) || '(no id)';
    const label = text(firstOf(unit, map.unit.label));
    if (!label) { report.skipped.push({ entity: 'unit', id, reason: 'missing label' }); continue; }

    const row = emptyImportRow();
    row.label = label;
    row.floor = text(firstOf(unit, map.unit.floor));
    row.areaM2 = text(firstOf(unit, map.unit.areaM2));
    row.ownershipShare = text(firstOf(unit, map.unit.ownershipShare));
    row.kind = unitKindOf(text(firstOf(unit, map.unit.kind)), label, report);

    const ownerId = text(firstOf(unit, map.unitOwnerId));
    const contact = ownerId ? contactsById[ownerId] : undefined;
    row.ownerFirstName = text(firstOf(unit, map.unit.ownerFirstName)) || text(firstOf(contact, map.contact.firstName));
    row.ownerLastName = text(firstOf(unit, map.unit.ownerLastName)) || text(firstOf(contact, map.contact.lastName));
    row.ownerEmail = text(firstOf(unit, map.unit.ownerEmail)) || text(firstOf(contact, map.contact.email));
    row.ownerPhone = text(firstOf(unit, map.unit.ownerPhone)) || text(firstOf(contact, map.contact.phone));

    const key = ownerId || (row.ownerLastName ? `${row.ownerFirstName}|${row.ownerLastName}` : '');
    row.openingBalance = '0';
    if (key) {
      owners.add(key);
      const carrier = balanceOn.get(key);
      if (carrier) report.notes.push(`unit ${label}: the owner's opening balance is on unit ${carrier}`);
      else {
        balanceOn.set(key, label);
        const minor = row.ownerLastName ? statementToOpeningBalance(statementsByContactId[key], map, sep) : 0;
        row.openingBalance = (minor / 100).toFixed(2);
        if (minor !== 0) openingBalances++;
      }
    }
    rows.push(row);
  }

  report.counts = { units: units.length, rows: rows.length, owners: owners.size, openingBalances };
  return { rows, report };
}

/** The contact statement's closing balance as signed minor units; positive = the owner owes. */
export function statementToOpeningBalance(
  statement: unknown,
  map: DomexaFieldMap = DEFAULT_FIELD_MAP,
  sep: DomexaSeparators = DEFAULT_SEPARATORS,
): number {
  return domexaAmountToMinor(firstOf(statement, map.statement.closingBalance), sep) ?? 0;
}

// ---------------------------------------------------- tax rates and services

export interface DomarTaxRatePlan { name: string; rateBp: number; isDefault: boolean }

/** A Domexa percent (`"18.00"`) is basis points once multiplied by 100 — which is what minor is. */
export function domexaTaxRatesToDomar(rows: unknown[], sep: DomexaSeparators = DEFAULT_SEPARATORS): { rows: DomarTaxRatePlan[]; report: MigrationReport } {
  const report = emptyReport();
  const out: DomarTaxRatePlan[] = [];
  for (const r of rows) {
    const id = text(firstOf(r, ['id'])) || '(no id)';
    const name = text(firstOf(r, ['name', 'label']));
    const rateBp = domexaAmountToMinor(firstOf(r, ['rate', 'percent', 'value']), sep);
    if (!name || rateBp === null) {
      report.skipped.push({ entity: 'taxRate', id, reason: name ? 'unreadable rate' : 'missing name' });
      continue;
    }
    out.push({ name, rateBp, isDefault: readPath(r, 'isDefault') === true });
  }
  report.counts = { taxRates: out.length };
  return { rows: out, report };
}

export interface DomarServicePlan {
  name: string; category: string | null; description: string | null;
  pricing: DomarPricing; defaultPriceMinor: number; taxRateName: string | null;
  appliesTo: UnitKind[]; recurring: boolean;
}

export function domexaServicesToDomar(
  services: unknown[],
  taxRates: unknown[],
  map: DomexaFieldMap = DEFAULT_FIELD_MAP,
  sep: DomexaSeparators = DEFAULT_SEPARATORS,
): { rows: DomarServicePlan[]; report: MigrationReport } {
  const report = emptyReport();
  const names = new Map<string, string>();
  for (const r of taxRates) {
    const id = text(firstOf(r, ['id']));
    const name = text(firstOf(r, ['name', 'label']));
    if (id && name) names.set(id, name);
  }

  const out: DomarServicePlan[] = [];
  for (const s of services) {
    const id = text(firstOf(s, ['id'])) || '(no id)';
    const name = text(firstOf(s, map.service.name));
    if (!name) { report.skipped.push({ entity: 'service', id, reason: 'missing name' }); continue; }

    const rawPricing = text(firstOf(s, map.service.pricing));
    let pricing = PRICING[squash(rawPricing)];
    if (!pricing) {
      report.notes.push(`service ${name}: pricing "${rawPricing || '(empty)'}" is unknown → fixed_per_unit`);
      pricing = 'fixed_per_unit';
    }
    const taxRateId = text(firstOf(s, map.service.taxRateId));
    const taxRateName = taxRateId ? names.get(taxRateId) ?? null : null;
    if (!taxRateId) report.notes.push(`service ${name}: no tax rate — the tenant default applies`);
    else if (!taxRateName) report.notes.push(`service ${name}: tax rate ${taxRateId} is not in the export`);
    const recurring = firstOf(s, map.service.recurring);

    out.push({
      name,
      category: text(firstOf(s, map.service.category)) || null,
      description: text(firstOf(s, map.service.description)) || null,
      pricing,
      defaultPriceMinor: domexaAmountToMinor(firstOf(s, map.service.price), sep) ?? 0,
      taxRateName,
      appliesTo: kindList(firstOf(s, map.service.appliesTo), `service ${name}`, report),
      recurring: recurring === undefined ? true : recurring === true,
    });
  }
  report.counts = { services: out.length };
  return { rows: out, report };
}

// ------------------------------------- buildings, building services, the fund

export interface DomarBuildingPlan { key: string; name: string; address: string; city: string; postalCode: string }

/** A Domexa id as a file-name-safe key; it ties `units-<key>.csv` to the JSON plans. */
export function buildingKeyOf(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '-');
}

export function domexaBuildingsToDomar(buildings: unknown[], map: DomexaFieldMap = DEFAULT_FIELD_MAP): { rows: DomarBuildingPlan[]; report: MigrationReport } {
  const report = emptyReport();
  const out: DomarBuildingPlan[] = [];
  for (const b of buildings) {
    const id = text(firstOf(b, ['id'])) || '(no id)';
    const name = text(firstOf(b, map.building.name));
    if (!name) { report.skipped.push({ entity: 'building', id, reason: 'missing name' }); continue; }
    out.push({
      key: buildingKeyOf(id),
      name,
      address: text(firstOf(b, map.building.address)),
      city: text(firstOf(b, map.building.city)),
      postalCode: text(firstOf(b, map.building.postalCode)),
    });
  }
  report.counts = { buildings: out.length };
  return { rows: out, report };
}

export interface DomarBuildingServicePlan {
  buildingKey: string; serviceName: string; priceMinor: number | null; pricing: DomarPricing | null;
  frequency: 'monthly' | 'every_n_months'; intervalMonths: number; startsPeriod: string; endsPeriod: string | null;
}

/** `2026-01-01`, `2026-01-01T00:00:00Z` and `2026-01` all read as the period `2026-01`. */
function periodOf(value: unknown): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(text(value));
  return m ? `${m[1]}-${m[2]}` : null;
}

export function domexaBuildingServicesToDomar(
  rows: unknown[],
  buildingKey: string,
  serviceNamesById: Record<string, string>,
  fallbackStartsPeriod: string,
  map: DomexaFieldMap = DEFAULT_FIELD_MAP,
  sep: DomexaSeparators = DEFAULT_SEPARATORS,
): { rows: DomarBuildingServicePlan[]; report: MigrationReport } {
  const report = emptyReport();
  const out: DomarBuildingServicePlan[] = [];
  for (const r of rows) {
    const id = text(firstOf(r, ['id'])) || '(no id)';
    const serviceId = text(firstOf(r, map.buildingService.serviceId));
    const serviceName = serviceNamesById[serviceId];
    if (!serviceName) { report.skipped.push({ entity: 'buildingService', id, reason: `service ${serviceId || '(none)'} is not in the export` }); continue; }

    const rawPricing = text(firstOf(r, map.buildingService.pricing));
    const pricing = rawPricing ? PRICING[squash(rawPricing)] ?? null : null;
    if (rawPricing && !pricing) report.notes.push(`building service ${serviceName}: pricing "${rawPricing}" is unknown → the catalogue model applies`);
    const intervalRaw = Number(text(firstOf(r, map.buildingService.intervalMonths)));
    const intervalMonths = Number.isFinite(intervalRaw) && intervalRaw >= 1 && intervalRaw <= 24 ? Math.trunc(intervalRaw) : 1;
    const startsPeriod = periodOf(firstOf(r, map.buildingService.startsAt)) ?? fallbackStartsPeriod;

    out.push({
      buildingKey, serviceName,
      priceMinor: domexaAmountToMinor(firstOf(r, map.buildingService.price), sep),
      pricing,
      frequency: intervalMonths > 1 ? 'every_n_months' : 'monthly',
      intervalMonths,
      startsPeriod,
      endsPeriod: periodOf(firstOf(r, map.buildingService.endsAt)),
    });
  }
  report.counts = { buildingServices: out.length };
  return { rows: out, report };
}

export interface DomarReserveFundPlan {
  buildingKey: string;
  setting: { basis: 'per_unit' | 'per_m2'; amountMinor: number; appliesTo: UnitKind[]; active: boolean } | null;
  openingBalanceMinor: number;
}

export function domexaReserveFundToDomar(
  buildingKey: string,
  setting: unknown,
  balance: unknown,
  map: DomexaFieldMap = DEFAULT_FIELD_MAP,
  sep: DomexaSeparators = DEFAULT_SEPARATORS,
): { plan: DomarReserveFundPlan; report: MigrationReport } {
  const report = emptyReport();
  const amountMinor = domexaAmountToMinor(firstOf(setting, map.reserveFund.amount), sep);
  let resolved: DomarReserveFundPlan['setting'] = null;
  if (amountMinor === null) report.notes.push(`building ${buildingKey}: no reserve fund setting in the export`);
  else {
    const rawBasis = squash(text(firstOf(setting, map.reserveFund.basis)));
    const basis = ['perm2', 'area', 'byarea', 'пом2', 'поm2'].includes(rawBasis) ? 'per_m2' : 'per_unit';
    if (rawBasis && basis === 'per_unit' && !['perunit', 'unit', 'fixed', 'поединица'].includes(rawBasis)) {
      report.notes.push(`building ${buildingKey}: reserve fund basis "${rawBasis}" is unknown → per_unit`);
    }
    resolved = {
      basis,
      amountMinor,
      appliesTo: kindList(firstOf(setting, map.reserveFund.appliesTo), `building ${buildingKey} reserve fund`, report),
      active: firstOf(setting, map.reserveFund.active) !== false,
    };
  }
  const openingBalanceMinor = domexaAmountToMinor(firstOf(balance, map.reserveFund.balance), sep) ?? 0;
  report.counts = { reserveFunds: resolved ? 1 : 0 };
  return { plan: { buildingKey, setting: resolved, openingBalanceMinor }, report };
}
```

In `packages/domain/src/index.ts`, add the migration module next to the import module:

```ts
export * from './import/serialize.js';
export * from './migration/domexa.js';
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @domar/domain test && pnpm --filter @domar/domain typecheck && pnpm lint`
Expected: PASS — 12 files; every assertion above green, including the exact CSV, the exact `report.notes` array and `parseUnitImport` returning no errors for the generated file.

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): pure Domexa transforms with a migration report" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: API scripts — the read-only Domexa client and the raw export

**Files:**
- Create: `apps/api/scripts/domexa/client.ts`
- Create: `apps/api/scripts/domexa/export.ts`
- Create: `apps/api/scripts/domexa/cli.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/api/tsconfig.json`
- Modify: `.gitignore`
- Modify: `.dockerignore`
- Modify: `.env.example`
- Create: `apps/api/test/domexa-client.test.ts`

**Interfaces (consumed by Task 5):**
- `assertReadOnly(method: string, path: string): void` — throws for everything but `GET *` and `POST /api/auth/login`.
- `class DomexaClient` — `login()`, `get<T>(path)`, `getAll(path)`; options `{ baseUrl, org, email?, password?, cookie?, fetchImpl?, log?, pageSize? }`.
- `class DomexaHttpError extends Error` — `{ status, path, body }`.
- `runExport(client, dir, log?)` — writes `organization.json`, `tax-rates.json`, `services.json`, `service-categories.json`, `contacts.json`, `statements.json` (keyed by contact id), `buildings.json`, `units.json` / `building-services.json` / `reserve-funds.json` / `reserve-fund-balances.json` (each keyed by building id) into `dir`.
- `apps/api/scripts/domexa/cli.ts` — `pnpm --filter @domar/api migrate:domexa -- export [--dir domexa-export]`. Task 5 adds the `transform` and `apply` branches to the same file.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/domexa-client.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { assertReadOnly, DomexaClient, DomexaHttpError } from '../scripts/domexa/client.js';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

/** Records every call and answers from a queue; `headers` keeps the last request's headers. */
function stub(responses: Response[]) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string> });
    return responses.shift() ?? json({});
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('the Domexa client', () => {
  it('is read-only apart from the login call', () => {
    expect(() => assertReadOnly('GET', '/api/contacts')).not.toThrow();
    expect(() => assertReadOnly('POST', '/api/auth/login')).not.toThrow();
    expect(() => assertReadOnly('POST', '/api/contacts')).toThrow(/read-only/);
    expect(() => assertReadOnly('DELETE', '/api/contacts/1')).toThrow(/refusing DELETE/);
    expect(() => assertReadOnly('PUT', '/api/auth/login')).toThrow(/read-only/);
  });

  it('follows the { rows, total, page, pageSize } envelope and logs the method and the path only', async () => {
    const { calls, fetchImpl } = stub([
      json({ rows: [{ id: 'c1' }], total: 3, page: 1, pageSize: 1 }),
      json({ rows: [{ id: 'c2' }], total: 3, page: 2, pageSize: 1 }),
      json({ rows: [{ id: 'c3' }], total: 3, page: 3, pageSize: 1 }),
    ]);
    const lines: string[] = [];
    const client = new DomexaClient({ baseUrl: 'https://domexa.mk', org: 'naum', cookie: 'domexa_session=s3cret', fetchImpl, log: (l) => lines.push(l), pageSize: 1 });

    expect(await client.getAll('/api/contacts')).toEqual([{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'GET']);
    expect(calls.map((c) => c.url)).toEqual([
      'https://domexa.mk/api/contacts?page=1&pageSize=1',
      'https://domexa.mk/api/contacts?page=2&pageSize=1',
      'https://domexa.mk/api/contacts?page=3&pageSize=1',
    ]);
    expect(lines).toEqual([
      'GET /api/contacts?page=1&pageSize=1',
      'GET /api/contacts?page=2&pageSize=1',
      'GET /api/contacts?page=3&pageSize=1',
    ]);
    expect(calls[0]!.headers.cookie).toBe('domexa_session=s3cret');
    expect(lines.join('\n')).not.toContain('s3cret');
  });

  it('stops on an empty page and passes a plain array straight through', async () => {
    const empty = stub([json({ rows: [], total: 10 })]);
    const a = new DomexaClient({ baseUrl: 'https://domexa.mk', org: 'naum', cookie: 'x=1', fetchImpl: empty.fetchImpl, log: () => {} });
    expect(await a.getAll('/api/services')).toEqual([]);
    expect(empty.calls).toHaveLength(1);

    const plain = stub([json([{ id: 't1' }])]);
    const b = new DomexaClient({ baseUrl: 'https://domexa.mk', org: 'naum', cookie: 'x=1', fetchImpl: plain.fetchImpl, log: () => {} });
    expect(await b.getAll('/api/tax-rates')).toEqual([{ id: 't1' }]);
    expect(plain.calls).toHaveLength(1);
  });

  it('throws a DomexaHttpError carrying the status and the path', async () => {
    const { fetchImpl } = stub([json({ error: 'nope' }, 403)]);
    const client = new DomexaClient({ baseUrl: 'https://domexa.mk', org: 'naum', cookie: 'x=1', fetchImpl, log: () => {} });
    await expect(client.get('/api/organization')).rejects.toBeInstanceOf(DomexaHttpError);
    await expect(client.get('/api/organization')).rejects.toThrow(/403 on \/api\/organization/);
  });

  it('logs in once when no cookie was given and sends the session cookie afterwards', async () => {
    const login = new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'domexa_session=zzz; Path=/; HttpOnly' } });
    const { calls, fetchImpl } = stub([login, json({ id: 1, name: 'Test kompanija' })]);
    const client = new DomexaClient({ baseUrl: 'https://domexa.mk', org: 'naum', email: 'a@b.mk', password: 'pw', fetchImpl, log: () => {} });

    await client.login();
    await client.get('/api/organization');
    expect(calls.map((c) => [c.url, c.method])).toEqual([
      ['https://domexa.mk/api/auth/login', 'POST'],
      ['https://domexa.mk/api/organization', 'GET'],
    ]);
    expect(calls[1]!.headers.cookie).toBe('domexa_session=zzz');
  });

  it('skips the login entirely when DOMEXA_COOKIE was supplied', async () => {
    const { calls, fetchImpl } = stub([]);
    const client = new DomexaClient({ baseUrl: 'https://domexa.mk', org: 'naum', cookie: 'domexa_session=captured', fetchImpl, log: () => {} });
    await client.login();
    expect(calls).toHaveLength(0);
  });

  it('refuses to guess credentials', async () => {
    const { fetchImpl } = stub([]);
    const client = new DomexaClient({ baseUrl: 'https://domexa.mk', org: 'naum', fetchImpl, log: () => {} });
    await expect(client.login()).rejects.toThrow(/DOMEXA_EMAIL/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm db:up && pnpm --filter @domar/api test domexa-client`
Expected: FAIL — `Failed to load ../scripts/domexa/client.js`.

- [ ] **Step 3: Implement**

Create `apps/api/scripts/domexa/client.ts`:

```ts
const LOGIN_PATH = '/api/auth/login';

export class DomexaHttpError extends Error {
  constructor(readonly status: number, readonly path: string, readonly body: string) {
    super(`Domexa answered ${status} on ${path}`);
    this.name = 'DomexaHttpError';
  }
}

/**
 * The migration never writes to Domexa (spec §20.2/§20.4). Every request goes through one private
 * `send`, and this is the only place a non-GET is allowed — the login, by its literal path.
 */
export function assertReadOnly(method: string, path: string): void {
  if (method === 'GET') return;
  if (method === 'POST' && path === LOGIN_PATH) return;
  throw new Error(`the Domexa client is read-only: refusing ${method} ${path}`);
}

export interface DomexaClientOptions {
  baseUrl: string;
  org: string;
  email?: string;
  password?: string;
  /** A session cookie captured from a logged-in browser, for when Turnstile blocks the API login. */
  cookie?: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  pageSize?: number;
}

interface DomexaPage { rows?: unknown[]; total?: number; page?: number; pageSize?: number }

export class DomexaClient {
  private cookie: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly pageSize: number;

  constructor(private readonly o: DomexaClientOptions) {
    this.cookie = o.cookie ?? '';
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.log = o.log ?? ((l) => console.log(l));
    this.pageSize = o.pageSize ?? 200;
  }

  async login(): Promise<void> {
    if (this.cookie) { this.log('using the captured DOMEXA_COOKIE, no login call'); return; }
    if (!this.o.email || !this.o.password) throw new Error('set DOMEXA_EMAIL and DOMEXA_PASSWORD, or capture a session into DOMEXA_COOKIE');
    const res = await this.send('POST', LOGIN_PATH, { tenantSlug: this.o.org, email: this.o.email, password: this.o.password });
    const set = res.headers.getSetCookie?.() ?? [];
    this.cookie = (set[0] ?? res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    if (!this.cookie) throw new Error('the Domexa login returned no cookie — capture one in a browser and set DOMEXA_COOKIE');
  }

  async get<T>(path: string): Promise<T> {
    return (await (await this.send('GET', path)).json()) as T;
  }

  /** Walks `{ rows, total, page, pageSize }` until `total` rows are in hand. A bare array ends it. */
  async getAll(path: string): Promise<unknown[]> {
    const rows: unknown[] = [];
    for (let page = 1; page <= 1000; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const body = await this.get<DomexaPage | unknown[]>(`${path}${sep}page=${page}&pageSize=${this.pageSize}`);
      if (Array.isArray(body)) return body;
      const batch = Array.isArray(body.rows) ? body.rows : [];
      rows.push(...batch);
      const total = typeof body.total === 'number' ? body.total : rows.length;
      if (batch.length === 0 || rows.length >= total) break;
    }
    return rows;
  }

  private async send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    assertReadOnly(method, path);
    this.log(`${method} ${path}`); // method and path only — never a body, a cookie or a password
    const res = await this.fetchImpl(`${this.o.baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new DomexaHttpError(res.status, path, (await res.text()).slice(0, 300));
    return res;
  }
}
```

Create `apps/api/scripts/domexa/export.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DomexaClient } from './client.js';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const idOf = (v: unknown): string => (isRecord(v) && (typeof v.id === 'string' || typeof v.id === 'number') ? String(v.id) : '');

/**
 * Raw GET responses, written verbatim. Nothing here interprets a field — that is Task 3's job — and
 * nothing here writes a credential into the folder (spec §20.4). A 404 or a 403 on one sub-resource
 * leaves a null behind and the export continues; a demo account has whole endpoints missing.
 */
export async function runExport(client: DomexaClient, dir: string, log: (l: string) => void = console.log): Promise<void> {
  await mkdir(dir, { recursive: true });
  const write = async (name: string, data: unknown): Promise<void> => {
    await writeFile(join(dir, name), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    log(`wrote ${name}`);
  };
  const soft = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
    try { return await fn(); } catch (e) { log(`skipped ${what}: ${(e as Error).message}`); return null; }
  };

  await client.login();
  await write('organization.json', await soft('/api/organization', () => client.get('/api/organization')));
  await write('tax-rates.json', (await soft('/api/tax-rates', () => client.getAll('/api/tax-rates'))) ?? []);
  await write('services.json', (await soft('/api/services', () => client.getAll('/api/services'))) ?? []);
  await write('service-categories.json', (await soft('/api/service-categories', () => client.getAll('/api/service-categories'))) ?? []);

  const contacts = (await soft('/api/contacts', () => client.getAll('/api/contacts'))) ?? [];
  await write('contacts.json', contacts);
  const statements: Record<string, unknown> = {};
  for (const c of contacts) {
    const id = idOf(c);
    if (id) statements[id] = await soft(`/api/contacts/${id}/statement`, () => client.get(`/api/contacts/${id}/statement`));
  }
  await write('statements.json', statements);

  const buildings = (await soft('/api/buildings', () => client.getAll('/api/buildings'))) ?? [];
  await write('buildings.json', buildings);
  const units: Record<string, unknown> = {};
  const buildingServices: Record<string, unknown> = {};
  const reserveFunds: Record<string, unknown> = {};
  const reserveFundBalances: Record<string, unknown> = {};
  for (const b of buildings) {
    const id = idOf(b);
    if (!id) continue;
    units[id] = (await soft(`/api/buildings/${id}/units`, () => client.getAll(`/api/buildings/${id}/units`))) ?? [];
    buildingServices[id] = (await soft(`/api/buildings/${id}/services`, () => client.getAll(`/api/buildings/${id}/services`))) ?? [];
    reserveFunds[id] = await soft(`/api/buildings/${id}/reserve-fund`, () => client.get(`/api/buildings/${id}/reserve-fund`));
    reserveFundBalances[id] = await soft(`/api/buildings/${id}/reserve-fund/balance`, () => client.get(`/api/buildings/${id}/reserve-fund/balance`));
  }
  await write('units.json', units);
  await write('building-services.json', buildingServices);
  await write('reserve-funds.json', reserveFunds);
  await write('reserve-fund-balances.json', reserveFundBalances);
}
```

Create `apps/api/scripts/domexa/cli.ts`:

```ts
import { DomexaClient } from './client.js';
import { runExport } from './export.js';

const args = process.argv.slice(2);
const command = args[0] ?? '';
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const env = (name: string): string => process.env[name] ?? '';
const dir = flag('dir') ?? 'domexa-export';

if (command === 'export') {
  const client = new DomexaClient({
    baseUrl: env('DOMEXA_BASE_URL') || 'https://domexa.mk',
    org: env('DOMEXA_ORG'),
    ...(env('DOMEXA_EMAIL') ? { email: env('DOMEXA_EMAIL') } : {}),
    ...(env('DOMEXA_PASSWORD') ? { password: env('DOMEXA_PASSWORD') } : {}),
    ...(env('DOMEXA_COOKIE') ? { cookie: env('DOMEXA_COOKIE') } : {}),
  });
  await runExport(client, dir);
  console.log(`export finished in ${dir}/`);
} else {
  console.error('usage: pnpm --filter @domar/api migrate:domexa -- export [--dir domexa-export]');
  process.exit(1);
}
```

In `apps/api/package.json`, add the script after `dev`:

```json
    "dev": "tsx watch --env-file=../../.env src/index.ts",
    "migrate:domexa": "tsx --env-file=../../.env scripts/domexa/cli.ts"
```

In `apps/api/tsconfig.json`, take the scripts into the typecheck:

```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "noEmit": true, "types": ["node"] }, "include": ["src", "test", "scripts"] }
```

In `.gitignore`, add the export folder under `backups`:

```
backups
domexa-export
```

In `.dockerignore`, the same, under `backups`:

```
backups
domexa-export
```

In `.env.example`, append the migration block at the end:

```
# --- Domexa migration (apps/api/scripts/domexa, docs/MIGRATION.md) -----------------
# Only set while migrating; the API never reads these. The export is read-only.
# Base of the Domexa API. Set it to https://domexa.mk/<org> if the API is nested under the org.
DOMEXA_BASE_URL=https://domexa.mk
# The Domexa organization slug, e-mail and password of a user who may read everything
DOMEXA_ORG=
DOMEXA_EMAIL=
DOMEXA_PASSWORD=
# A session cookie captured from a logged-in browser ("name=value"), for when Turnstile blocks the
# API login. When it is set, no login call is made at all.
DOMEXA_COOKIE=
# The domar tenant the transformed data is applied to. A non-localhost URL needs --yes.
DOMAR_URL=http://localhost:3001
DOMAR_SLUG=
DOMAR_EMAIL=
DOMAR_PASSWORD=
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @domar/api test domexa-client && pnpm --filter @domar/api typecheck && pnpm lint`
Expected: PASS — 7 cases; `typecheck` now also covers `scripts/`.

- [ ] **Step 5: Commit**

```bash
git add apps/api .gitignore .dockerignore .env.example
git commit -m "feat(api): read-only Domexa client and raw export script" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: API scripts — transform the export and apply it to a domar tenant

**Files:**
- Create: `apps/api/scripts/domexa/transform.ts`
- Create: `apps/api/scripts/domexa/apply.ts`
- Modify: `apps/api/scripts/domexa/cli.ts`
- Create: `apps/api/test/domexa-transform.test.ts`
- Create: `apps/api/test/domexa-apply.test.ts`

**Interfaces:**
- Consumes from Task 3 (all through `@domar/domain`): `DEFAULT_FIELD_MAP`, `separatorsFromOrganization`, `domexaTaxRatesToDomar`, `domexaServicesToDomar`, `domexaBuildingsToDomar`, `domexaUnitsToImportRows`, `domexaBuildingServicesToDomar`, `domexaReserveFundToDomar`, `rowsToCanonicalCsv`, `mergeReports`, `reportToMarkdown`, `buildingKeyOf`.
- Consumes from Task 4: the `domexa-export/` file layout.
- `runTransform({ dir, fromPeriod, mapFile?, log? })` writes `<dir>/domar/`: `tax-rates.json` (`DomarTaxRatePlan[]`), `services.json` (`DomarServicePlan[]`), `buildings.json` (`DomarBuildingPlan[]`), `units-<buildingKey>.csv`, `building-services.json` (`DomarBuildingServicePlan[]`), `reserve-fund.json` (`DomarReserveFundPlan[]`), `organization.json` (the raw org row, for the operator to copy into Settings by hand) and `report.md`.
- `runApply(options: ApplyOptions): Promise<ApplySummary>` — `{ dir, baseUrl, slug, email, password, dryRun?, yes?, fetchImpl?, log? }`. `fetchImpl` and `baseUrl` are what let the test drive a real listening server.
- The domar routes it uses, all existing and unchanged: `POST /api/auth/login`, `GET|POST /api/tax-rates`, `GET|POST /api/services`, `GET|POST /api/buildings`, `POST /api/buildings/:id/import/units`, `GET|POST /api/buildings/:id/services`, `GET|PUT /api/buildings/:id/reserve-fund`, `POST /api/buildings/:id/reserve-fund/opening-balance`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/domexa-transform.test.ts`:

```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runTransform } from '../scripts/domexa/transform.js';

const RAW = {
  'organization.json': { id: 1, name: 'Test kompanija', thousandSeparator: '.', decimalSeparator: ',' },
  'tax-rates.json': [
    { id: 'tr-0', name: '/', rate: '0.00', isDefault: false },
    { id: 'tr-18', name: 'ДДВ', rate: '18.00', isDefault: true },
  ],
  'services.json': [{ id: 's1', name: 'Чистење', categoryName: 'Чистење', pricingModel: 'fixed_per_unit', price: '300.00', taxRateId: 'tr-18', appliesTo: ['apartment'], isRecurring: true }],
  'contacts.json': [{ id: 'c1', firstName: 'Марко', lastName: 'Марков', email: 'marko@example.mk', phone: '070111222' }],
  'statements.json': { c1: { closingBalance: '1234.56' } },
  'buildings.json': [{ id: 'b1', name: 'Партизанска 12', address: 'Партизанска 12', city: 'Скопје', postalCode: '1000' }],
  'units.json': { b1: [{ id: 'u1', number: '1', floor: '1', type: 'apartment', areaM2: 54.5, ownerContactId: 'c1' }] },
  'building-services.json': { b1: [{ id: 'bs1', serviceId: 's1', price: '350.00', intervalMonths: 1, startsAt: '2026-01-01' }] },
  'reserve-funds.json': { b1: { basis: 'per_m2', amount: '10.00', appliesTo: ['apartment'], isActive: true } },
  'reserve-fund-balances.json': { b1: { balance: '35000.00' } },
};

describe('runTransform', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'domexa-raw-'));
    for (const [name, data] of Object.entries(RAW)) await writeFile(join(dir, name), JSON.stringify(data), 'utf8');
    await runTransform({ dir, fromPeriod: '2026-09', log: () => {} });
  });

  const read = (name: string) => readFile(join(dir, 'domar', name), 'utf8');

  it('writes the canonical units CSV per building', async () => {
    expect(await read('units-b1.csv')).toBe(
      'број;кат;тип;површина;удел;име;презиме;е-пошта;телефон;почетно салдо\n'
      + '1;1;apartment;54.5;;Марко;Марков;marko@example.mk;070111222;1234.56\n',
    );
  });

  it('writes the plans the apply step reads, with names instead of ids', async () => {
    expect(JSON.parse(await read('tax-rates.json'))).toEqual([
      { name: '/', rateBp: 0, isDefault: false },
      { name: 'ДДВ', rateBp: 1800, isDefault: true },
    ]);
    expect(JSON.parse(await read('services.json'))).toEqual([
      { name: 'Чистење', category: 'Чистење', description: null, pricing: 'fixed_per_unit', defaultPriceMinor: 30000, taxRateName: 'ДДВ', appliesTo: ['apartment'], recurring: true },
    ]);
    expect(JSON.parse(await read('buildings.json'))).toEqual([
      { key: 'b1', name: 'Партизанска 12', address: 'Партизанска 12', city: 'Скопје', postalCode: '1000' },
    ]);
    expect(JSON.parse(await read('building-services.json'))).toEqual([
      { buildingKey: 'b1', serviceName: 'Чистење', priceMinor: 35000, pricing: null, frequency: 'monthly', intervalMonths: 1, startsPeriod: '2026-01', endsPeriod: null },
    ]);
    expect(JSON.parse(await read('reserve-fund.json'))).toEqual([
      { buildingKey: 'b1', setting: { basis: 'per_m2', amountMinor: 1000, appliesTo: ['apartment'], active: true }, openingBalanceMinor: 3500000 },
    ]);
  });

  it('writes a report with the counts and no credential in it', async () => {
    const md = await read('report.md');
    expect(md).toContain('# Domexa migration report');
    expect(md).toContain('- units: 1');
    expect(md).toContain('- buildings: 1');
    expect(md).toContain('- taxRates: 2');
  });

  it('applies an override map file', async () => {
    const other = await mkdtemp(join(tmpdir(), 'domexa-raw-'));
    for (const [name, data] of Object.entries(RAW)) await writeFile(join(other, name), JSON.stringify(data), 'utf8');
    await writeFile(join(other, 'units.json'), JSON.stringify({ b1: [{ id: 'u1', broj: '7', type: 'стан' }] }), 'utf8');
    const mapFile = join(other, 'map.json');
    await writeFile(mapFile, JSON.stringify({ unit: { label: ['broj'] } }), 'utf8');

    await runTransform({ dir: other, fromPeriod: '2026-09', mapFile, log: () => {} });
    expect(await readFile(join(other, 'domar', 'units-b1.csv'), 'utf8')).toContain('\n7;;apartment;');
  });

  it('survives a folder with nothing but buildings in it', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'domexa-raw-'));
    await writeFile(join(bare, 'buildings.json'), JSON.stringify([{ id: 'b9', name: 'Само зграда' }]), 'utf8');
    await runTransform({ dir: bare, fromPeriod: '2026-09', log: () => {} });
    expect(JSON.parse(await readFile(join(bare, 'domar', 'services.json'), 'utf8'))).toEqual([]);
    expect(await readFile(join(bare, 'domar', 'units-b9.csv'), 'utf8')).toBe('број;кат;тип;површина;удел;име;презиме;е-пошта;телефон;почетно салдо\n');
  });

  it('copies the organization row through for the operator to retype into Settings', async () => {
    expect(JSON.parse(await read('organization.json'))).toMatchObject({ name: 'Test kompanija', decimalSeparator: ',' });
  });
});
```

Create `apps/api/test/domexa-apply.test.ts`:

```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runApply } from '../scripts/domexa/apply.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

const UNITS_CSV = 'број;кат;тип;површина;удел;име;презиме;е-пошта;телефон;почетно салдо\n'
  + '1;1;apartment;54.5;;Марко;Марков;marko@example.mk;070111222;1234.56\n'
  + '2;1;apartment;62;;Ана;Бошковска;ana@example.mk;070222333;-450.50\n'
  + 'P-1;;parking;;;Марко;Марков;marko@example.mk;070111222;0\n';

const PLANS: Record<string, unknown> = {
  'tax-rates.json': [{ name: '/', rateBp: 0, isDefault: false }, { name: 'ДДВ', rateBp: 1800, isDefault: true }],
  'services.json': [{ name: 'Чистење', category: 'Чистење', description: null, pricing: 'fixed_per_unit', defaultPriceMinor: 30000, taxRateName: 'ДДВ', appliesTo: ['apartment'], recurring: true }],
  'buildings.json': [{ key: 'b1', name: 'Партизанска 12', address: 'Партизанска 12', city: 'Скопје', postalCode: '1000' }],
  'building-services.json': [{ buildingKey: 'b1', serviceName: 'Чистење', priceMinor: 35000, pricing: null, frequency: 'monthly', intervalMonths: 1, startsPeriod: '2026-01', endsPeriod: null }],
  'reserve-fund.json': [{ buildingKey: 'b1', setting: { basis: 'per_m2', amountMinor: 1000, appliesTo: ['apartment'], active: true }, openingBalanceMinor: 3500000 }],
};

describe('runApply', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let base: string;
  let dir: string;

  const creds = (slug: string) => ({ slug, email: `owner@${slug}.mk`, password: 'correct-horse-1' });
  const get = (url: string) => t.app.inject({ method: 'GET', url, headers: { cookie: a.cookie } });

  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-mig');
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;

    dir = await mkdtemp(join(tmpdir(), 'domexa-domar-'));
    for (const [name, data] of Object.entries(PLANS)) await writeFile(join(dir, name), JSON.stringify(data), 'utf8');
    await writeFile(join(dir, 'units-b1.csv'), UNITS_CSV, 'utf8');
  });
  afterAll(async () => { await t.close(); });

  it('refuses a remote target without --yes, before it logs in', async () => {
    await expect(runApply({ dir, baseUrl: 'https://domar.mk', ...creds('firma-mig'), log: () => {} }))
      .rejects.toThrow(/refusing to apply against https:\/\/domar\.mk/);
  });

  it('creates tax rates, services, the building, its units and its fund', async () => {
    const summary = await runApply({ dir, baseUrl: base, ...creds('firma-mig'), log: () => {} });
    expect(summary).toEqual({
      dryRun: false,
      taxRates: { created: 2, existing: 0 },
      services: { created: 1, existing: 0 },
      buildings: { created: 1, existing: 0 },
      units: { imported: 3, skipped: 0, contacts: 2, openingBalances: 2 },
      buildingServices: { created: 1, existing: 0 },
      reserveFund: { settings: 1, openingBalances: 1 },
    });

    // 4 tax rates come with a fresh mk tenant; the two Domexa ones are added by name.
    expect((await get('/api/tax-rates')).json().rows).toHaveLength(6);
    const services = (await get('/api/services')).json().rows;
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({ name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 30000, taxRateBp: 1800, appliesTo: ['apartment'] });

    const buildings = (await get('/api/buildings')).json().rows;
    expect(buildings).toHaveLength(1);
    const buildingId = buildings[0].id;
    expect(buildings[0]).toMatchObject({ name: 'Партизанска 12', city: 'Скопје', unitCount: 3 });

    const units = (await get(`/api/buildings/${buildingId}/units`)).json().rows;
    expect(units.map((u: { label: string }) => u.label).sort()).toEqual(['1', '2', 'P-1']);
    expect((await get('/api/contacts')).json().total).toBe(2);

    const balances = (await get(`/api/buildings/${buildingId}/opening-balances`)).json().rows;
    expect(balances.find((b: { lastName: string }) => b.lastName === 'Марков')).toMatchObject({ balanceMinor: 123456 });
    expect(balances.find((b: { lastName: string }) => b.lastName === 'Бошковска')).toMatchObject({ balanceMinor: -45050 });

    const bs = (await get(`/api/buildings/${buildingId}/services`)).json().rows;
    expect(bs).toHaveLength(1);
    expect(bs[0]).toMatchObject({ priceMinor: 35000, frequency: 'monthly', intervalMonths: 1, startsPeriod: '2026-01' });

    const fund = (await get(`/api/buildings/${buildingId}/reserve-fund`)).json();
    expect(fund.setting).toMatchObject({ basis: 'per_m2', amountMinor: 1000, appliesTo: ['apartment'], active: true });
    expect(fund.balanceMinor).toBe(3500000);
  });

  it('is idempotent: a second run creates nothing and books no second balance', async () => {
    const summary = await runApply({ dir, baseUrl: base, ...creds('firma-mig'), log: () => {} });
    expect(summary).toEqual({
      dryRun: false,
      taxRates: { created: 0, existing: 2 },
      services: { created: 0, existing: 1 },
      buildings: { created: 0, existing: 1 },
      units: { imported: 0, skipped: 3, contacts: 0, openingBalances: 0 },
      buildingServices: { created: 0, existing: 1 },
      reserveFund: { settings: 1, openingBalances: 0 },
    });

    expect((await get('/api/tax-rates')).json().rows).toHaveLength(6);
    expect((await get('/api/services')).json().rows).toHaveLength(1);
    const buildings = (await get('/api/buildings')).json().rows;
    expect(buildings).toHaveLength(1);
    expect(buildings[0].unitCount).toBe(3);
    expect((await get('/api/contacts')).json().total).toBe(2);
    expect((await get(`/api/buildings/${buildings[0].id}/reserve-fund`)).json().balanceMinor).toBe(3500000);
  });

  it('writes nothing at all in a dry run', async () => {
    const b = await registerTenant(t.app, 'firma-dry');
    const summary = await runApply({ dir, baseUrl: base, ...creds('firma-dry'), dryRun: true, log: () => {} });
    expect(summary.dryRun).toBe(true);
    expect(summary.taxRates).toEqual({ created: 2, existing: 0 });
    expect(summary.buildings).toEqual({ created: 1, existing: 0 });
    expect(summary.units).toEqual({ imported: 3, skipped: 0, contacts: 0, openingBalances: 0 });

    const dry = (url: string) => t.app.inject({ method: 'GET', url, headers: { cookie: b.cookie } });
    expect((await dry('/api/tax-rates')).json().rows).toHaveLength(4);
    expect((await dry('/api/services')).json().rows).toHaveLength(0);
    expect((await dry('/api/buildings')).json().rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm db:up && pnpm --filter @domar/api test domexa`
Expected: FAIL — `Failed to load ../scripts/domexa/transform.js` and `../scripts/domexa/apply.js`; the Task 4 client test still passes.

- [ ] **Step 3: Implement**

Create `apps/api/scripts/domexa/transform.ts`:

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildingKeyOf, DEFAULT_FIELD_MAP, domexaBuildingServicesToDomar, domexaBuildingsToDomar,
  domexaReserveFundToDomar, domexaServicesToDomar, domexaTaxRatesToDomar, domexaUnitsToImportRows,
  type DomexaFieldMap, type MigrationReport, mergeReports, reportToMarkdown, rowsToCanonicalCsv,
  separatorsFromOrganization,
} from '@domar/domain';

export interface TransformOptions {
  dir: string;
  /** The period a recurring service starts from when Domexa's row carries no start date. */
  fromPeriod: string;
  /** A JSON file overriding any subtree of DEFAULT_FIELD_MAP (docs/MIGRATION.md). */
  mapFile?: string;
  log?: (line: string) => void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const idOf = (v: unknown): string => (isRecord(v) && (typeof v.id === 'string' || typeof v.id === 'number') ? String(v.id) : '');

/** One level of subtree merging: `{ unit: { label: [...] } }` replaces only `unit.label`. */
function mergeMap(base: DomexaFieldMap, override: unknown): DomexaFieldMap {
  if (!isRecord(override)) return base;
  const out: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override)) {
    const current = out[k];
    out[k] = Array.isArray(v) || !isRecord(current) || !isRecord(v) ? v : { ...current, ...v };
  }
  return out as unknown as DomexaFieldMap;
}

export async function runTransform(o: TransformOptions): Promise<void> {
  const log = o.log ?? ((l: string) => console.log(l));
  const outDir = join(o.dir, 'domar');
  await mkdir(outDir, { recursive: true });

  const readJson = async <T>(name: string, fallback: T): Promise<T> => {
    try { return JSON.parse(await readFile(join(o.dir, name), 'utf8')) as T; } catch { log(`no ${name} in the export`); return fallback; }
  };
  const write = async (name: string, body: string): Promise<void> => {
    await writeFile(join(outDir, name), body, 'utf8');
    log(`wrote domar/${name}`);
  };
  const writeJson = (name: string, data: unknown) => write(name, `${JSON.stringify(data, null, 2)}\n`);

  const map = o.mapFile ? mergeMap(DEFAULT_FIELD_MAP, JSON.parse(await readFile(o.mapFile, 'utf8'))) : DEFAULT_FIELD_MAP;
  const organization = await readJson<unknown>('organization.json', null);
  const sep = separatorsFromOrganization(organization);
  const reports: MigrationReport[] = [];

  const taxRates = await readJson<unknown[]>('tax-rates.json', []);
  const tax = domexaTaxRatesToDomar(taxRates, sep);
  reports.push(tax.report);
  await writeJson('tax-rates.json', tax.rows);

  const rawServices = await readJson<unknown[]>('services.json', []);
  const services = domexaServicesToDomar(rawServices, taxRates, map, sep);
  reports.push(services.report);
  await writeJson('services.json', services.rows);
  const serviceNamesById: Record<string, string> = {};
  for (const s of rawServices) {
    const id = idOf(s);
    const name = isRecord(s) && typeof s.name === 'string' ? s.name : '';
    if (id && name) serviceNamesById[id] = name;
  }

  const rawBuildings = await readJson<unknown[]>('buildings.json', []);
  const buildings = domexaBuildingsToDomar(rawBuildings, map);
  reports.push(buildings.report);
  await writeJson('buildings.json', buildings.rows);

  const contacts = await readJson<unknown[]>('contacts.json', []);
  const contactsById: Record<string, unknown> = {};
  for (const c of contacts) { const id = idOf(c); if (id) contactsById[id] = c; }
  const statements = await readJson<Record<string, unknown>>('statements.json', {});
  const unitsByBuilding = await readJson<Record<string, unknown[]>>('units.json', {});
  const servicesByBuilding = await readJson<Record<string, unknown[]>>('building-services.json', {});
  const fundsByBuilding = await readJson<Record<string, unknown>>('reserve-funds.json', {});
  const fundBalances = await readJson<Record<string, unknown>>('reserve-fund-balances.json', {});

  const buildingServicePlans: unknown[] = [];
  const reserveFundPlans: unknown[] = [];
  for (const b of rawBuildings) {
    const id = idOf(b);
    if (!id) continue;
    const key = buildingKeyOf(id);

    const units = domexaUnitsToImportRows(unitsByBuilding[id] ?? [], contactsById, statements, map, sep);
    reports.push(units.report);
    await write(`units-${key}.csv`, rowsToCanonicalCsv(units.rows));

    const bs = domexaBuildingServicesToDomar(servicesByBuilding[id] ?? [], key, serviceNamesById, o.fromPeriod, map, sep);
    reports.push(bs.report);
    buildingServicePlans.push(...bs.rows);

    const fund = domexaReserveFundToDomar(key, fundsByBuilding[id] ?? null, fundBalances[id] ?? null, map, sep);
    reports.push(fund.report);
    reserveFundPlans.push(fund.plan);
  }
  await writeJson('building-services.json', buildingServicePlans);
  await writeJson('reserve-fund.json', reserveFundPlans);
  await writeJson('organization.json', organization);
  await write('report.md', reportToMarkdown(mergeReports(reports)));
}
```

Create `apps/api/scripts/domexa/apply.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ApplyOptions {
  dir: string;
  baseUrl: string;
  slug: string;
  email: string;
  password: string;
  dryRun?: boolean;
  /** Required for any target that is not localhost (spec §20.4). */
  yes?: boolean;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

/**
 * What the run did. In a dry run `created` counts what *would* be created, and `units.imported` is
 * the number of data rows in the CSV: no preview is requested for a building that does not exist.
 */
export interface ApplySummary {
  dryRun: boolean;
  taxRates: { created: number; existing: number };
  services: { created: number; existing: number };
  buildings: { created: number; existing: number };
  units: { imported: number; skipped: number; contacts: number; openingBalances: number };
  buildingServices: { created: number; existing: number };
  reserveFund: { settings: number; openingBalances: number };
}

export class DomarApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly path: string, message: string) {
    super(`${path} → ${status} ${code}: ${message}`);
    this.name = 'DomarApiError';
  }
}

const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

class DomarApi {
  private cookie = '';

  constructor(
    private readonly base: string,
    private readonly fetchImpl: typeof fetch,
    private readonly log: (line: string) => void,
    private readonly dryRun: boolean,
  ) {}

  async login(slug: string, email: string, password: string): Promise<void> {
    const res = await this.send('POST', '/api/auth/login', { tenantSlug: slug, email, password });
    const set = res.headers.getSetCookie?.() ?? [];
    this.cookie = (set[0] ?? res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    if (!this.cookie) throw new Error('the domar login returned no session cookie');
  }

  async get<T>(path: string): Promise<T> {
    return (await (await this.send('GET', path)).json()) as T;
  }

  /** A write; in a dry run it is logged, skipped, and the caller gets null. */
  async write<T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<T | null> {
    if (this.dryRun) { this.log(`DRY ${method} ${path}`); return null; }
    return (await (await this.send(method, path, body)).json()) as T;
  }

  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    this.log(`${method} ${path}`); // method and path only — never a body, a cookie or a password
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text();
      let code = 'error';
      let message = text.slice(0, 300);
      try {
        const e = (JSON.parse(text) as { error?: { code?: string; message?: string } }).error;
        code = e?.code ?? code;
        message = e?.message ?? message;
      } catch { /* not our envelope; keep the raw text */ }
      throw new DomarApiError(res.status, code, path, message);
    }
    return res;
  }
}

interface TaxRatePlan { name: string; rateBp: number; isDefault: boolean }
interface ServicePlan { name: string; category: string | null; description: string | null; pricing: string; defaultPriceMinor: number; taxRateName: string | null; appliesTo: string[]; recurring: boolean }
interface BuildingPlan { key: string; name: string; address: string; city: string; postalCode: string }
interface BuildingServicePlan { buildingKey: string; serviceName: string; priceMinor: number | null; pricing: string | null; frequency: string; intervalMonths: number; startsPeriod: string; endsPeriod: string | null }
interface ReserveFundPlan { buildingKey: string; setting: { basis: string; amountMinor: number; appliesTo: string[]; active: boolean } | null; openingBalanceMinor: number }

/**
 * Posts a transformed export into a domar tenant through domar's own API — every route already
 * carries the tenant filter, the role check and the audit row. Idempotent by name/label
 * (design addendum 18), so a second run creates nothing.
 */
export async function runApply(o: ApplyOptions): Promise<ApplySummary> {
  const log = o.log ?? ((l: string) => console.log(l));
  const dryRun = o.dryRun === true;
  const base = o.baseUrl.replace(/\/$/, '');
  if (!LOCAL.test(base) && o.yes !== true) {
    throw new Error(`refusing to apply against ${base} without --yes (spec §20.4)`);
  }

  const api = new DomarApi(base, o.fetchImpl ?? fetch, log, dryRun);
  const summary: ApplySummary = {
    dryRun,
    taxRates: { created: 0, existing: 0 },
    services: { created: 0, existing: 0 },
    buildings: { created: 0, existing: 0 },
    units: { imported: 0, skipped: 0, contacts: 0, openingBalances: 0 },
    buildingServices: { created: 0, existing: 0 },
    reserveFund: { settings: 0, openingBalances: 0 },
  };
  const plan = async <T>(name: string): Promise<T[]> => {
    try { return JSON.parse(await readFile(join(o.dir, name), 'utf8')) as T[]; } catch { log(`no ${name}, skipping that step`); return []; }
  };

  await api.login(o.slug, o.email, o.password);

  // 1. tax rates, by name
  const taxRateIds = new Map<string, string>();
  for (const r of (await api.get<{ rows: { id: string; name: string }[] }>('/api/tax-rates?includeInactive=true')).rows) taxRateIds.set(r.name, r.id);
  for (const p of await plan<TaxRatePlan>('tax-rates.json')) {
    if (taxRateIds.has(p.name)) { summary.taxRates.existing++; continue; }
    summary.taxRates.created++;
    const created = await api.write<{ id: string }>('POST', '/api/tax-rates', { name: p.name, rateBp: p.rateBp, isDefault: p.isDefault });
    if (created) taxRateIds.set(p.name, created.id);
  }

  // 2. services, by name
  const serviceIds = new Map<string, string>();
  for (const s of (await api.get<{ rows: { id: string; name: string }[] }>('/api/services?includeInactive=true')).rows) serviceIds.set(s.name, s.id);
  for (const p of await plan<ServicePlan>('services.json')) {
    if (serviceIds.has(p.name)) { summary.services.existing++; continue; }
    summary.services.created++;
    const taxRateId = p.taxRateName ? taxRateIds.get(p.taxRateName) : undefined;
    const created = await api.write<{ id: string }>('POST', '/api/services', {
      name: p.name, category: p.category, description: p.description, pricing: p.pricing,
      defaultPriceMinor: p.defaultPriceMinor, appliesTo: p.appliesTo, recurring: p.recurring,
      ...(taxRateId ? { taxRateId } : {}),
    });
    if (created) serviceIds.set(p.name, created.id);
  }

  // 3. buildings, by name — then their units, services and fund
  const buildingIds = new Map<string, string>();
  for (const b of (await api.get<{ rows: { id: string; name: string }[] }>('/api/buildings')).rows) buildingIds.set(b.name, b.id);
  const buildingIdByKey = new Map<string, string>();
  const buildingPlans = await plan<BuildingPlan>('buildings.json');
  for (const p of buildingPlans) {
    const existing = buildingIds.get(p.name);
    if (existing) { summary.buildings.existing++; buildingIdByKey.set(p.key, existing); continue; }
    summary.buildings.created++;
    const created = await api.write<{ id: string }>('POST', '/api/buildings', { name: p.name, address: p.address, city: p.city, postalCode: p.postalCode });
    if (created) buildingIdByKey.set(p.key, created.id);
  }

  // `mode: 'skip'` is what makes a second run import nothing: every existing label is a conflict.
  for (const p of buildingPlans) {
    const content = await readFile(join(o.dir, `units-${p.key}.csv`), 'utf8').catch(() => '');
    if (!content.trim()) continue;
    const buildingId = buildingIdByKey.get(p.key);
    if (!buildingId) {
      // Dry run against a building that does not exist yet: count the file's data rows and move on.
      const rows = content.trim().split(/\r?\n/).length - 1;
      log(`DRY import ${rows} rows into ${p.name}`);
      summary.units.imported += rows;
      continue;
    }
    const result = await api.write<{ counts: { units: number; newContacts: number; openingBalances: number; conflicts: number } }>(
      'POST', `/api/buildings/${buildingId}/import/units`, { content, mode: 'skip' },
    );
    if (result) {
      summary.units.imported += result.counts.units;
      summary.units.skipped += result.counts.conflicts;
      summary.units.contacts += result.counts.newContacts;
      summary.units.openingBalances += result.counts.openingBalances;
    }
  }

  const bsPlans = await plan<BuildingServicePlan>('building-services.json');
  for (const [key, buildingId] of buildingIdByKey) {
    const mine = bsPlans.filter((p) => p.buildingKey === key);
    if (mine.length === 0) continue;
    const attached = new Set((await api.get<{ rows: { serviceId: string }[] }>(`/api/buildings/${buildingId}/services`)).rows.map((r) => r.serviceId));
    for (const p of mine) {
      const serviceId = serviceIds.get(p.serviceName);
      if (!serviceId) { log(`no service named ${p.serviceName}; skipping its building service`); continue; }
      if (attached.has(serviceId)) { summary.buildingServices.existing++; continue; }
      summary.buildingServices.created++;
      await api.write('POST', `/api/buildings/${buildingId}/services`, {
        serviceId, frequency: p.frequency, intervalMonths: p.intervalMonths, startsPeriod: p.startsPeriod, endsPeriod: p.endsPeriod,
        ...(p.priceMinor !== null ? { priceMinor: p.priceMinor } : {}),
        ...(p.pricing !== null ? { pricing: p.pricing } : {}),
      });
      attached.add(serviceId);
    }
  }

  for (const p of await plan<ReserveFundPlan>('reserve-fund.json')) {
    const buildingId = buildingIdByKey.get(p.buildingKey);
    if (!buildingId) continue;
    if (p.setting) {
      summary.reserveFund.settings++;
      await api.write('PUT', `/api/buildings/${buildingId}/reserve-fund`, p.setting);
    }
    if (p.openingBalanceMinor === 0) continue;
    // The opening balance is a posting, so it may only be booked into an empty fund.
    const state = dryRun ? { balanceMinor: 0 } : await api.get<{ balanceMinor: number }>(`/api/buildings/${buildingId}/reserve-fund`);
    if (state.balanceMinor !== 0) { log(`the reserve fund of ${p.buildingKey} is not empty; leaving its balance alone`); continue; }
    summary.reserveFund.openingBalances++;
    await api.write('POST', `/api/buildings/${buildingId}/reserve-fund/opening-balance`, { amountMinor: p.openingBalanceMinor, note: 'Domexa migration' });
  }

  return summary;
}
```

Rewrite `apps/api/scripts/domexa/cli.ts` with all three commands:

```ts
import { DomexaClient } from './client.js';
import { runApply } from './apply.js';
import { runExport } from './export.js';
import { runTransform } from './transform.js';

const args = process.argv.slice(2);
const command = args[0] ?? '';
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string): boolean => args.includes(`--${name}`);
const env = (name: string): string => process.env[name] ?? '';
const dir = flag('dir') ?? 'domexa-export';
const thisMonth = (): string => new Date().toISOString().slice(0, 7);

if (command === 'export') {
  const client = new DomexaClient({
    baseUrl: env('DOMEXA_BASE_URL') || 'https://domexa.mk',
    org: env('DOMEXA_ORG'),
    ...(env('DOMEXA_EMAIL') ? { email: env('DOMEXA_EMAIL') } : {}),
    ...(env('DOMEXA_PASSWORD') ? { password: env('DOMEXA_PASSWORD') } : {}),
    ...(env('DOMEXA_COOKIE') ? { cookie: env('DOMEXA_COOKIE') } : {}),
  });
  await runExport(client, dir);
  console.log(`export finished in ${dir}/`);
} else if (command === 'transform') {
  await runTransform({
    dir,
    fromPeriod: flag('from') ?? thisMonth(),
    ...(flag('map') ? { mapFile: flag('map')! } : {}),
  });
  console.log(`transform finished in ${dir}/domar/ — read ${dir}/domar/report.md`);
} else if (command === 'apply') {
  const summary = await runApply({
    dir: `${dir}/domar`,
    baseUrl: env('DOMAR_URL') || 'http://localhost:3001',
    slug: env('DOMAR_SLUG'),
    email: env('DOMAR_EMAIL'),
    password: env('DOMAR_PASSWORD'),
    dryRun: has('dry-run'),
    yes: has('yes'),
  });
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.error('usage: pnpm --filter @domar/api migrate:domexa -- <export|transform|apply> [--dir domexa-export] [--from 2026-09] [--map map.json] [--dry-run] [--yes]');
  process.exit(1);
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm db:up && pnpm --filter @domar/api test && pnpm --filter @domar/api typecheck && pnpm lint`
Expected: PASS — every existing API test plus `domexa-client`, `domexa-transform` and `domexa-apply`; the two `runApply` summaries match exactly, and the reserve fund balance is still `3500000` after the second run.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): transform a Domexa export and apply it idempotently" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Docs and end-to-end — the migration runbook and an xlsx import in a browser

**Files:**
- Create: `docs/MIGRATION.md`
- Modify: `README.md`
- Modify: `e2e/package.json`
- Create: `e2e/tests/import-xlsx.spec.ts`

**Interfaces:**
- Consumes Task 2's `data-test` hooks (`import-file`, `import-map-label`, `import-map-kind`, `import-map-areaM2`, `import-map-ownerFirstName`, `import-map-apply`, `import-preview`, `import-count-units`, `import-commit`, `import-done`) and the existing building tabs (`tab-import`, `tab-units`, `row`).
- Consumes Task 4/5's CLI surface for the runbook: `export`, `transform`, `apply`, the flags `--dir`, `--from`, `--map`, `--dry-run`, `--yes`, and the nine `DOMEXA_*`/`DOMAR_*` variables.
- `xlsx@0.18.5` becomes a devDependency of `@domar/e2e` (same pin as the web app).

- [ ] **Step 1: Write the test**

Add the dependency to `e2e/package.json`:

```json
{ "name": "@domar/e2e", "private": true, "type": "module", "scripts": { "test:e2e": "playwright test", "typecheck": "tsc --noEmit" }, "devDependencies": { "@playwright/test": "^1.48.0", "typescript": "^5.6.3", "xlsx": "0.18.5" } }
```

Create `e2e/tests/import-xlsx.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
// A default import, not a namespace one: Playwright runs this on Node, `xlsx` has no exports map, so
// Node loads its CJS build and only the interop default carries `utils` (design addendum 2b).
import XLSX from 'xlsx';

const slug = `e2e-xlsx-${Date.now().toString(36)}`;
const password = 'correct-horse-1';

// Column names no alias table knows, except "Кат" and "Презиме" — those must arrive prefilled.
const AOA = [
  ['Стан', 'Кат', 'Намена', 'Квадратура', 'Сопственик', 'Презиме'],
  ['1', '1', 'стан', '54,5', 'Марко', 'Марков'],
  ['2', '1', 'стан', '62', 'Ана', 'Бошковска'],
  ['P-1', '', 'паркинг', '', '', ''],
];

function workbook(): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(AOA), 'Единици');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

test('import units from an xlsx by mapping its columns', async ({ page }) => {
  await page.goto('/register');
  await page.getByTestId('orgName').fill('Е2Е Табела');
  await page.getByTestId('slug').fill(slug);
  await page.getByTestId('firstName').fill('Ева');
  await page.getByTestId('lastName').fill('Тест');
  await page.getByTestId('email').fill(`eva@${slug}.mk`);
  await page.getByTestId('password').fill(password);
  await page.getByRole('button', { name: /Отвори сметка|Create account/ }).click();
  await expect(page).toHaveURL(/\/app$/);

  await page.getByTestId('nav-buildings').click();
  await expect(page).toHaveURL(/\/app\/buildings$/);
  await page.getByTestId('add').click();
  await page.getByTestId('name').fill('Јане Сандански 5');
  await page.getByTestId('address').fill('Јане Сандански 5');
  await page.getByTestId('city').fill('Скопје');
  await page.getByTestId('submit').click();
  await page.getByTestId('building-link').click();

  await page.getByTestId('tab-import').click();
  await page.getByTestId('import-file').setInputFiles({
    name: 'единици.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: workbook(),
  });

  // The mapping step opens by itself and has already recognised what it can.
  await expect(page.getByTestId('import-map-floor')).toHaveValue('1');
  await expect(page.getByTestId('import-map-ownerLastName')).toHaveValue('5');
  await expect(page.getByTestId('import-unmapped')).toContainText('Стан');

  await page.getByTestId('import-map-label').selectOption('0');
  await page.getByTestId('import-map-kind').selectOption('2');
  await page.getByTestId('import-map-areaM2').selectOption('3');
  await page.getByTestId('import-map-ownerFirstName').selectOption('4');
  await page.getByTestId('import-map-apply').click();
  await expect(page.getByTestId('import-map-ready')).toBeVisible();

  await page.getByTestId('import-preview').click();
  await expect(page.getByTestId('import-count-units')).toHaveText('3');
  await expect(page.getByTestId('import-count-contacts')).toHaveText('2 / 0');
  await page.getByTestId('import-commit').click();
  await expect(page.getByTestId('import-done')).toBeVisible();

  await page.getByTestId('tab-units').click();
  await expect(page.getByTestId('row')).toHaveCount(3);
  await expect(page.getByText('54,5').first()).toBeVisible();

  // The mapping is remembered, so the same file needs no second pass over the selects.
  await page.getByTestId('tab-import').click();
  await page.getByTestId('import-file').setInputFiles({
    name: 'единици.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: workbook(),
  });
  await expect(page.getByTestId('import-map-label')).toHaveValue('0');
  await expect(page.getByTestId('import-map-kind')).toHaveValue('2');
});
```

- [ ] **Step 2: Implement the docs**

Create `docs/MIGRATION.md`:

````markdown
# Migrating a company from Domexa into domar

Three commands, in this order: `export` (reads Domexa), `transform` (reads nothing but files) and
`apply` (writes into one domar tenant through domar's own API). Nothing in the chain ever writes to
Domexa: the client refuses every method but `GET`, plus the single login `POST`.

## 0. Before you start

- A domar tenant must already exist, with an `owner` user. Register it at `/register`.
- Copy `.env.example` to `.env` and fill the migration block. Nothing here belongs in the repo, and
  `domexa-export/` is git-ignored and dockerignored.
- The Domexa API shape below is what their frontend bundle calls. Unit, contact and building **row**
  shapes were never observable (the demo account was empty), so the field mapping is a best guess and
  `report.md` names every field it did not understand. Expect to run `transform` twice.

| Variable | What it is |
| --- | --- |
| `DOMEXA_BASE_URL` | `https://domexa.mk`, or `https://domexa.mk/<org>` if the API is nested |
| `DOMEXA_ORG` | the organization slug you type on their login page |
| `DOMEXA_EMAIL`, `DOMEXA_PASSWORD` | a user who may read everything |
| `DOMEXA_COOKIE` | `name=value` copied from a logged-in browser; skips the login entirely |
| `DOMAR_URL` | `http://localhost:3001` for a rehearsal; anything else needs `--yes` |
| `DOMAR_SLUG`, `DOMAR_EMAIL`, `DOMAR_PASSWORD` | the target tenant and its owner |

If their login answers with a Cloudflare challenge, log in with a browser, copy the session cookie
out of the developer tools and put it in `DOMEXA_COOKIE`. Then leave `DOMEXA_PASSWORD` empty.

## 1. Export

    pnpm --filter @domar/api migrate:domexa -- export

Writes raw, uninterpreted JSON into `domexa-export/`: `organization.json`, `tax-rates.json`,
`services.json`, `service-categories.json`, `contacts.json`, `statements.json` (keyed by contact id),
`buildings.json`, and `units.json`, `building-services.json`, `reserve-funds.json`,
`reserve-fund-balances.json` (each keyed by building id). Every request is logged as method and path.
An endpoint that answers 403 or 404 leaves a `null` behind and the export carries on.

## 2. Transform

    pnpm --filter @domar/api migrate:domexa -- transform --from 2026-09

Writes `domexa-export/domar/`:

- `units-<building>.csv` — our units/owners template, one per building, with the owner's opening
  balance taken from their contact statement's closing balance (positive = the owner owes) and
  placed on their **first** unit only.
- `tax-rates.json`, `services.json`, `buildings.json`, `building-services.json`, `reserve-fund.json`
  — request bodies with names where domar will have ids (`taxRateName`, `serviceName`, `buildingKey`).
- `organization.json` — their company row, for you to copy into Settings by hand. The migration does
  not touch tenant settings.
- `report.md` — counts, every source field nothing consumed, every skipped row and every guess.

`--from` is the period a recurring service starts from when Domexa's row carries no start date; it
defaults to the current month.

### The mapping file

When `report.md` lists a field under "Unknown fields" that should have been imported, write a JSON
file and pass `--map map.json`. It overrides one subtree of the defaults at a time:

```json
{
  "unit": {
    "label": ["broj", "number"],
    "areaM2": ["povrsina", "area"]
  },
  "statement": { "closingBalance": ["saldo"] }
}
```

Each value is a list of candidate paths, tried in order; `owner.firstName` walks into a nested
object. Anything you do not mention keeps the default from
`packages/domain/src/migration/domexa.ts` (`DEFAULT_FIELD_MAP`).

## 3. Apply

    pnpm --filter @domar/api migrate:domexa -- apply --dry-run
    pnpm --filter @domar/api migrate:domexa -- apply

The dry run performs every read and no write, and prints the same summary the real run prints. The
real run creates, in order: tax rates, services, buildings, units (through the ordinary CSV import,
with `mode: 'skip'`), building services, the reserve fund setting and the reserve fund's opening
balance.

It is idempotent, and matches on:

| Entity | Matched by | A second run |
| --- | --- | --- |
| tax rate | exact name | reuses it |
| service | exact name | reuses it |
| building | exact name | reuses it |
| unit | label inside the building | skips it (no duplicate, no second contact) |
| contact | email, else exact first + last name | reuses it |
| building service | service id inside the building | reuses it |
| reserve fund setting | the building | `PUT` again, same result |
| reserve fund opening balance | booked only into a fund whose balance is exactly 0 | skips it |

`apply` refuses any `DOMAR_URL` that is not `http://localhost…` or `http://127.0.0.1…` unless you
add `--yes`. Rehearse against a local server first, look at the tenant, then repeat against the real
one.

## What is not migrated

- **Invoices and their line items.** Domexa's invoices were produced by Domexa's own calculation and
  numbering; re-issuing them in domar would produce different documents under the same numbers. What
  each owner still owes arrives instead as **one opening balance per owner**, from their statement's
  closing balance, so every ledger starts at the right number.
- **Payments and the payment history.** Same reason: they are netted into that opening balance.
- **Reminders, e-mail logs, audit history, users, invoice numbering counters, card-payment settings,
  organization settings and the reserve fund's expense history.** Create the users by hand in
  Settings → Users, and copy the company details into Settings → Organization.
- **Unit "attached to" links.** domar has the column; Domexa's field name for it was not observable.
  If `report.md` names it, add it to your mapping file and set the links by hand afterwards.

## After the migration

1. Settings → Organization: company number, VAT number, bank, timezone.
2. Settings → Users: one user per employee.
3. Each building: check the units, the owners and the "Opening balances" tab against `report.md`.
4. Only then open the first period.
````

In `README.md`, add a section after "Billing":

```markdown
## Migrating from another system

The building "Import" tab takes CSV and XLSX with a column-mapping step. A whole company can be
brought over from Domexa with `pnpm --filter @domar/api migrate:domexa -- export|transform|apply`;
see `docs/MIGRATION.md`.
```

- [ ] **Step 3: Run**

Run: `pnpm install && pnpm db:up && pnpm e2e`
Expected: 7 specs pass (`smoke`, `billing`, `payments`, `pilot`, `reminders`, `portal`, `import-xlsx`). Run it twice — each run registers a fresh slug, so the second run must pass unchanged. Then `pnpm test && pnpm typecheck && pnpm lint` from the root for the whole workspace.

- [ ] **Step 4: Commit**

```bash
git add docs/MIGRATION.md README.md e2e pnpm-lock.yaml
git commit -m "docs(migration): runbook for the Domexa migration, plus an xlsx e2e" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review notes

**Spec §20 coverage**

- §20.1 *XLSX and free-form headers, without touching the API* — T1 exports `matchImportHeader`, `normaliseKind` and `IMPORT_FIELDS` out of the parser's own alias tables (one table, two readers) and adds `rowsToCanonicalCsv`. T2 reads the first sheet with SheetJS in the browser, shows one `<select>` per target field prefilled from `matchImportHeader`, lists the unmapped source columns, refuses a target mapped twice, remembers the mapping in `localStorage` keyed by the sorted source headers, serialises to the canonical `;` CSV and hands it to the **unchanged** `POST /api/buildings/:id/import/units` (dry run → commit). Kind values are normalised by the parser server-side, exactly as before. No file under `apps/api/src` is touched by T1–T3 or T6.
- §20.2 *Domexa migration is a CLI, read-only against Domexa* — T4 gives `export` (login by org/email/password **or** `DOMEXA_COOKIE`, every endpoint of the spec's list, `{ rows, total, page, pageSize }` pagination, raw JSON into `./domexa-export/`). T5 gives `transform` (the spec's exact output list: `units-<building>.csv`, `services.json`, `building-services.json`, `reserve-fund.json`, `organization.json`, `report.md`, plus `tax-rates.json` and `buildings.json` which `apply` needs) and `apply` (login to domar, tax rates and services first, then buildings, the CSV import, building services, the fund setting and its opening balance; `--dry-run`; idempotent by name/label). One deviation from the letter of §20.2: the entry point is `apps/api/scripts/domexa/cli.ts` with four sibling modules rather than a single `apps/api/scripts/migrate-from-domexa.ts`, because a single file would be ~700 lines and the client and apply layers are exactly the two pieces that needed their own tests. The invocation the spec names is unchanged: `pnpm --filter @domar/api migrate:domexa -- <command>`.
- §20.3 *Transforms are pure and tested* — T3 is `packages/domain/src/migration/domexa.ts`: `DEFAULT_FIELD_MAP`, `domexaUnitsToImportRows`, `domexaServicesToDomar`, `domexaBuildingServicesToDomar`, `domexaReserveFundToDomar`, `statementToOpeningBalance` (plus `domexaTaxRatesToDomar` and `domexaBuildingsToDomar`, which `apply` needs and the spec's prose implies), all pure, all reading through `firstOf(row, paths)`, all recording into a `MigrationReport`, none throwing on a row — the test drives `[null, 42, {…}]` through the unit transform to prove it. Fixture JSON lives in the test; the observed shapes (`/api/tax-rates`, `/api/organization`) are used verbatim and the unobservable ones are marked as invented in a comment.
- §20.4 *Safety* — no credential is written to a file or a log line anywhere (the client logs method and path only, and a test asserts the cookie value never reaches the log); `domexa-export` is added to `.gitignore` and `.dockerignore` in T4, in the commit that first creates the folder; `runApply` throws before logging in when `DOMAR_URL` is not localhost and `--yes` is absent, and a test asserts the message; every Domexa and domar call is logged with method and path; `assertReadOnly` makes a non-GET Domexa call impossible by construction and is unit-tested for `POST`, `PUT` and `DELETE`.

**Interfaces consumed across tasks**

- T1 → T2 (`matchImportHeader`, `IMPORT_FIELDS`, `ImportField`, `CANONICAL_HEADER`, `emptyImportRow`, `rowsToCanonicalCsv`, `splitCsvLine`), T1 → T3 (`normaliseKind`, `emptyImportRow`, `ImportField`), T1 → T5 (`rowsToCanonicalCsv` through `@domar/domain`).
- T2 → T6 (every `import-map-*` hook and the select option values, which are column indexes as strings).
- T3 → T5 (all nine transform exports plus `MigrationReport`, `mergeReports`, `reportToMarkdown`, `buildingKeyOf`, `separatorsFromOrganization`).
- T4 → T5 (`DomexaClient` for the CLI's `export` branch and the `domexa-export/` file layout `runTransform` reads), T4 → T6 (the CLI's command names and flags, which `docs/MIGRATION.md` documents).
- T5 → T6 (the `apply` summary and the idempotency table in the runbook).
- Unchanged existing interfaces reused: `parseUnitImport`, `splitCsvLine`, `mkPack.parseAmountToMinor`, `api.post`, `UnitImportResult`, `AppButton`, `DataTable`, `formatMoney`, `createTestApp`, `registerTenant`, and every route `apply` calls. **No existing signature is widened or narrowed in this plan.** The only behavioural change to existing code is `ImportTab.vue`'s file `accept` list, its `imports.file` label, and `TEMPLATE` being built from `CANONICAL_HEADER` instead of a duplicate literal.

**Numbers and strings the tests lock**

- T1: `'број;кат;тип;површина;удел;име;презиме;е-пошта;телефон;почетно салдо'`; `"A;1";1 2;apartment;;;;"Марков ""Мар""";;;0`; `-450.50` → `-45050` through the parser; `matchImportHeader('Почетно  салдо') === 'openingBalance'`; `normaliseKind('  Деловен Простор ') === 'commercial'`.
- T2: the exact preview body `{ content: MAPPED_CSV, mode: 'fail', dryRun: true }`; prefilled select values `'1'` (Кат → floor) and `'5'` (Презиме → ownerLastName); `domar.importMapping.` + 8 hex; `mappingKey(['b','a']) === mappingKey(['A',' b '])`.
- T3: the exact three-line CSV with `1234.56`, `-450.50` and `0`; `report.counts` `{ units: 4, rows: 3, owners: 2, openingBalances: 2 }`; `unknownFields: ['attachedToUnitId']`; the two note strings; `'18.00'` → `1800`; `'1.234,56'` → `123456`; `'35000.00'` → `3500000`; `buildingKeyOf('b 1/2') === 'b-1-2'`.
- T4: three GET calls at `?page=1&pageSize=1` … `?page=3&pageSize=1`, the log lines containing neither `s3cret` nor a body, `403 on /api/organization`, and the session cookie `domexa_session=zzz` on the call after the login.
- T5: `units-b1.csv` byte-for-byte; both `runApply` summaries (`{ created: 2, existing: 0 }` → `{ created: 0, existing: 2 }` for tax rates, `imported: 3` → `imported: 0, skipped: 3` for units); 6 tax rates after the first run and still 6 after the second; `taxRateBp: 1800` on the created service; opening balances `123456` and `-45050`; reserve fund `balanceMinor: 3500000` after both runs; a dry run leaving 4 tax rates, 0 services and 0 buildings.
- T6: `Јане Сандански 5`, `3` units, `2 / 0` contacts, the prefilled `'1'`/`'5'` selects, and the remembered `'0'`/`'2'` on the second upload.

**Diff size** — T5 is the largest (≈590 lines across 5 files, ~240 of them the two test files) and is the one task a reviewer could split further, along the transform/apply line; T3 ≈570, T2 ≈480, T4 ≈420, T6 ≈310, T1 ≈220.

**Placeholder scan** — every file is given in full or as an exact, quotable edit against a named line. There is no `TODO`, no `...`, no "implement similarly", and no test whose expected value is left to the implementer. The edits described rather than pasted whole are `packages/domain/src/import/units.ts` (six quoted replacements, each with its surrounding line), `packages/domain/src/index.ts`, `packages/domain/src/statements/index.ts`, `apps/api/tsconfig.json`, `apps/api/package.json`, `apps/web/package.json`, `apps/web/vitest.config.ts`, `e2e/package.json`, `.gitignore`, `.dockerignore`, `.env.example` and the two i18n files, which are quoted as whole blocks.

**One risk called out rather than hidden** — the Domexa unit, contact, building, service, building-service and reserve-fund **row** shapes were never observable, so `DEFAULT_FIELD_MAP`, `DOMEXA_UNIT_KINDS` and the pricing/basis alias tables are educated guesses built from the Macedonian product guide and from the two response shapes that *were* captured (`/api/organization`, `/api/tax-rates`). The design that carries the risk is the mapping file (`transform --map`), the tolerant accessors and `report.md`: a wrong guess shows up as a named entry under "Unknown fields" and is fixed by a JSON file, never by a code change. Task 3's fixtures are therefore explicitly labelled as invented in the test, and Task 5's transform test is what proves the override path works end to end.

**Signatures double-checked against the code** — `importUnitsBody` is `{ content, mode: 'fail'|'skip', dryRun, force }` and the response carries `counts.{units,newContacts,existingContacts,openingBalances,conflicts}` (`apps/api/src/resources/import/schema.ts`), which is what `runApply` reads. `serviceCreate` takes `{ name, category, description, pricing, defaultPriceMinor, taxRateId?, appliesTo, recurring }`; `buildingCreate` takes `{ name, address, city, postalCode, … }`; `buildingServiceCreate` takes `{ serviceId, priceMinor?, pricing?, frequency, intervalMonths, startsPeriod, endsPeriod? }`; `settingPut` takes `{ basis, amountMinor, appliesTo, active }`; `openingBalanceBody` takes `{ amountMinor, note }`; `taxRateCreate` takes `{ name, rateBp, isDefault? }`; `POST /api/auth/login` takes `{ tenantSlug, email, password }`. Tax rates and services list under `?includeInactive=true`; buildings and building services list plainly; all of them answer `{ rows: [...] }` and `/api/contacts` answers `{ rows, total }`. `GET /api/buildings/:id/reserve-fund` answers `{ setting, balanceMinor, contributionsBilledMinor }`.
