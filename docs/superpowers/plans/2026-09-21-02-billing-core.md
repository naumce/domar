# Domar Billing Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A manager defines services, attaches recurring ones to a building, sets the reserve fund and management fee, opens a monthly period, generates one draft invoice per owner with the Art. 33 layout, reviews and publishes them, and downloads the PDF — with every charge written to the ledger.

**Architecture:** A pure calculation engine in `@domar/domain` turns a building's units, period lines, reserve-fund setting and management fee into invoice drafts (deterministic, fixture-tested). `@domar/db` adds services, building services, reserve fund settings, expenses, billing periods, period lines, invoices, invoice lines, postings and an invoice-number sequence. `apps/api` adds the resources and the generate/publish workflow, writing `charge` postings to owner sub-accounts and reading fund balances from postings. `apps/web` adds a services page and building tabs (services, reserve fund, periods) plus a period page and an invoice page. PDF is server-rendered HTML.

**Tech Stack:** as Foundation (Node 24, pnpm 10, TypeScript strict, Fastify 5 + zod, Drizzle + Postgres 16, Vue 3 + Vite + vue-i18n + Tailwind 4, Vitest, Playwright). PDF via `playwright-core` driving the locally installed Chrome/Chromium, behind an HTML renderer that is unit-tested on its own.

**Spec:** `docs/superpowers/specs/2026-09-21-domar-phase1-design.md` §3, §4, §6, §7, §11, §13, §15 item 2, §16. Foundation plan (patterns, helpers): `docs/superpowers/plans/2026-09-21-01-foundation.md`.

## Global Constraints

- Everything in the Foundation plan's Global Constraints still applies (Node ≥24, pnpm ≥10, TS strict + `exactOptionalPropertyTypes`, ESM `.js` imports, `tenant_id` + leading index on every tenant table, `bigint` `_minor` money columns, i18n parity, conventional commits, run from repo root, Postgres on 54329).
- Money in TypeScript is an integer number of minor units; all arithmetic goes through `@domar/domain` (`mulMinor`, `applyTaxBp`, `allocateLargestRemainder`, `divRoundHalfUp`). Never `*`/`/` on money outside those helpers.
- Periods are strings `YYYY-MM` (regex `/^\d{4}-(0[1-9]|1[0-2])$/`), computed in the tenant's timezone only at the API boundary (`issuedAt`/`dueAt` are dates; the period itself is a label).
- Repository functions take `(db, ctx: TenantContext, ...)`; every query filters `ctx.tenantId`; every mutation runs in a transaction and writes an audit row via `writeAudit(tx, ctx, ...)`; foreign-tenant rows read as 404; write routes require `owner`/`accountant` (`requireRole(...WRITE_ROLES)`), all routes `app.requireAuth`.
- Resource pattern: `apps/api/src/resources/<name>/{schema,repo,routes}.ts`, shared helpers from `apps/api/src/resources/common.ts` (`idParam`, `pageQuery`, `nullableStr`, `stripUndefined`) and `apps/api/src/errors.ts` (`AppError`, `notFound`, `badRequest`, `conflict`, `isUniqueViolation`).
- Ledger sign convention (binding for sub-plans 3–5): `postings.account = 'owner'` rows are the owner sub-account — a `charge` is **positive** (owner owes more), a `payment` is **negative**. `postings.account = 'fund'` rows are the building fund cash view — `opening` and `payment` are **positive**, `expense` **negative**. Owner balance = Σ owner rows for the contact; fund balance = Σ fund rows for (building, fund). Charges never touch fund rows.
- Invoice numbering: assigned only at publish, per tenant per calendar year, from `invoice_sequences`, format `${prefix}${seq padded to 4}${suffix with {year} replaced}`; unique per tenant.
- Period lifecycle: `open` → (generate) `generated` → (publish) `published`. Lines are editable in `open` and `generated`; generating again in `generated` deletes the period's draft invoices, their lines and their `charge` postings, then recreates them. `published` is immutable (corrections are sub-plan 3+).

## Design addendum (decisions not in the spec)

1. **Reserve fund and management fee are engine lines, not stored `period_lines`.** At generation the period builder appends a `reserve_fund` line (from the building's reserve fund setting: `per_unit` → `fixed_per_unit`, `per_m2` → `per_m2`, tax 0, fund `reserve`) and a `management_fee` line (from the period's fee fields, fund `regular`). Both are snapshotted into `invoice_lines` with their `kind`, so the PDF shows them separately as Art. 33 requires.
2. **Attached units bill to the target's owner.** A parking/storage unit with `attached_to_unit_id` set is still covered by lines that apply to its own kind, but its amounts land on the invoice of the owner of the target unit. If the target does not exist in the building, the unit is treated as unattached.
3. **Units without a billing owner are skipped** with a warning; their share of `shared_total` lines is computed (so the building-wide amount stays correct) but not invoiced. The UI shows the warnings before publish.
4. **One reserve fund setting row per building** (`unique(building_id)`); history is the audit log. Opening balance is an `opening` posting on the fund.
5. **Service tax**: `services.tax_rate_id` nullable; `null` means 0%. The period line snapshots `tax_rate_bp` at the time it is created (or refreshed), not at publish.
6. **Frequency**: `monthly` (every period) or `every_n_months` with `interval_months ≥ 2`, due when `monthsBetween(starts_period, period) % interval_months === 0` and `starts_period ≤ period ≤ ends_period`.
7. **Auto lines refresh**: `POST /periods/:id/refresh-lines` rebuilds `source='auto'` lines from the current building services (deleting stale auto lines, keeping manual ones); creating a period does this once. Editing an auto line flips it to `source='manual'` (the plan's "Авто" badge disappears), matching the guide's behaviour.
8. **Due date**: `dueAt = issuedAt + tenant default 15 days` at publish; `issuedAt` = publish time. Both stored on the invoice; the period stores `issued_at`/`due_at` as well for the summary.
9. **Cancelling**: a draft can be deleted; `published` invoices cannot (Foundation of sub-plan 3's credit notes). `DELETE /periods/:id/drafts` removes all drafts + postings and returns the period to `open`... no: to `open` only if no manual lines were harmed — lines are untouched, so status → `open`.
10. **PDF**: `renderInvoiceHtml(invoice, options)` is pure and tested; `htmlToPdf(html)` uses `playwright-core` with `channel: 'chrome'` (env `PDF_BROWSER_CHANNEL`, default `chrome`; if launch fails the API returns `503 pdf_unavailable`). The HTML route `GET /api/invoices/:id/html` is what the e2e and tests assert; the PDF route is exercised manually.

---

### Task 1: Calculation engine (`@domar/domain`)

**Files:**
- Create: `packages/domain/src/calculation/types.ts`, `packages/domain/src/calculation/engine.ts`, `packages/domain/src/calculation/index.ts`, `packages/domain/src/period.ts`
- Create: `packages/domain/test/engine.test.ts`, `packages/domain/test/period.test.ts`
- Modify: `packages/domain/src/index.ts` (export `./calculation/index.js` and `./period.js`)

**Interfaces:**
- Produces (exact names later tasks import):
  - Types: `UnitKind`, `PricingModel = 'fixed_per_unit'|'per_m2'|'shared_total'`, `Fund = 'regular'|'reserve'`, `ShareBasis = 'area'|'equal'|'custom'`, `LineKind = 'service'|'manual'|'reserve_fund'|'management_fee'`, `CalcUnit`, `CalcLine`, `CalcInput`, `InvoiceDraftLine`, `InvoiceDraft`, `CalcWarning`, `CalcResult`.
  - `calculatePeriod(input: CalcInput): CalcResult` — pure, deterministic.
  - `isValidPeriod(p: string): boolean`, `comparePeriods(a, b): number`, `monthsBetween(from, to): number` (to − from in months), `nextPeriod(p)`, `periodStartDate(p, timeZone): Date` (UTC instant of local midnight on the 1st), `isServiceDue(p, { frequency, intervalMonths, startsPeriod, endsPeriod })`.

- [ ] **Step 1: Write the failing tests**

`packages/domain/test/period.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { comparePeriods, isServiceDue, isValidPeriod, monthsBetween, nextPeriod, periodStartDate } from '../src/period.js';

describe('period helpers', () => {
  it('validates YYYY-MM', () => {
    expect(isValidPeriod('2026-09')).toBe(true);
    expect(isValidPeriod('2026-13')).toBe(false);
    expect(isValidPeriod('2026-9')).toBe(false);
    expect(isValidPeriod('202609')).toBe(false);
  });
  it('compares and steps periods', () => {
    expect(comparePeriods('2026-09', '2026-10')).toBeLessThan(0);
    expect(comparePeriods('2026-10', '2026-10')).toBe(0);
    expect(nextPeriod('2026-12')).toBe('2027-01');
    expect(monthsBetween('2026-01', '2026-09')).toBe(8);
    expect(monthsBetween('2025-11', '2026-02')).toBe(3);
    expect(monthsBetween('2026-09', '2026-01')).toBe(-8);
  });
  it('gives the UTC instant of local midnight on the 1st', () => {
    expect(periodStartDate('2026-09', 'Europe/Skopje').toISOString()).toBe('2026-08-31T22:00:00.000Z'); // CEST = UTC+2
    expect(periodStartDate('2026-01', 'Europe/Skopje').toISOString()).toBe('2025-12-31T23:00:00.000Z'); // CET = UTC+1
  });
  it('decides when a recurring service is due', () => {
    const monthly = { frequency: 'monthly' as const, intervalMonths: 1, startsPeriod: '2026-03', endsPeriod: null };
    expect(isServiceDue('2026-02', monthly)).toBe(false);
    expect(isServiceDue('2026-03', monthly)).toBe(true);
    expect(isServiceDue('2027-07', monthly)).toBe(true);
    const quarterly = { frequency: 'every_n_months' as const, intervalMonths: 3, startsPeriod: '2026-01', endsPeriod: '2026-12' };
    expect(isServiceDue('2026-01', quarterly)).toBe(true);
    expect(isServiceDue('2026-02', quarterly)).toBe(false);
    expect(isServiceDue('2026-04', quarterly)).toBe(true);
    expect(isServiceDue('2026-10', quarterly)).toBe(true);
    expect(isServiceDue('2027-01', quarterly)).toBe(false); // after endsPeriod
  });
});
```

`packages/domain/test/engine.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { calculatePeriod, type CalcInput } from '../src/calculation/index.js';

const input: CalcInput = {
  building: { id: 'b1', shareBasis: 'area' },
  units: [
    { id: 'A', label: '1', kind: 'apartment', areaM2: 50, ownershipShare: null, ownerContactId: 'O1', attachedToUnitId: null },
    { id: 'B', label: '2', kind: 'apartment', areaM2: 75, ownershipShare: null, ownerContactId: 'O2', attachedToUnitId: null },
    { id: 'C', label: 'L1', kind: 'commercial', areaM2: 100, ownershipShare: null, ownerContactId: 'O3', attachedToUnitId: null },
    { id: 'P1', label: 'P-1', kind: 'parking', areaM2: null, ownershipShare: null, ownerContactId: null, attachedToUnitId: 'A' },
    { id: 'S1', label: 'S-1', kind: 'storage', areaM2: 10, ownershipShare: null, ownerContactId: null, attachedToUnitId: null },
  ],
  lines: [
    { id: 'l-clean', kind: 'service', description: 'Чистење', pricing: 'fixed_per_unit', quantity: 1, unitPriceMinor: 30000, taxRateBp: 1800, appliesTo: ['apartment', 'commercial'], fund: 'regular' },
    { id: 'l-lift', kind: 'service', description: 'Лифт', pricing: 'shared_total', quantity: 1, unitPriceMinor: 600000, taxRateBp: 1800, appliesTo: [], fund: 'regular' },
    { id: 'l-park', kind: 'manual', description: 'Осветлување паркинг', pricing: 'fixed_per_unit', quantity: 1, unitPriceMinor: 2000, taxRateBp: 1800, appliesTo: ['parking'], fund: 'regular' },
    { id: 'l-rf', kind: 'reserve_fund', description: 'Резервен фонд', pricing: 'per_m2', quantity: 1, unitPriceMinor: 1000, taxRateBp: 0, appliesTo: ['apartment', 'commercial'], fund: 'reserve' },
    { id: 'l-fee', kind: 'management_fee', description: 'Управување', pricing: 'fixed_per_unit', quantity: 1, unitPriceMinor: 15000, taxRateBp: 1800, appliesTo: ['apartment', 'commercial'], fund: 'regular' },
  ],
  previousBalances: { O1: 5000, O3: -1200 },
  reserveFundBuildingBalanceMinor: 3500000,
};

describe('calculatePeriod', () => {
  const result = calculatePeriod(input);
  const byOwner = Object.fromEntries(result.invoices.map((i) => [i.contactId, i]));

  it('produces one invoice per billing owner, in first-appearance order', () => {
    expect(result.invoices.map((i) => i.contactId)).toEqual(['O1', 'O2', 'O3']);
  });

  it('folds an attached parking unit into the apartment owner invoice', () => {
    expect(byOwner.O1!.unitIds).toEqual(['A', 'P1']);
    const park = byOwner.O1!.lines.find((l) => l.lineId === 'l-park')!;
    expect(park).toMatchObject({ unitId: 'P1', ownerNetMinor: 2000, ownerTaxMinor: 360, ownerGrossMinor: 2360, buildingWideNetMinor: 2000 });
  });

  it('splits a shared total by area with largest remainder and reports building-wide amounts', () => {
    const liftA = byOwner.O1!.lines.find((l) => l.lineId === 'l-lift')!;
    const liftB = byOwner.O2!.lines.find((l) => l.lineId === 'l-lift')!;
    const liftC = byOwner.O3!.lines.find((l) => l.lineId === 'l-lift')!;
    expect([liftA.ownerNetMinor, liftB.ownerNetMinor, liftC.ownerNetMinor]).toEqual([127660, 191489, 255319]);
    expect([liftA.ownerTaxMinor, liftB.ownerTaxMinor, liftC.ownerTaxMinor]).toEqual([22979, 34468, 45957]);
    expect(liftA.buildingWideNetMinor).toBe(600000);
  });

  it('charges the reserve fund per m² tax-free on the reserve fund', () => {
    const rf = byOwner.O2!.lines.find((l) => l.lineId === 'l-rf')!;
    expect(rf).toMatchObject({ kind: 'reserve_fund', fund: 'reserve', ownerNetMinor: 75000, ownerTaxMinor: 0, ownerGrossMinor: 75000, buildingWideNetMinor: 225000 });
  });

  it('totals each invoice and carries the previous balance', () => {
    expect(byOwner.O1).toMatchObject({ subtotalMinor: 224660, taxMinor: 31439, totalMinor: 256099, previousBalanceMinor: 5000, amountDueMinor: 261099 });
    expect(byOwner.O2).toMatchObject({ subtotalMinor: 311489, taxMinor: 42568, totalMinor: 354057, previousBalanceMinor: 0, amountDueMinor: 354057 });
    expect(byOwner.O3).toMatchObject({ subtotalMinor: 400319, taxMinor: 54057, totalMinor: 454376, previousBalanceMinor: -1200, amountDueMinor: 453176 });
  });

  it('snapshots the reserve fund building balance on every invoice', () => {
    expect(result.invoices.every((i) => i.reserveFundBuildingBalanceMinor === 3500000)).toBe(true);
  });

  it('warns about missing area and unowned units, and skips unowned units', () => {
    expect(result.warnings).toContainEqual({ code: 'missing_area', unitId: 'P1', lineId: 'l-lift' });
    expect(result.warnings).toContainEqual({ code: 'no_owner', unitId: 'S1' });
    expect(result.skippedUnits).toEqual([{ unitId: 'S1', reason: 'no_owner' }]);
    expect(result.invoices.some((i) => i.unitIds.includes('S1'))).toBe(false);
  });

  it('is deterministic', () => {
    expect(calculatePeriod(input)).toEqual(result);
  });

  it('skips a shared line whose covered units have no weight and warns', () => {
    const r = calculatePeriod({ ...input, lines: [{ id: 'x', kind: 'manual', description: 'x', pricing: 'shared_total', quantity: 1, unitPriceMinor: 1000, taxRateBp: 0, appliesTo: ['parking'], fund: 'regular' }] });
    expect(r.warnings).toContainEqual({ code: 'no_weight', lineId: 'x' });
    expect(r.invoices).toEqual([]);
  });

  it('uses equal and custom share bases', () => {
    const equal = calculatePeriod({ ...input, building: { id: 'b1', shareBasis: 'equal' }, lines: [input.lines[1]!] });
    // 5 covered units incl. P1 and S1; 600000/5 = 120000 each; S1 skipped (no owner)
    expect(equal.invoices.map((i) => i.lines.reduce((s, l) => s + l.ownerNetMinor, 0))).toEqual([240000, 120000, 120000]); // O1 gets A + P1
    const custom = calculatePeriod({
      ...input,
      building: { id: 'b1', shareBasis: 'custom' },
      units: input.units.map((u) => ({ ...u, ownershipShare: u.id === 'A' ? 0.5 : u.id === 'B' ? 0.3 : u.id === 'C' ? 0.2 : null })),
      lines: [{ ...input.lines[1]!, appliesTo: ['apartment', 'commercial'] }],
    });
    expect(custom.invoices.map((i) => i.lines[0]!.ownerNetMinor)).toEqual([300000, 180000, 120000]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @domar/domain test`
Expected: FAIL, cannot resolve `../src/period.js` and `../src/calculation/index.js`.

- [ ] **Step 3: Implement**

`packages/domain/src/period.ts`:
```ts
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidPeriod(p: string): boolean {
  return PERIOD_RE.test(p);
}

function parts(p: string): [number, number] {
  if (!isValidPeriod(p)) throw new RangeError(`invalid period: ${p}`);
  return [Number(p.slice(0, 4)), Number(p.slice(5, 7))];
}

export function comparePeriods(a: string, b: string): number {
  return monthsBetween(b, a);
}

/** to − from, in whole months. */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm] = parts(from);
  const [ty, tm] = parts(to);
  return (ty - fy) * 12 + (tm - fm);
}

export function nextPeriod(p: string): string {
  const [y, m] = parts(p);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

/** UTC instant of local midnight on the first day of the period in the given IANA zone. */
export function periodStartDate(p: string, timeZone: string): Date {
  const [y, m] = parts(p);
  const guess = Date.UTC(y, m - 1, 1, 0, 0, 0);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const local = fmt.formatToParts(new Date(guess));
  const get = (t: string) => Number(local.find((x) => x.type === t)!.value);
  const localAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  const offset = localAsUtc - guess; // zone offset at that instant
  return new Date(guess - offset);
}

export interface RecurrenceRule {
  frequency: 'monthly' | 'every_n_months';
  intervalMonths: number;
  startsPeriod: string;
  endsPeriod: string | null;
}

export function isServiceDue(period: string, rule: RecurrenceRule): boolean {
  if (comparePeriods(period, rule.startsPeriod) < 0) return false;
  if (rule.endsPeriod && comparePeriods(period, rule.endsPeriod) > 0) return false;
  if (rule.frequency === 'monthly') return true;
  const interval = Math.max(2, Math.trunc(rule.intervalMonths));
  return monthsBetween(rule.startsPeriod, period) % interval === 0;
}
```

`packages/domain/src/calculation/types.ts`:
```ts
export type UnitKind = 'apartment' | 'commercial' | 'parking' | 'storage' | 'other';
export type PricingModel = 'fixed_per_unit' | 'per_m2' | 'shared_total';
export type Fund = 'regular' | 'reserve';
export type ShareBasis = 'area' | 'equal' | 'custom';
export type LineKind = 'service' | 'manual' | 'reserve_fund' | 'management_fee';

export interface CalcUnit {
  id: string;
  label: string;
  kind: UnitKind;
  areaM2: number | null;
  ownershipShare: number | null;
  ownerContactId: string | null;
  attachedToUnitId: string | null;
}

export interface CalcLine {
  id: string;
  kind: LineKind;
  description: string;
  pricing: PricingModel;
  quantity: number;
  unitPriceMinor: number;
  taxRateBp: number;
  /** empty = applies to all unit kinds */
  appliesTo: UnitKind[];
  fund: Fund;
}

export interface CalcInput {
  building: { id: string; shareBasis: ShareBasis };
  units: CalcUnit[];
  lines: CalcLine[];
  /** outstanding owner balances before this period, by contact id (positive = owes) */
  previousBalances: Record<string, number>;
  reserveFundBuildingBalanceMinor: number;
}

export interface InvoiceDraftLine {
  lineId: string;
  kind: LineKind;
  description: string;
  fund: Fund;
  unitId: string;
  unitLabel: string;
  buildingWideNetMinor: number;
  ownerNetMinor: number;
  taxRateBp: number;
  ownerTaxMinor: number;
  ownerGrossMinor: number;
}

export interface InvoiceDraft {
  contactId: string;
  unitIds: string[];
  lines: InvoiceDraftLine[];
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  previousBalanceMinor: number;
  amountDueMinor: number;
  reserveFundBuildingBalanceMinor: number;
}

export type CalcWarning =
  | { code: 'missing_area'; unitId: string; lineId: string }
  | { code: 'missing_share'; unitId: string; lineId: string }
  | { code: 'no_owner'; unitId: string }
  | { code: 'no_weight'; lineId: string };

export interface CalcResult {
  invoices: InvoiceDraft[];
  warnings: CalcWarning[];
  skippedUnits: { unitId: string; reason: 'no_owner' }[];
}
```

`packages/domain/src/calculation/engine.ts`:
```ts
import { allocateLargestRemainder, applyTaxBp, mulMinor } from '../money.js';
import type { CalcInput, CalcLine, CalcResult, CalcUnit, CalcWarning, InvoiceDraft, InvoiceDraftLine } from './types.js';

/** The owner who receives a unit's charges: the attach target's owner when attached, else the unit's own owner. */
function billingOwner(unit: CalcUnit, byId: Map<string, CalcUnit>): string | null {
  if (unit.attachedToUnitId) {
    const target = byId.get(unit.attachedToUnitId);
    if (target) return target.ownerContactId;
  }
  return unit.ownerContactId;
}

function covers(line: CalcLine, unit: CalcUnit): boolean {
  return line.appliesTo.length === 0 || line.appliesTo.includes(unit.kind);
}

/** Net amount per covered unit for one line, in unit order. Pushes warnings. */
function perUnitNet(line: CalcLine, units: CalcUnit[], shareBasis: CalcInput['building']['shareBasis'], warnings: CalcWarning[]): number[] {
  switch (line.pricing) {
    case 'fixed_per_unit':
      return units.map(() => mulMinor(line.unitPriceMinor, line.quantity));
    case 'per_m2':
      return units.map((u) => {
        if (u.areaM2 === null) {
          warnings.push({ code: 'missing_area', unitId: u.id, lineId: line.id });
          return 0;
        }
        return mulMinor(line.unitPriceMinor, line.quantity * u.areaM2);
      });
    case 'shared_total': {
      const total = mulMinor(line.unitPriceMinor, line.quantity);
      const weights = units.map((u) => {
        if (shareBasis === 'equal') return 1;
        if (shareBasis === 'area') {
          if (u.areaM2 === null) {
            warnings.push({ code: 'missing_area', unitId: u.id, lineId: line.id });
            return 0;
          }
          return u.areaM2;
        }
        if (u.ownershipShare === null) {
          warnings.push({ code: 'missing_share', unitId: u.id, lineId: line.id });
          return 0;
        }
        return u.ownershipShare;
      });
      if (weights.every((w) => w === 0)) {
        warnings.push({ code: 'no_weight', lineId: line.id });
        return units.map(() => 0);
      }
      return allocateLargestRemainder(total, weights);
    }
  }
}

export function calculatePeriod(input: CalcInput): CalcResult {
  const warnings: CalcWarning[] = [];
  const byId = new Map(input.units.map((u) => [u.id, u]));
  const ownerOf = new Map(input.units.map((u) => [u.id, billingOwner(u, byId)]));

  const skipped: CalcResult['skippedUnits'] = [];
  for (const u of input.units) {
    if (ownerOf.get(u.id) === null) {
      warnings.push({ code: 'no_owner', unitId: u.id });
      skipped.push({ unitId: u.id, reason: 'no_owner' });
    }
  }

  // contactId -> draft, insertion order = first appearance over lines then units
  const drafts = new Map<string, InvoiceDraft>();
  const draftFor = (contactId: string): InvoiceDraft => {
    let d = drafts.get(contactId);
    if (!d) {
      d = { contactId, unitIds: [], lines: [], subtotalMinor: 0, taxMinor: 0, totalMinor: 0, previousBalanceMinor: input.previousBalances[contactId] ?? 0, amountDueMinor: 0, reserveFundBuildingBalanceMinor: input.reserveFundBuildingBalanceMinor };
      drafts.set(contactId, d);
    }
    return d;
  };

  // Pre-register owners in unit order so invoice order is stable (O1, O2, O3 ...)
  for (const u of input.units) {
    const owner = ownerOf.get(u.id);
    if (owner) {
      const d = draftFor(owner);
      if (!d.unitIds.includes(u.id)) d.unitIds.push(u.id);
    }
  }

  for (const line of input.lines) {
    const covered = input.units.filter((u) => covers(line, u));
    if (covered.length === 0) continue;
    const nets = perUnitNet(line, covered, input.building.shareBasis, warnings);
    if (nets.every((n) => n === 0) && line.pricing === 'shared_total') continue; // no_weight already warned
    const buildingWideNetMinor = nets.reduce((a, b) => a + b, 0);
    covered.forEach((u, i) => {
      const owner = ownerOf.get(u.id);
      if (!owner) return; // skipped unit: share computed for building-wide, not invoiced
      const ownerNetMinor = nets[i]!;
      const { taxMinor, grossMinor } = applyTaxBp(ownerNetMinor, line.taxRateBp);
      const dl: InvoiceDraftLine = {
        lineId: line.id, kind: line.kind, description: line.description, fund: line.fund, unitId: u.id, unitLabel: u.label,
        buildingWideNetMinor, ownerNetMinor, taxRateBp: line.taxRateBp, ownerTaxMinor: taxMinor, ownerGrossMinor: grossMinor,
      };
      const d = draftFor(owner);
      d.lines.push(dl);
      d.subtotalMinor += ownerNetMinor;
      d.taxMinor += taxMinor;
    });
  }

  const invoices = [...drafts.values()]
    .filter((d) => d.lines.length > 0)
    .map((d) => {
      d.totalMinor = d.subtotalMinor + d.taxMinor;
      d.amountDueMinor = d.totalMinor + d.previousBalanceMinor;
      return d;
    });

  return { invoices, warnings, skippedUnits: skipped };
}
```

`packages/domain/src/calculation/index.ts`:
```ts
export * from './types.js';
export { calculatePeriod } from './engine.js';
```

`packages/domain/src/index.ts`: add `export * from './calculation/index.js';` and `export * from './period.js';`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @domar/domain test && pnpm --filter @domar/domain typecheck`
Expected: PASS (23 existing + 14 new). If the `equal` share-basis assertion fails, re-derive: 5 covered units (A, B, C, P1, S1) each 120000; O1 receives A + P1 = 240000; S1 is skipped; O2 120000; O3 120000.

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): period helpers and monthly calculation engine"
```

---

### Task 2: Billing schema and migration (`@domar/db`)

**Files:**
- Create: `packages/db/src/schema/billing.ts`
- Modify: `packages/db/src/schema/index.ts` (export `./billing.js`)
- Create: `packages/db/migrations/0002_*.sql` via `pnpm --filter @domar/db generate`
- Modify: `packages/db/test/migrations.test.ts` (extend the expected-table list)

**Interfaces:**
- Produces tables (Drizzle exports in parentheses): `services` (`services`), `building_services` (`buildingServices`), `reserve_fund_settings` (`reserveFundSettings`), `expenses` (`expenses`), `billing_periods` (`billingPeriods`), `period_lines` (`periodLines`), `invoices` (`invoices`), `invoice_lines` (`invoiceLines`), `postings` (`postings`), `invoice_sequences` (`invoiceSequences`).
- Enums: `pricing_model` (`pricingModel`: fixed_per_unit|per_m2|shared_total), `fund` (`fund`: regular|reserve), `service_frequency` (`serviceFrequency`: monthly|every_n_months), `reserve_basis` (`reserveBasis`: per_unit|per_m2), `period_status` (`periodStatus`: open|generated|published), `line_source` (`lineSource`: auto|manual), `invoice_status` (`invoiceStatus`: draft|published|partially_paid|paid|cancelled), `line_kind` (`lineKind`: service|manual|reserve_fund|management_fee), `posting_account` (`postingAccount`: owner|fund), `posting_kind` (`postingKind`: charge|payment|expense|adjustment|opening).

- [ ] **Step 1: Extend the failing test**

In `packages/db/test/migrations.test.ts`, extend the expected table list in `creates the expected tables`:
```ts
for (const n of ['tenants', 'users', 'sessions', 'contacts', 'buildings', 'units', 'tax_rates', 'audit_logs',
  'services', 'building_services', 'reserve_fund_settings', 'expenses', 'billing_periods', 'period_lines', 'invoices', 'invoice_lines', 'postings', 'invoice_sequences'])
  expect(names).toContain(n);
```
Add a test:
```ts
it('money columns on billing tables are bigint', async () => {
  const cols = await t!.sql<{ table_name: string; column_name: string; data_type: string }[]>`
    select table_name, column_name, data_type from information_schema.columns
    where table_schema = 'public' and table_name in ('period_lines','invoices','invoice_lines','postings','expenses','reserve_fund_settings','billing_periods','services','building_services')
      and column_name like '%_minor'`;
  expect(cols.length).toBeGreaterThan(10);
  for (const c of cols) expect(c.data_type, `${c.table_name}.${c.column_name}`).toBe('bigint');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @domar/db test`
Expected: FAIL, `services` not in table list.

- [ ] **Step 3: Implement the schema**

`packages/db/src/schema/billing.ts`:
```ts
import { sql } from 'drizzle-orm';
import { bigint, boolean, char, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { buildings, units } from './building.js';
import { contacts } from './contact.js';
import { taxRates } from './tax-rate.js';
import { tenants } from './tenant.js';

export const pricingModel = pgEnum('pricing_model', ['fixed_per_unit', 'per_m2', 'shared_total']);
export const fund = pgEnum('fund', ['regular', 'reserve']);
export const serviceFrequency = pgEnum('service_frequency', ['monthly', 'every_n_months']);
export const reserveBasis = pgEnum('reserve_basis', ['per_unit', 'per_m2']);
export const periodStatus = pgEnum('period_status', ['open', 'generated', 'published']);
export const lineSource = pgEnum('line_source', ['auto', 'manual']);
export const invoiceStatus = pgEnum('invoice_status', ['draft', 'published', 'partially_paid', 'paid', 'cancelled']);
export const lineKind = pgEnum('line_kind', ['service', 'manual', 'reserve_fund', 'management_fee']);
export const postingAccount = pgEnum('posting_account', ['owner', 'fund']);
export const postingKind = pgEnum('posting_kind', ['charge', 'payment', 'expense', 'adjustment', 'opening']);

const money = (name: string) => bigint(name, { mode: 'number' });
const tenantRef = () => uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' });
const ts = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const services = pgTable('services', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  name: text('name').notNull(),
  category: text('category'),
  description: text('description'),
  pricing: pricingModel('pricing').notNull(),
  defaultPriceMinor: money('default_price_minor').notNull().default(0),
  taxRateId: uuid('tax_rate_id').references(() => taxRates.id, { onDelete: 'set null' }),
  appliesTo: text('applies_to').array().notNull().default(sql`'{}'::text[]`),
  recurring: boolean('recurring').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  ...ts(),
}, (t) => [index('services_tenant_idx').on(t.tenantId, t.name)]);

export const buildingServices = pgTable('building_services', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
  serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'restrict' }),
  priceMinor: money('price_minor'),
  pricing: pricingModel('pricing'),
  frequency: serviceFrequency('frequency').notNull().default('monthly'),
  intervalMonths: integer('interval_months').notNull().default(1),
  startsPeriod: char('starts_period', { length: 7 }).notNull(),
  endsPeriod: char('ends_period', { length: 7 }),
  isActive: boolean('is_active').notNull().default(true),
  ...ts(),
}, (t) => [index('building_services_tenant_building_idx').on(t.tenantId, t.buildingId), uniqueIndex('building_services_unique_idx').on(t.buildingId, t.serviceId)]);

export const reserveFundSettings = pgTable('reserve_fund_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
  basis: reserveBasis('basis').notNull().default('per_unit'),
  amountMinor: money('amount_minor').notNull().default(0),
  appliesTo: text('applies_to').array().notNull().default(sql`'{}'::text[]`),
  active: boolean('active').notNull().default(false),
  ...ts(),
}, (t) => [index('reserve_fund_settings_tenant_idx').on(t.tenantId), uniqueIndex('reserve_fund_settings_building_idx').on(t.buildingId)]);

export const expenses = pgTable('expenses', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
  fund: fund('fund').notNull(),
  description: text('description').notNull(),
  supplierText: text('supplier_text'),
  amountMinor: money('amount_minor').notNull(),
  paidAt: timestamp('paid_at', { withTimezone: true }).notNull(),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  voidReason: text('void_reason'),
  ...ts(),
}, (t) => [index('expenses_tenant_building_idx').on(t.tenantId, t.buildingId, t.paidAt)]);

export const billingPeriods = pgTable('billing_periods', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
  period: char('period', { length: 7 }).notNull(),
  status: periodStatus('status').notNull().default('open'),
  managementFeeMinor: money('management_fee_minor').notNull().default(0),
  managementFeeTaxRateBp: integer('management_fee_tax_rate_bp').notNull().default(0),
  managementFeeAppliesTo: text('management_fee_applies_to').array().notNull().default(sql`'{apartment,commercial}'::text[]`),
  numberPrefix: text('number_prefix').notNull().default('INV-'),
  numberSuffix: text('number_suffix').notNull().default('/{year}'),
  currency: char('currency', { length: 3 }).notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }),
  dueAt: timestamp('due_at', { withTimezone: true }),
  generatedAt: timestamp('generated_at', { withTimezone: true }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  warnings: jsonb('warnings').notNull().default(sql`'[]'::jsonb`),
  ...ts(),
}, (t) => [index('billing_periods_tenant_idx').on(t.tenantId, t.buildingId, t.period), uniqueIndex('billing_periods_building_period_idx').on(t.buildingId, t.period)]);

export const periodLines = pgTable('period_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  periodId: uuid('period_id').notNull().references(() => billingPeriods.id, { onDelete: 'cascade' }),
  serviceId: uuid('service_id').references(() => services.id, { onDelete: 'set null' }),
  description: text('description').notNull(),
  pricing: pricingModel('pricing').notNull(),
  quantity: numeric('quantity', { precision: 12, scale: 3 }).notNull().default('1'),
  unitPriceMinor: money('unit_price_minor').notNull(),
  taxRateBp: integer('tax_rate_bp').notNull().default(0),
  appliesTo: text('applies_to').array().notNull().default(sql`'{}'::text[]`),
  fund: fund('fund').notNull().default('regular'),
  source: lineSource('source').notNull().default('manual'),
  note: text('note'),
  sortOrder: integer('sort_order').notNull().default(0),
  ...ts(),
}, (t) => [index('period_lines_tenant_period_idx').on(t.tenantId, t.periodId, t.sortOrder)]);

export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  periodId: uuid('period_id').notNull().references(() => billingPeriods.id, { onDelete: 'cascade' }),
  buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'restrict' }),
  number: text('number'),
  status: invoiceStatus('status').notNull().default('draft'),
  currency: char('currency', { length: 3 }).notNull(),
  unitIds: jsonb('unit_ids').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  subtotalMinor: money('subtotal_minor').notNull(),
  taxMinor: money('tax_minor').notNull(),
  totalMinor: money('total_minor').notNull(),
  previousBalanceMinor: money('previous_balance_minor').notNull().default(0),
  amountDueMinor: money('amount_due_minor').notNull(),
  reserveFundBuildingBalanceMinor: money('reserve_fund_building_balance_minor').notNull().default(0),
  issuedAt: timestamp('issued_at', { withTimezone: true }),
  dueAt: timestamp('due_at', { withTimezone: true }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  ...ts(),
}, (t) => [
  index('invoices_tenant_period_idx').on(t.tenantId, t.periodId),
  index('invoices_tenant_contact_idx').on(t.tenantId, t.contactId),
  uniqueIndex('invoices_tenant_number_idx').on(t.tenantId, t.number),
]);

export const invoiceLines = pgTable('invoice_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id, { onDelete: 'cascade' }),
  periodLineId: uuid('period_line_id').references(() => periodLines.id, { onDelete: 'set null' }),
  kind: lineKind('kind').notNull(),
  description: text('description').notNull(),
  fund: fund('fund').notNull(),
  unitId: uuid('unit_id').references(() => units.id, { onDelete: 'set null' }),
  unitLabel: text('unit_label').notNull().default(''),
  buildingWideNetMinor: money('building_wide_net_minor').notNull(),
  ownerNetMinor: money('owner_net_minor').notNull(),
  taxRateBp: integer('tax_rate_bp').notNull().default(0),
  ownerTaxMinor: money('owner_tax_minor').notNull(),
  ownerGrossMinor: money('owner_gross_minor').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => [index('invoice_lines_tenant_invoice_idx').on(t.tenantId, t.invoiceId, t.sortOrder)]);

export const postings = pgTable('postings', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
  account: postingAccount('account').notNull(),
  fund: fund('fund').notNull(),
  contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'restrict' }),
  kind: postingKind('kind').notNull(),
  amountMinor: money('amount_minor').notNull(),
  refType: text('ref_type').notNull(),
  refId: uuid('ref_id'),
  period: char('period', { length: 7 }),
  bookedAt: timestamp('booked_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('postings_tenant_building_fund_idx').on(t.tenantId, t.buildingId, t.fund, t.account),
  index('postings_tenant_contact_idx').on(t.tenantId, t.contactId),
  index('postings_tenant_ref_idx').on(t.tenantId, t.refType, t.refId),
]);

export const invoiceSequences = pgTable('invoice_sequences', {
  tenantId: tenantRef(),
  year: integer('year').notNull(),
  next: integer('next').notNull().default(1),
}, (t) => [uniqueIndex('invoice_sequences_pk').on(t.tenantId, t.year)]);
```

`packages/db/src/schema/index.ts`: add `export * from './billing.js';`.

- [ ] **Step 4: Generate and test**

Run: `pnpm --filter @domar/db generate` → `migrations/0002_*.sql` with 10 enums, 10 tables. Then `pnpm --filter @domar/db test` → PASS (4 tests). `pnpm typecheck` clean (the `invoice_sequences` table has no `id`; that is intended — the unique index leads with `tenant_id`, satisfying the tenant rule).

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): billing schema — services, periods, invoices, postings, sequences"
```

---

### Task 3: Services CRUD

**Files:**
- Create: `apps/api/src/resources/services/schema.ts`, `apps/api/src/resources/services/repo.ts`, `apps/api/src/resources/services/routes.ts`
- Create: `apps/api/test/services.test.ts`
- Modify: `apps/api/src/app.ts` (register under `/services`)

**Interfaces:**
- Produces: `listServices(db, ctx, { includeInactive, recurring? })` → `{ rows }` each with `taxRateBp: number` resolved from `taxRateId` (0 when null); `getService(db, ctx, id)`; `createService`, `updateService`, `deactivateService` (soft: `isActive=false`).
- Routes `/api/services`: `GET /?includeInactive=true|false&recurring=true|false`, `POST /`, `GET /:id`, `PATCH /:id`, `DELETE /:id` (soft).
- `serviceOut`: `id, name, category, description, pricing, defaultPriceMinor, taxRateId, taxRateBp, appliesTo: UnitKind[], recurring, isActive, createdAt, updatedAt`.
- Validation: `taxRateId` must be an active tax rate of the tenant (`400 invalid_reference`); `appliesTo` items from the unit-kind enum, deduplicated; `defaultPriceMinor` integer ≥ 0 ≤ 1e12.
- Shared: add `unitKindEnum` and `boolQuery = z.enum(['true','false']).transform(v => v === 'true')` to `resources/common.ts` (move `unitKindEnum` from `units/schema.ts` and re-export it there).

- [ ] **Step 1: Write the failing tests**

`apps/api/test/services.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('services', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let vatId: string;
  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-a');
    const rates = await t.app.inject({ method: 'GET', url: '/api/tax-rates', headers: { cookie: a.cookie } });
    vatId = rates.json().rows.find((r: { rateBp: number }) => r.rateBp === 1800).id;
  });
  afterAll(async () => { await t.close(); });

  const post = (payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url: '/api/services', headers: { cookie: a.cookie }, payload });

  it('creates a recurring fixed-price service with VAT and resolves taxRateBp', async () => {
    const res = await post({ name: 'Чистење', category: 'Хигиена', pricing: 'fixed_per_unit', defaultPriceMinor: 30000, taxRateId: vatId, appliesTo: ['apartment', 'commercial', 'apartment'] });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 30000, taxRateBp: 1800, appliesTo: ['apartment', 'commercial'], recurring: true, isActive: true });
  });

  it('creates a one-time service without tax (taxRateBp 0) and empty appliesTo', async () => {
    const res = await post({ name: 'Замена сијалица', pricing: 'fixed_per_unit', defaultPriceMinor: 2000, recurring: false });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ recurring: false, taxRateId: null, taxRateBp: 0, appliesTo: [] });
  });

  it('rejects a foreign or inactive tax rate', async () => {
    const b = await registerTenant(t.app, 'firma-b');
    const foreign = (await t.app.inject({ method: 'GET', url: '/api/tax-rates', headers: { cookie: b.cookie } })).json().rows[0].id;
    const res = await post({ name: 'x', pricing: 'per_m2', defaultPriceMinor: 100, taxRateId: foreign });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_reference');
  });

  it('validates pricing enum and price bounds', async () => {
    expect((await post({ name: 'x', pricing: 'hourly', defaultPriceMinor: 1 })).statusCode).toBe(400);
    expect((await post({ name: 'x', pricing: 'per_m2', defaultPriceMinor: -1 })).statusCode).toBe(400);
    expect((await post({ name: 'x', pricing: 'per_m2', defaultPriceMinor: 10.5 })).statusCode).toBe(400);
  });

  it('lists with recurring filter and hides inactive by default', async () => {
    const all = await t.app.inject({ method: 'GET', url: '/api/services', headers: { cookie: a.cookie } });
    expect(all.json().rows).toHaveLength(2);
    const rec = await t.app.inject({ method: 'GET', url: '/api/services?recurring=true', headers: { cookie: a.cookie } });
    expect(rec.json().rows.map((r: { name: string }) => r.name)).toEqual(['Чистење']);
    const id = all.json().rows.find((r: { name: string }) => r.name === 'Замена сијалица').id;
    const del = await t.app.inject({ method: 'DELETE', url: `/api/services/${id}`, headers: { cookie: a.cookie } });
    expect(del.statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: '/api/services', headers: { cookie: a.cookie } })).json().rows).toHaveLength(1);
    expect((await t.app.inject({ method: 'GET', url: '/api/services?includeInactive=true', headers: { cookie: a.cookie } })).json().rows).toHaveLength(2);
  });

  it('updates price and appliesTo, and is tenant isolated', async () => {
    const list = await t.app.inject({ method: 'GET', url: '/api/services', headers: { cookie: a.cookie } });
    const id = list.json().rows[0].id;
    const upd = await t.app.inject({ method: 'PATCH', url: `/api/services/${id}`, headers: { cookie: a.cookie }, payload: { defaultPriceMinor: 35000, appliesTo: ['apartment'] } });
    expect(upd.json()).toMatchObject({ defaultPriceMinor: 35000, appliesTo: ['apartment'] });
    const b = await registerTenant(t.app, 'firma-c');
    expect((await t.app.inject({ method: 'GET', url: `/api/services/${id}`, headers: { cookie: b.cookie } })).statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @domar/api test -- services`
Expected: FAIL, 404 on `/api/services`.

- [ ] **Step 3: Implement**

`apps/api/src/resources/common.ts` — add:
```ts
export const unitKindEnum = z.enum(['apartment', 'commercial', 'parking', 'storage', 'other']);
export const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');
export const moneyMinor = z.number().int().min(0).max(1_000_000_000_000);
export const periodStr = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM');
export const dedupe = <T>(xs: T[]): T[] => [...new Set(xs)];
```
In `resources/units/schema.ts` replace the local `unitKindEnum` definition with `import { unitKindEnum } from '../common.js'; export { unitKindEnum };`.

`apps/api/src/resources/services/schema.ts`:
```ts
import { z } from 'zod';
import { boolQuery, dedupe, moneyMinor, nullableStr, unitKindEnum } from '../common.js';

export const pricingEnum = z.enum(['fixed_per_unit', 'per_m2', 'shared_total']);
export const serviceOut = z.object({
  id: z.string(), name: z.string(), category: z.string().nullable(), description: z.string().nullable(), pricing: pricingEnum,
  defaultPriceMinor: z.number().int(), taxRateId: z.string().nullable(), taxRateBp: z.number().int(), appliesTo: z.array(unitKindEnum),
  recurring: z.boolean(), isActive: z.boolean(), createdAt: z.date().or(z.string()), updatedAt: z.date().or(z.string()),
});
export const serviceCreate = z.object({
  name: z.string().min(1).max(200), category: nullableStr(100), description: nullableStr(2000), pricing: pricingEnum,
  defaultPriceMinor: moneyMinor.default(0), taxRateId: z.string().uuid().nullable().optional(),
  appliesTo: z.array(unitKindEnum).max(5).default([]).transform(dedupe), recurring: z.boolean().default(true),
});
export const servicePatch = z.object({
  name: z.string().min(1).max(200).optional(), category: nullableStr(100), description: nullableStr(2000), pricing: pricingEnum.optional(),
  defaultPriceMinor: moneyMinor.optional(), taxRateId: z.string().uuid().nullable().optional(),
  appliesTo: z.array(unitKindEnum).max(5).transform(dedupe).optional(), recurring: z.boolean().optional(),
});
export const serviceListQuery = z.object({ includeInactive: boolQuery.optional(), recurring: boolQuery.optional() });
export type ServiceCreate = z.infer<typeof serviceCreate>;
export type ServicePatch = z.infer<typeof servicePatch>;
```

`apps/api/src/resources/services/repo.ts`:
```ts
import { type Db, schema } from '@domar/db';
import { and, asc, eq } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { badRequest, notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { stripUndefined } from '../common.js';
import type { ServiceCreate, ServicePatch } from './schema.js';

const S = schema.services;
type Row = typeof S.$inferSelect;
type Out = Omit<Row, 'appliesTo'> & { appliesTo: Row['appliesTo']; taxRateBp: number };

function toOut(row: Row, rateBp: number | null): Out {
  return { ...row, taxRateBp: rateBp ?? 0 };
}

/** Returns the tax rate's bp or throws invalid_reference; null taxRateId → null. */
export async function resolveTaxRateBp(db: Db, ctx: TenantContext, taxRateId: string | null | undefined): Promise<number | null> {
  if (!taxRateId) return null;
  const r = await db.query.taxRates.findFirst({ where: and(eq(schema.taxRates.tenantId, ctx.tenantId), eq(schema.taxRates.id, taxRateId), eq(schema.taxRates.isActive, true)), columns: { rateBp: true } });
  if (!r) throw badRequest('invalid_reference', 'taxRateId is not an active tax rate of this organization');
  return r.rateBp;
}

export async function listServices(db: Db, ctx: TenantContext, q: { includeInactive?: boolean | undefined; recurring?: boolean | undefined }) {
  const conds = [eq(S.tenantId, ctx.tenantId)];
  if (!q.includeInactive) conds.push(eq(S.isActive, true));
  if (q.recurring !== undefined) conds.push(eq(S.recurring, q.recurring));
  const rows = await db.select({ s: S, rateBp: schema.taxRates.rateBp }).from(S).leftJoin(schema.taxRates, eq(schema.taxRates.id, S.taxRateId)).where(and(...conds)).orderBy(asc(S.name));
  return { rows: rows.map((r) => toOut(r.s, r.rateBp)) };
}

export async function getService(db: Db, ctx: TenantContext, id: string): Promise<Out> {
  const rows = await db.select({ s: S, rateBp: schema.taxRates.rateBp }).from(S).leftJoin(schema.taxRates, eq(schema.taxRates.id, S.taxRateId)).where(and(eq(S.tenantId, ctx.tenantId), eq(S.id, id))).limit(1);
  const r = rows[0];
  if (!r) throw notFound('Service');
  return toOut(r.s, r.rateBp);
}

export async function createService(db: Db, ctx: TenantContext, input: ServiceCreate): Promise<Out> {
  return db.transaction(async (tx) => {
    const rateBp = await resolveTaxRateBp(tx, ctx, input.taxRateId);
    const [row] = await tx.insert(S).values({ ...stripUndefined(input), name: input.name, pricing: input.pricing, tenantId: ctx.tenantId, taxRateId: input.taxRateId ?? null }).returning();
    await writeAudit(tx, ctx, { action: 'service.create', entityType: 'service', entityId: row!.id, after: row });
    return toOut(row!, rateBp);
  });
}

export async function updateService(db: Db, ctx: TenantContext, id: string, patch: ServicePatch): Promise<Out> {
  return db.transaction(async (tx) => {
    const before = await getService(tx, ctx, id);
    if (patch.taxRateId !== undefined) await resolveTaxRateBp(tx, ctx, patch.taxRateId);
    const [row] = await tx.update(S).set({ ...stripUndefined(patch), updatedAt: new Date() }).where(and(eq(S.tenantId, ctx.tenantId), eq(S.id, id))).returning();
    await writeAudit(tx, ctx, { action: 'service.update', entityType: 'service', entityId: id, before, after: row });
    return getService(tx, ctx, id);
  });
}

export async function deactivateService(db: Db, ctx: TenantContext, id: string): Promise<void> {
  return db.transaction(async (tx) => {
    const before = await getService(tx, ctx, id);
    const [row] = await tx.update(S).set({ isActive: false, updatedAt: new Date() }).where(and(eq(S.tenantId, ctx.tenantId), eq(S.id, id))).returning();
    await writeAudit(tx, ctx, { action: 'service.deactivate', entityType: 'service', entityId: id, before, after: row });
  });
}
```

`apps/api/src/resources/services/routes.ts`:
```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { idParam } from '../common.js';
import { createService, deactivateService, getService, listServices, updateService } from './repo.js';
import { serviceCreate, serviceListQuery, serviceOut, servicePatch } from './schema.js';

export const serviceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  const write = { preHandler: requireRole(...WRITE_ROLES) };
  app.get('/', { schema: { querystring: serviceListQuery, response: { 200: z.object({ rows: z.array(serviceOut) }) } } }, async (req) => listServices(req.db, req.ctx!, req.query));
  app.get('/:id', { schema: { params: idParam, response: { 200: serviceOut } } }, async (req) => getService(req.db, req.ctx!, req.params.id));
  app.post('/', { ...write, schema: { body: serviceCreate, response: { 201: serviceOut } } }, async (req, reply) => reply.status(201).send(await createService(req.db, req.ctx!, req.body)));
  app.patch('/:id', { ...write, schema: { params: idParam, body: servicePatch, response: { 200: serviceOut } } }, async (req) => updateService(req.db, req.ctx!, req.params.id, req.body));
  app.delete('/:id', { ...write, schema: { params: idParam } }, async (req, reply) => { await deactivateService(req.db, req.ctx!, req.params.id); return reply.status(204).send(); });
};
```

`app.ts`: `await api.register(serviceRoutes, { prefix: '/services' });`

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @domar/api test && pnpm typecheck && pnpm lint`
Expected: PASS (40 existing + 6 new). The `appliesTo` `text[]` column maps to `string[]` in drizzle; `serviceOut.appliesTo` validates each as a unit kind.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): services catalog with pricing model, tax rate and unit-kind scope"
```

---

### Task 4: Building services (recurring attachments)

**Files:**
- Create: `apps/api/src/resources/building-services/schema.ts`, `.../repo.ts`, `.../routes.ts`
- Create: `apps/api/test/building-services.test.ts`
- Modify: `apps/api/src/app.ts` (register under `/buildings/:buildingId/services`)

**Interfaces:**
- Produces: `listBuildingServices(db, ctx, buildingId)` → `{ rows }` each joined with `service: { id, name, pricing, defaultPriceMinor, taxRateBp, appliesTo }` and `effectivePriceMinor`, `effectivePricing`; `attachService(db, ctx, buildingId, input)`; `updateBuildingService(db, ctx, buildingId, id, patch)`; `detachService(db, ctx, buildingId, id)` (hard delete; period lines already created keep their snapshot).
- Routes: `GET /`, `POST /`, `PATCH /:id`, `DELETE /:id` under `/api/buildings/:buildingId/services`.
- Validation: service must be an active recurring service of the tenant (`400 invalid_reference`); duplicate attachment → `409 already_attached`; `intervalMonths ≥ 2` when `frequency = every_n_months`, forced to 1 when `monthly`; `startsPeriod`/`endsPeriod` are `YYYY-MM` with `endsPeriod ≥ startsPeriod` (`400 validation`).
- `buildingServiceOut`: `id, buildingId, serviceId, priceMinor, pricing, frequency, intervalMonths, startsPeriod, endsPeriod, isActive, effectivePriceMinor, effectivePricing, service: {...}, createdAt, updatedAt`.

- [ ] **Step 1: Write the failing tests**

`apps/api/test/building-services.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('building services', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let buildingId: string; let cleaningId: string; let bulbId: string;
  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-a');
    buildingId = (await t.app.inject({ method: 'POST', url: '/api/buildings', headers: { cookie: a.cookie }, payload: { name: 'Зграда 1' } })).json().id;
    cleaningId = (await t.app.inject({ method: 'POST', url: '/api/services', headers: { cookie: a.cookie }, payload: { name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 30000 } })).json().id;
    bulbId = (await t.app.inject({ method: 'POST', url: '/api/services', headers: { cookie: a.cookie }, payload: { name: 'Сијалица', pricing: 'fixed_per_unit', defaultPriceMinor: 2000, recurring: false } })).json().id;
  });
  afterAll(async () => { await t.close(); });
  const url = () => `/api/buildings/${buildingId}/services`;
  const post = (payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url: url(), headers: { cookie: a.cookie }, payload });

  it('attaches a recurring service with defaults from the catalog', async () => {
    const res = await post({ serviceId: cleaningId, startsPeriod: '2026-01' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ serviceId: cleaningId, frequency: 'monthly', intervalMonths: 1, priceMinor: null, effectivePriceMinor: 30000, effectivePricing: 'fixed_per_unit', service: { name: 'Чистење', taxRateBp: 0 } });
  });

  it('rejects one-time services, duplicates and bad intervals', async () => {
    expect((await post({ serviceId: bulbId, startsPeriod: '2026-01' })).json().error.code).toBe('invalid_reference');
    expect((await post({ serviceId: cleaningId, startsPeriod: '2026-01' })).statusCode).toBe(409);
    const bad = await post({ serviceId: bulbId, startsPeriod: '2026-01', frequency: 'every_n_months', intervalMonths: 1 });
    expect(bad.statusCode).toBe(400);
    expect((await post({ serviceId: cleaningId, startsPeriod: '2026-05', endsPeriod: '2026-04' })).statusCode).toBe(400);
  });

  it('overrides price and pricing per building and reports effective values', async () => {
    const list = await t.app.inject({ method: 'GET', url: url(), headers: { cookie: a.cookie } });
    const id = list.json().rows[0].id;
    const upd = await t.app.inject({ method: 'PATCH', url: `${url()}/${id}`, headers: { cookie: a.cookie }, payload: { priceMinor: 500000, pricing: 'shared_total', frequency: 'every_n_months', intervalMonths: 3 } });
    expect(upd.statusCode).toBe(200);
    expect(upd.json()).toMatchObject({ priceMinor: 500000, pricing: 'shared_total', effectivePriceMinor: 500000, effectivePricing: 'shared_total', intervalMonths: 3 });
    const back = await t.app.inject({ method: 'PATCH', url: `${url()}/${id}`, headers: { cookie: a.cookie }, payload: { priceMinor: null, pricing: null, frequency: 'monthly' } });
    expect(back.json()).toMatchObject({ priceMinor: null, effectivePriceMinor: 30000, effectivePricing: 'fixed_per_unit', frequency: 'monthly', intervalMonths: 1 });
  });

  it('is tenant isolated and detaches', async () => {
    const b = await registerTenant(t.app, 'firma-b');
    expect((await t.app.inject({ method: 'GET', url: url(), headers: { cookie: b.cookie } })).statusCode).toBe(404);
    const list = await t.app.inject({ method: 'GET', url: url(), headers: { cookie: a.cookie } });
    const del = await t.app.inject({ method: 'DELETE', url: `${url()}/${list.json().rows[0].id}`, headers: { cookie: a.cookie } });
    expect(del.statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: url(), headers: { cookie: a.cookie } })).json().rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @domar/api test -- building-services`
Expected: FAIL, 404.

- [ ] **Step 3: Implement**

`apps/api/src/resources/building-services/schema.ts`:
```ts
import { z } from 'zod';
import { comparePeriods } from '@domar/domain';
import { moneyMinor, periodStr, unitKindEnum } from '../common.js';
import { pricingEnum } from '../services/schema.js';

export const frequencyEnum = z.enum(['monthly', 'every_n_months']);
const base = z.object({
  priceMinor: moneyMinor.nullable().optional(),
  pricing: pricingEnum.nullable().optional(),
  frequency: frequencyEnum.default('monthly'),
  intervalMonths: z.number().int().min(1).max(24).default(1),
  startsPeriod: periodStr,
  endsPeriod: periodStr.nullable().optional(),
});
const rules = (v: { frequency: string; intervalMonths: number; startsPeriod?: string | undefined; endsPeriod?: string | null | undefined }, ctx: z.RefinementCtx) => {
  if (v.frequency === 'every_n_months' && v.intervalMonths < 2) ctx.addIssue({ code: 'custom', path: ['intervalMonths'], message: 'intervalMonths must be ≥ 2 for every_n_months' });
  if (v.startsPeriod && v.endsPeriod && comparePeriods(v.endsPeriod, v.startsPeriod) < 0) ctx.addIssue({ code: 'custom', path: ['endsPeriod'], message: 'endsPeriod must not precede startsPeriod' });
};
export const buildingServiceCreate = base.extend({ serviceId: z.string().uuid() }).superRefine(rules);
export const buildingServicePatch = base.partial().extend({ isActive: z.boolean().optional() }).superRefine((v, ctx) => rules({ frequency: v.frequency ?? 'monthly', intervalMonths: v.intervalMonths ?? (v.frequency === 'every_n_months' ? 0 : 1), startsPeriod: v.startsPeriod, endsPeriod: v.endsPeriod }, ctx));
export const buildingServiceOut = z.object({
  id: z.string(), buildingId: z.string(), serviceId: z.string(), priceMinor: z.number().int().nullable(), pricing: pricingEnum.nullable(),
  frequency: frequencyEnum, intervalMonths: z.number().int(), startsPeriod: z.string(), endsPeriod: z.string().nullable(), isActive: z.boolean(),
  effectivePriceMinor: z.number().int(), effectivePricing: pricingEnum,
  service: z.object({ id: z.string(), name: z.string(), pricing: pricingEnum, defaultPriceMinor: z.number().int(), taxRateBp: z.number().int(), appliesTo: z.array(unitKindEnum), isActive: z.boolean() }),
  createdAt: z.date().or(z.string()), updatedAt: z.date().or(z.string()),
});
export type BuildingServiceCreate = z.infer<typeof buildingServiceCreate>;
export type BuildingServicePatch = z.infer<typeof buildingServicePatch>;
```

`apps/api/src/resources/building-services/repo.ts`:
```ts
import { type Db, schema } from '@domar/db';
import { and, asc, eq } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { badRequest, conflict, isUniqueViolation, notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import { stripUndefined } from '../common.js';
import type { BuildingServiceCreate, BuildingServicePatch } from './schema.js';

const BS = schema.buildingServices;
const S = schema.services;

const selectShape = { bs: BS, service: S, rateBp: schema.taxRates.rateBp };
type Joined = { bs: typeof BS.$inferSelect; service: typeof S.$inferSelect; rateBp: number | null };

function toOut(r: Joined) {
  const service = { id: r.service.id, name: r.service.name, pricing: r.service.pricing, defaultPriceMinor: r.service.defaultPriceMinor, taxRateBp: r.rateBp ?? 0, appliesTo: r.service.appliesTo, isActive: r.service.isActive };
  return { ...r.bs, effectivePriceMinor: r.bs.priceMinor ?? service.defaultPriceMinor, effectivePricing: r.bs.pricing ?? service.pricing, service };
}

function joinedQuery(db: Db) {
  return db.select(selectShape).from(BS).innerJoin(S, eq(S.id, BS.serviceId)).leftJoin(schema.taxRates, eq(schema.taxRates.id, S.taxRateId));
}

export async function listBuildingServices(db: Db, ctx: TenantContext, buildingId: string) {
  await getBuilding(db, ctx, buildingId);
  const rows = await joinedQuery(db).where(and(eq(BS.tenantId, ctx.tenantId), eq(BS.buildingId, buildingId))).orderBy(asc(S.name));
  return { rows: rows.map(toOut) };
}

export async function getBuildingService(db: Db, ctx: TenantContext, buildingId: string, id: string) {
  const rows = await joinedQuery(db).where(and(eq(BS.tenantId, ctx.tenantId), eq(BS.buildingId, buildingId), eq(BS.id, id))).limit(1);
  if (!rows[0]) throw notFound('Building service');
  return toOut(rows[0]);
}

async function assertRecurringService(db: Db, ctx: TenantContext, serviceId: string) {
  const s = await db.query.services.findFirst({ where: and(eq(S.tenantId, ctx.tenantId), eq(S.id, serviceId), eq(S.isActive, true), eq(S.recurring, true)), columns: { id: true } });
  if (!s) throw badRequest('invalid_reference', 'serviceId must be an active recurring service of this organization');
}

export async function attachService(db: Db, ctx: TenantContext, buildingId: string, input: BuildingServiceCreate) {
  return db.transaction(async (tx) => {
    await getBuilding(tx, ctx, buildingId);
    await assertRecurringService(tx, ctx, input.serviceId);
    const intervalMonths = input.frequency === 'monthly' ? 1 : input.intervalMonths;
    let row;
    try {
      [row] = await tx.insert(BS).values({ ...stripUndefined(input), serviceId: input.serviceId, startsPeriod: input.startsPeriod, frequency: input.frequency, intervalMonths, tenantId: ctx.tenantId, buildingId, priceMinor: input.priceMinor ?? null, pricing: input.pricing ?? null, endsPeriod: input.endsPeriod ?? null }).returning();
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('already_attached', 'This service is already attached to the building');
      throw e;
    }
    await writeAudit(tx, ctx, { action: 'building_service.attach', entityType: 'building_service', entityId: row!.id, after: row });
    return getBuildingService(tx, ctx, buildingId, row!.id);
  });
}

export async function updateBuildingService(db: Db, ctx: TenantContext, buildingId: string, id: string, patch: BuildingServicePatch) {
  return db.transaction(async (tx) => {
    const before = await getBuildingService(tx, ctx, buildingId, id);
    const frequency = patch.frequency ?? before.frequency;
    const intervalMonths = frequency === 'monthly' ? 1 : (patch.intervalMonths ?? before.intervalMonths);
    if (frequency === 'every_n_months' && intervalMonths < 2) throw badRequest('validation', 'intervalMonths must be ≥ 2 for every_n_months');
    const [row] = await tx.update(BS).set({ ...stripUndefined(patch), frequency, intervalMonths, updatedAt: new Date() }).where(and(eq(BS.tenantId, ctx.tenantId), eq(BS.id, id))).returning();
    await writeAudit(tx, ctx, { action: 'building_service.update', entityType: 'building_service', entityId: id, before, after: row });
    return getBuildingService(tx, ctx, buildingId, id);
  });
}

export async function detachService(db: Db, ctx: TenantContext, buildingId: string, id: string) {
  return db.transaction(async (tx) => {
    const before = await getBuildingService(tx, ctx, buildingId, id);
    await tx.delete(BS).where(and(eq(BS.tenantId, ctx.tenantId), eq(BS.id, id)));
    await writeAudit(tx, ctx, { action: 'building_service.detach', entityType: 'building_service', entityId: id, before });
  });
}
```

`apps/api/src/resources/building-services/routes.ts`:
```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { buildingParam, buildingUnitParam } from '../units/schema.js';
import { attachService, detachService, listBuildingServices, updateBuildingService } from './repo.js';
import { buildingServiceCreate, buildingServiceOut, buildingServicePatch } from './schema.js';

export const buildingServiceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  const write = { preHandler: requireRole(...WRITE_ROLES) };
  app.get('/', { schema: { params: buildingParam, response: { 200: z.object({ rows: z.array(buildingServiceOut) }) } } }, async (req) => listBuildingServices(req.db, req.ctx!, req.params.buildingId));
  app.post('/', { ...write, schema: { params: buildingParam, body: buildingServiceCreate, response: { 201: buildingServiceOut } } }, async (req, reply) => reply.status(201).send(await attachService(req.db, req.ctx!, req.params.buildingId, req.body)));
  app.patch('/:id', { ...write, schema: { params: buildingUnitParam, body: buildingServicePatch, response: { 200: buildingServiceOut } } }, async (req) => updateBuildingService(req.db, req.ctx!, req.params.buildingId, req.params.id, req.body));
  app.delete('/:id', { ...write, schema: { params: buildingUnitParam } }, async (req, reply) => { await detachService(req.db, req.ctx!, req.params.buildingId, req.params.id); return reply.status(204).send(); });
};
```

`app.ts`: `await api.register(buildingServiceRoutes, { prefix: '/buildings/:buildingId/services' });`

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @domar/api test && pnpm typecheck && pnpm lint`
Expected: PASS (+4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): recurring building services with overrides and frequency rules"
```

---

### Task 5: Reserve fund setting, expenses and fund balances

**Files:**
- Create: `apps/api/src/ledger.ts` (posting helpers shared by later tasks)
- Create: `apps/api/src/resources/reserve-fund/schema.ts`, `.../repo.ts`, `.../routes.ts`
- Create: `apps/api/test/reserve-fund.test.ts`
- Modify: `apps/api/src/app.ts` (register under `/buildings/:buildingId/reserve-fund`)

**Interfaces:**
- Produces in `ledger.ts`: `addPosting(tx, ctx, p: { buildingId, account: 'owner'|'fund', fund, contactId?, kind, amountMinor, refType, refId?, period?, bookedAt? })`, `ownerBalance(db, ctx, buildingId, contactId): Promise<number>` (Σ owner rows), `fundBalance(db, ctx, buildingId, fund): Promise<number>` (Σ fund rows), `deletePostingsByRef(tx, ctx, refType, refIds: string[])`.
- Reserve fund routes under `/api/buildings/:buildingId/reserve-fund`: `GET /` → `{ setting: {...} | null, balanceMinor, contributionsBilledMinor }` (contributions billed = Σ owner `charge` postings with `fund='reserve'`); `PUT /` upsert `{ basis, amountMinor, appliesTo, active }`; `POST /opening-balance` `{ amountMinor, note }` → adds an `opening` fund posting (positive or negative adjustment to reach the stated balance is NOT computed; it adds the given amount); `GET /transactions` → fund postings newest first with `{ id, kind, amountMinor, refType, refId, bookedAt, description }` (description from expense when `refType='expense'`); `GET /expenses`, `POST /expenses` `{ fund, description, supplierText?, amountMinor, paidAt }` → inserts expense + fund posting `expense` of `-amountMinor`; `POST /expenses/:id/void` `{ reason }` → marks voided and adds an offsetting `adjustment` posting `+amountMinor` (nothing deleted).
- Validation: `amountMinor` integer > 0 for expenses; `paidAt` ISO datetime; `fund` enum.

- [ ] **Step 1: Write the failing tests**

`apps/api/test/reserve-fund.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('reserve fund', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let buildingId: string;
  const url = (s = '') => `/api/buildings/${buildingId}/reserve-fund${s}`;
  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-a');
    buildingId = (await t.app.inject({ method: 'POST', url: '/api/buildings', headers: { cookie: a.cookie }, payload: { name: 'Зграда 1' } })).json().id;
  });
  afterAll(async () => { await t.close(); });

  it('starts with no setting and zero balance', async () => {
    const res = await t.app.inject({ method: 'GET', url: url(), headers: { cookie: a.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ setting: null, balanceMinor: 0, contributionsBilledMinor: 0 });
  });

  it('upserts the setting', async () => {
    const put = await t.app.inject({ method: 'PUT', url: url(), headers: { cookie: a.cookie }, payload: { basis: 'per_m2', amountMinor: 1000, appliesTo: ['apartment', 'commercial'], active: true } });
    expect(put.statusCode).toBe(200);
    expect(put.json().setting).toMatchObject({ basis: 'per_m2', amountMinor: 1000, appliesTo: ['apartment', 'commercial'], active: true });
    const again = await t.app.inject({ method: 'PUT', url: url(), headers: { cookie: a.cookie }, payload: { basis: 'per_unit', amountMinor: 50000, appliesTo: [], active: true } });
    expect(again.json().setting).toMatchObject({ basis: 'per_unit', amountMinor: 50000 });
  });

  it('records an opening balance, expenses and voids, and computes the balance', async () => {
    const open = await t.app.inject({ method: 'POST', url: url('/opening-balance'), headers: { cookie: a.cookie }, payload: { amountMinor: 3500000, note: 'Пренос од претходен управител' } });
    expect(open.statusCode).toBe(201);
    const exp = await t.app.inject({ method: 'POST', url: url('/expenses'), headers: { cookie: a.cookie }, payload: { fund: 'reserve', description: 'Поправка кров', supplierText: 'Кровопокривач ДООЕЛ', amountMinor: 1200000, paidAt: '2026-09-10T10:00:00.000Z' } });
    expect(exp.statusCode).toBe(201);
    const exp2 = await t.app.inject({ method: 'POST', url: url('/expenses'), headers: { cookie: a.cookie }, payload: { fund: 'reserve', description: 'Грешка', amountMinor: 100, paidAt: '2026-09-11T10:00:00.000Z' } });
    let state = (await t.app.inject({ method: 'GET', url: url(), headers: { cookie: a.cookie } })).json();
    expect(state.balanceMinor).toBe(3500000 - 1200000 - 100);
    const voided = await t.app.inject({ method: 'POST', url: url(`/expenses/${exp2.json().id}/void`), headers: { cookie: a.cookie }, payload: { reason: 'дупликат' } });
    expect(voided.statusCode).toBe(200);
    expect(voided.json()).toMatchObject({ voidReason: 'дупликат' });
    state = (await t.app.inject({ method: 'GET', url: url(), headers: { cookie: a.cookie } })).json();
    expect(state.balanceMinor).toBe(2300000);
    const tx = await t.app.inject({ method: 'GET', url: url('/transactions'), headers: { cookie: a.cookie } });
    expect(tx.json().rows.map((r: { kind: string; amountMinor: number }) => [r.kind, r.amountMinor])).toEqual([['adjustment', 100], ['expense', -100], ['expense', -1200000], ['opening', 3500000]]);
    const expenses = await t.app.inject({ method: 'GET', url: url('/expenses'), headers: { cookie: a.cookie } });
    expect(expenses.json().rows).toHaveLength(2);
    expect(expenses.json().rows.find((e: { id: string }) => e.id === exp2.json().id).voidedAt).not.toBeNull();
  });

  it('rejects voiding twice, non-positive amounts, and foreign tenants', async () => {
    const expenses = (await t.app.inject({ method: 'GET', url: url('/expenses'), headers: { cookie: a.cookie } })).json().rows;
    const voided = expenses.find((e: { voidedAt: string | null }) => e.voidedAt);
    expect((await t.app.inject({ method: 'POST', url: url(`/expenses/${voided.id}/void`), headers: { cookie: a.cookie }, payload: { reason: 'x' } })).statusCode).toBe(409);
    expect((await t.app.inject({ method: 'POST', url: url('/expenses'), headers: { cookie: a.cookie }, payload: { fund: 'regular', description: 'x', amountMinor: 0, paidAt: '2026-09-11T10:00:00.000Z' } })).statusCode).toBe(400);
    const b = await registerTenant(t.app, 'firma-b');
    expect((await t.app.inject({ method: 'GET', url: url(), headers: { cookie: b.cookie } })).statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @domar/api test -- reserve-fund`
Expected: FAIL, 404.

- [ ] **Step 3: Implement**

`apps/api/src/ledger.ts`:
```ts
import { type Db, schema } from '@domar/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { TenantContext } from './tenant-context.js';

const P = schema.postings;
export type Fund = 'regular' | 'reserve';
export type PostingKind = 'charge' | 'payment' | 'expense' | 'adjustment' | 'opening';

export interface NewPosting {
  buildingId: string;
  account: 'owner' | 'fund';
  fund: Fund;
  contactId?: string | null | undefined;
  kind: PostingKind;
  amountMinor: number;
  refType: string;
  refId?: string | null | undefined;
  period?: string | null | undefined;
  bookedAt?: Date | undefined;
}

export async function addPosting(db: Db, ctx: TenantContext, p: NewPosting) {
  const [row] = await db.insert(P).values({
    tenantId: ctx.tenantId, buildingId: p.buildingId, account: p.account, fund: p.fund, contactId: p.contactId ?? null, kind: p.kind,
    amountMinor: p.amountMinor, refType: p.refType, refId: p.refId ?? null, period: p.period ?? null, bookedAt: p.bookedAt ?? new Date(),
  }).returning();
  return row!;
}

export async function addPostings(db: Db, ctx: TenantContext, ps: NewPosting[]) {
  if (ps.length === 0) return;
  await db.insert(P).values(ps.map((p) => ({
    tenantId: ctx.tenantId, buildingId: p.buildingId, account: p.account, fund: p.fund, contactId: p.contactId ?? null, kind: p.kind,
    amountMinor: p.amountMinor, refType: p.refType, refId: p.refId ?? null, period: p.period ?? null, bookedAt: p.bookedAt ?? new Date(),
  })));
}

const sum = sql<string>`coalesce(sum(${P.amountMinor}), 0)`;

/** Outstanding balance of an owner in a building (positive = owes). */
export async function ownerBalance(db: Db, ctx: TenantContext, buildingId: string, contactId: string): Promise<number> {
  const [r] = await db.select({ total: sum }).from(P).where(and(eq(P.tenantId, ctx.tenantId), eq(P.buildingId, buildingId), eq(P.account, 'owner'), eq(P.contactId, contactId)));
  return Number(r?.total ?? 0);
}

/** Outstanding balances of all owners in a building, keyed by contactId. */
export async function ownerBalances(db: Db, ctx: TenantContext, buildingId: string): Promise<Record<string, number>> {
  const rows = await db.select({ contactId: P.contactId, total: sum }).from(P).where(and(eq(P.tenantId, ctx.tenantId), eq(P.buildingId, buildingId), eq(P.account, 'owner'))).groupBy(P.contactId);
  return Object.fromEntries(rows.filter((r) => r.contactId).map((r) => [r.contactId!, Number(r.total)]));
}

/** Cash balance of a building fund. */
export async function fundBalance(db: Db, ctx: TenantContext, buildingId: string, fund: Fund): Promise<number> {
  const [r] = await db.select({ total: sum }).from(P).where(and(eq(P.tenantId, ctx.tenantId), eq(P.buildingId, buildingId), eq(P.account, 'fund'), eq(P.fund, fund)));
  return Number(r?.total ?? 0);
}

/** Σ owner charges for a fund (what has been billed to owners). */
export async function billedToOwners(db: Db, ctx: TenantContext, buildingId: string, fund: Fund): Promise<number> {
  const [r] = await db.select({ total: sum }).from(P).where(and(eq(P.tenantId, ctx.tenantId), eq(P.buildingId, buildingId), eq(P.account, 'owner'), eq(P.fund, fund), eq(P.kind, 'charge')));
  return Number(r?.total ?? 0);
}

export async function deletePostingsByRef(db: Db, ctx: TenantContext, refType: string, refIds: string[]) {
  if (refIds.length === 0) return;
  await db.delete(P).where(and(eq(P.tenantId, ctx.tenantId), eq(P.refType, refType), inArray(P.refId, refIds)));
}
```

`apps/api/src/resources/reserve-fund/schema.ts`:
```ts
import { z } from 'zod';
import { moneyMinor, nullableStr, unitKindEnum, dedupe } from '../common.js';

export const fundEnum = z.enum(['regular', 'reserve']);
export const settingOut = z.object({ id: z.string(), buildingId: z.string(), basis: z.enum(['per_unit', 'per_m2']), amountMinor: z.number().int(), appliesTo: z.array(unitKindEnum), active: z.boolean(), updatedAt: z.date().or(z.string()) });
export const stateOut = z.object({ setting: settingOut.nullable(), balanceMinor: z.number().int(), contributionsBilledMinor: z.number().int() });
export const settingPut = z.object({ basis: z.enum(['per_unit', 'per_m2']), amountMinor: moneyMinor, appliesTo: z.array(unitKindEnum).max(5).default([]).transform(dedupe), active: z.boolean() });
export const openingBalanceBody = z.object({ amountMinor: z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000), note: nullableStr(500) });
export const expenseOut = z.object({ id: z.string(), buildingId: z.string(), fund: fundEnum, description: z.string(), supplierText: z.string().nullable(), amountMinor: z.number().int(), paidAt: z.date().or(z.string()), voidedAt: z.date().or(z.string()).nullable(), voidReason: z.string().nullable(), createdAt: z.date().or(z.string()) });
export const expenseCreate = z.object({ fund: fundEnum, description: z.string().min(1).max(500), supplierText: nullableStr(200), amountMinor: z.number().int().min(1).max(1_000_000_000_000), paidAt: z.string().datetime() });
export const voidBody = z.object({ reason: z.string().min(1).max(500) });
export const transactionOut = z.object({ id: z.string(), kind: z.enum(['charge', 'payment', 'expense', 'adjustment', 'opening']), fund: fundEnum, amountMinor: z.number().int(), refType: z.string(), refId: z.string().nullable(), bookedAt: z.date().or(z.string()), description: z.string().nullable() });
```

`apps/api/src/resources/reserve-fund/repo.ts`:
```ts
import { type Db, schema } from '@domar/db';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { writeAudit } from '../../audit.js';
import { conflict, notFound } from '../../errors.js';
import { addPosting, billedToOwners, fundBalance } from '../../ledger.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import type { expenseCreate, openingBalanceBody, settingPut } from './schema.js';

const RF = schema.reserveFundSettings;
const E = schema.expenses;
const P = schema.postings;

export async function getReserveFundState(db: Db, ctx: TenantContext, buildingId: string) {
  await getBuilding(db, ctx, buildingId);
  const setting = (await db.query.reserveFundSettings.findFirst({ where: and(eq(RF.tenantId, ctx.tenantId), eq(RF.buildingId, buildingId)) })) ?? null;
  const [balanceMinor, contributionsBilledMinor] = await Promise.all([fundBalance(db, ctx, buildingId, 'reserve'), billedToOwners(db, ctx, buildingId, 'reserve')]);
  return { setting, balanceMinor, contributionsBilledMinor };
}

export async function getReserveFundSetting(db: Db, ctx: TenantContext, buildingId: string) {
  return (await db.query.reserveFundSettings.findFirst({ where: and(eq(RF.tenantId, ctx.tenantId), eq(RF.buildingId, buildingId)) })) ?? null;
}

export async function putReserveFundSetting(db: Db, ctx: TenantContext, buildingId: string, input: z.infer<typeof settingPut>) {
  return db.transaction(async (tx) => {
    await getBuilding(tx, ctx, buildingId);
    const before = await getReserveFundSetting(tx, ctx, buildingId);
    const [row] = await tx.insert(RF).values({ tenantId: ctx.tenantId, buildingId, ...input })
      .onConflictDoUpdate({ target: RF.buildingId, set: { ...input, updatedAt: new Date() } }).returning();
    await writeAudit(tx, ctx, { action: 'reserve_fund.upsert', entityType: 'reserve_fund_setting', entityId: row!.id, before, after: row });
    return getReserveFundState(tx, ctx, buildingId);
  });
}

export async function addOpeningBalance(db: Db, ctx: TenantContext, buildingId: string, input: z.infer<typeof openingBalanceBody>) {
  return db.transaction(async (tx) => {
    await getBuilding(tx, ctx, buildingId);
    const posting = await addPosting(tx, ctx, { buildingId, account: 'fund', fund: 'reserve', kind: 'opening', amountMinor: input.amountMinor, refType: 'opening_balance' });
    await writeAudit(tx, ctx, { action: 'reserve_fund.opening_balance', entityType: 'posting', entityId: posting.id, after: { ...posting, note: input.note ?? null } });
    return posting;
  });
}

export async function listTransactions(db: Db, ctx: TenantContext, buildingId: string) {
  await getBuilding(db, ctx, buildingId);
  const rows = await db.select({ p: P, description: E.description }).from(P).leftJoin(E, and(eq(E.id, P.refId), eq(P.refType, 'expense')))
    .where(and(eq(P.tenantId, ctx.tenantId), eq(P.buildingId, buildingId), eq(P.account, 'fund'), eq(P.fund, 'reserve'))).orderBy(desc(P.bookedAt), desc(P.createdAt));
  return { rows: rows.map((r) => ({ id: r.p.id, kind: r.p.kind, fund: r.p.fund, amountMinor: r.p.amountMinor, refType: r.p.refType, refId: r.p.refId, bookedAt: r.p.bookedAt, description: r.description ?? null })) };
}

export async function listExpenses(db: Db, ctx: TenantContext, buildingId: string) {
  await getBuilding(db, ctx, buildingId);
  const rows = await db.query.expenses.findMany({ where: and(eq(E.tenantId, ctx.tenantId), eq(E.buildingId, buildingId)), orderBy: (e, { desc: d }) => [d(e.paidAt)] });
  return { rows };
}

export async function createExpense(db: Db, ctx: TenantContext, buildingId: string, input: z.infer<typeof expenseCreate>) {
  return db.transaction(async (tx) => {
    await getBuilding(tx, ctx, buildingId);
    const paidAt = new Date(input.paidAt);
    const [row] = await tx.insert(E).values({ tenantId: ctx.tenantId, buildingId, fund: input.fund, description: input.description, supplierText: input.supplierText ?? null, amountMinor: input.amountMinor, paidAt }).returning();
    await addPosting(tx, ctx, { buildingId, account: 'fund', fund: input.fund, kind: 'expense', amountMinor: -input.amountMinor, refType: 'expense', refId: row!.id, bookedAt: paidAt });
    await writeAudit(tx, ctx, { action: 'expense.create', entityType: 'expense', entityId: row!.id, after: row });
    return row!;
  });
}

export async function voidExpense(db: Db, ctx: TenantContext, buildingId: string, id: string, reason: string) {
  return db.transaction(async (tx) => {
    const before = await tx.query.expenses.findFirst({ where: and(eq(E.tenantId, ctx.tenantId), eq(E.buildingId, buildingId), eq(E.id, id)) });
    if (!before) throw notFound('Expense');
    if (before.voidedAt) throw conflict('already_voided', 'Expense is already voided');
    const [row] = await tx.update(E).set({ voidedAt: new Date(), voidReason: reason, updatedAt: new Date() }).where(eq(E.id, id)).returning();
    await addPosting(tx, ctx, { buildingId, account: 'fund', fund: before.fund, kind: 'adjustment', amountMinor: before.amountMinor, refType: 'expense_void', refId: id });
    await writeAudit(tx, ctx, { action: 'expense.void', entityType: 'expense', entityId: id, before, after: row });
    return row!;
  });
}
```

`apps/api/src/resources/reserve-fund/routes.ts`:
```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { buildingParam, buildingUnitParam } from '../units/schema.js';
import { addOpeningBalance, createExpense, getReserveFundState, listExpenses, listTransactions, putReserveFundSetting, voidExpense } from './repo.js';
import { expenseCreate, expenseOut, openingBalanceBody, settingPut, stateOut, transactionOut, voidBody } from './schema.js';

export const reserveFundRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  const write = { preHandler: requireRole(...WRITE_ROLES) };
  app.get('/', { schema: { params: buildingParam, response: { 200: stateOut } } }, async (req) => getReserveFundState(req.db, req.ctx!, req.params.buildingId));
  app.put('/', { ...write, schema: { params: buildingParam, body: settingPut, response: { 200: stateOut } } }, async (req) => putReserveFundSetting(req.db, req.ctx!, req.params.buildingId, req.body));
  app.post('/opening-balance', { ...write, schema: { params: buildingParam, body: openingBalanceBody } }, async (req, reply) => reply.status(201).send(await addOpeningBalance(req.db, req.ctx!, req.params.buildingId, req.body)));
  app.get('/transactions', { schema: { params: buildingParam, response: { 200: z.object({ rows: z.array(transactionOut) }) } } }, async (req) => listTransactions(req.db, req.ctx!, req.params.buildingId));
  app.get('/expenses', { schema: { params: buildingParam, response: { 200: z.object({ rows: z.array(expenseOut) }) } } }, async (req) => listExpenses(req.db, req.ctx!, req.params.buildingId));
  app.post('/expenses', { ...write, schema: { params: buildingParam, body: expenseCreate, response: { 201: expenseOut } } }, async (req, reply) => reply.status(201).send(await createExpense(req.db, req.ctx!, req.params.buildingId, req.body)));
  app.post('/expenses/:id/void', { ...write, schema: { params: buildingUnitParam, body: voidBody, response: { 200: expenseOut } } }, async (req) => voidExpense(req.db, req.ctx!, req.params.buildingId, req.params.id, req.body.reason));
};
```

`app.ts`: `await api.register(reserveFundRoutes, { prefix: '/buildings/:buildingId/reserve-fund' });`

Note: `expenses` records both funds (`regular`/`reserve`); the reserve-fund state and transactions show only `reserve`. Regular-fund expenses are visible under `/expenses` and will get their own view in sub-plan 3.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @domar/api test && pnpm typecheck && pnpm lint`
Expected: PASS (+4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): reserve fund setting, expenses, opening balance and fund ledger"
```

---

### Task 6: Billing periods and period lines

**Files:**
- Create: `apps/api/src/resources/periods/schema.ts`, `apps/api/src/resources/periods/repo.ts`, `apps/api/src/resources/periods/auto-lines.ts`, `apps/api/src/resources/periods/routes.ts`
- Create: `apps/api/test/periods.test.ts`
- Modify: `apps/api/src/app.ts` (register under `/buildings/:buildingId/periods`)

**Interfaces:**
- Produces:
  - `buildAutoLines(db, ctx, buildingId, period): Promise<NewPeriodLine[]>` — from active building services due in `period` (`isServiceDue`), each `{ serviceId, description: service.name, pricing: effectivePricing, quantity: 1, unitPriceMinor: effectivePriceMinor, taxRateBp: service.taxRateBp, appliesTo: service.appliesTo, fund: 'regular', source: 'auto', sortOrder: i*10 }`.
  - `createPeriod(db, ctx, buildingId, input)`, `getPeriod(db, ctx, buildingId, id)` → `{ ...period, lines, invoiceCount, totalMinor }`, `listPeriods(db, ctx, buildingId)`, `updatePeriod(db, ctx, buildingId, id, patch)`, `refreshAutoLines(db, ctx, buildingId, id)`, `addLine`, `updateLine`, `deleteLine`, and `assertPeriodEditable(period)` (throws `409 period_locked` when `status === 'published'`).
  - `periodOut` fields: `id, buildingId, period, status, managementFeeMinor, managementFeeTaxRateBp, managementFeeAppliesTo, numberPrefix, numberSuffix, currency, issuedAt, dueAt, generatedAt, publishedAt, warnings, invoiceCount, totalMinor, createdAt, updatedAt`; `lineOut`: `id, serviceId, description, pricing, quantity: number, unitPriceMinor, taxRateBp, appliesTo, fund, source, note, sortOrder`.
  - Routes under `/api/buildings/:buildingId/periods`: `GET /`, `POST /` (`{ period, managementFeeMinor?, managementFeeTaxRateId?, managementFeeAppliesTo? }` → 201 detail; `409 period_exists`), `GET /:id` (detail with lines), `PATCH /:id` (`managementFeeMinor, managementFeeTaxRateId, managementFeeAppliesTo, numberPrefix, numberSuffix`), `POST /:id/refresh-lines` → detail, `POST /:id/lines` (`{ serviceId?, description?, pricing?, quantity?, unitPriceMinor?, taxRateId?, appliesTo?, fund?, note? }`; with `serviceId` the omitted fields default from the service; without it `description`, `pricing`, `unitPriceMinor` are required → else `400 validation`) → 201 line, `PATCH /:id/lines/:lineId` (editing a line whose `source === 'auto'` requires `note` (min 1) → else `400 note_required`; after the edit `source = 'manual'`), `DELETE /:id/lines/:lineId`.
  - All line mutations and `PATCH`/`refresh-lines` call `assertPeriodEditable`.

- [ ] **Step 1: Write the failing tests**

`apps/api/test/periods.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('billing periods', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let buildingId: string; let vatId: string; let cleaningId: string; let liftId: string;
  const h = () => ({ cookie: a.cookie });
  const P = (s = '') => `/api/buildings/${buildingId}/periods${s}`;
  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-a');
    vatId = (await t.app.inject({ method: 'GET', url: '/api/tax-rates', headers: h() })).json().rows.find((r: { rateBp: number }) => r.rateBp === 1800).id;
    buildingId = (await t.app.inject({ method: 'POST', url: '/api/buildings', headers: h(), payload: { name: 'Зграда 1' } })).json().id;
    cleaningId = (await t.app.inject({ method: 'POST', url: '/api/services', headers: h(), payload: { name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 30000, taxRateId: vatId, appliesTo: ['apartment', 'commercial'] } })).json().id;
    liftId = (await t.app.inject({ method: 'POST', url: '/api/services', headers: h(), payload: { name: 'Лифт', pricing: 'shared_total', defaultPriceMinor: 600000, taxRateId: vatId } })).json().id;
    await t.app.inject({ method: 'POST', url: `/api/buildings/${buildingId}/services`, headers: h(), payload: { serviceId: cleaningId, startsPeriod: '2026-01' } });
    await t.app.inject({ method: 'POST', url: `/api/buildings/${buildingId}/services`, headers: h(), payload: { serviceId: liftId, startsPeriod: '2026-01', frequency: 'every_n_months', intervalMonths: 3 } });
  });
  afterAll(async () => { await t.close(); });

  it('creates a period with auto lines from due building services', async () => {
    const feb = await t.app.inject({ method: 'POST', url: P(), headers: h(), payload: { period: '2026-02' } });
    expect(feb.statusCode).toBe(201);
    expect(feb.json()).toMatchObject({ period: '2026-02', status: 'open', currency: 'MKD', managementFeeMinor: 0, managementFeeAppliesTo: ['apartment', 'commercial'], invoiceCount: 0 });
    expect(feb.json().lines.map((l: { description: string; source: string }) => [l.description, l.source])).toEqual([['Чистење', 'auto']]);
    const apr = await t.app.inject({ method: 'POST', url: P(), headers: h(), payload: { period: '2026-04', managementFeeMinor: 15000, managementFeeTaxRateId: vatId } });
    expect(apr.json()).toMatchObject({ managementFeeMinor: 15000, managementFeeTaxRateBp: 1800 });
    expect(apr.json().lines.map((l: { description: string; pricing: string; unitPriceMinor: number; taxRateBp: number }) => [l.description, l.pricing, l.unitPriceMinor, l.taxRateBp]))
      .toEqual([['Чистење', 'fixed_per_unit', 30000, 1800], ['Лифт', 'shared_total', 600000, 1800]]);
  });

  it('rejects duplicate periods and bad period strings', async () => {
    expect((await t.app.inject({ method: 'POST', url: P(), headers: h(), payload: { period: '2026-02' } })).statusCode).toBe(409);
    expect((await t.app.inject({ method: 'POST', url: P(), headers: h(), payload: { period: '2026-13' } })).statusCode).toBe(400);
  });

  it('adds manual lines from a service or free text', async () => {
    const id = (await t.app.inject({ method: 'GET', url: P(), headers: h() })).json().rows.find((p: { period: string }) => p.period === '2026-02').id;
    const fromService = await t.app.inject({ method: 'POST', url: P(`/${id}/lines`), headers: h(), payload: { serviceId: liftId, quantity: 0.5 } });
    expect(fromService.statusCode).toBe(201);
    expect(fromService.json()).toMatchObject({ description: 'Лифт', pricing: 'shared_total', unitPriceMinor: 600000, taxRateBp: 1800, quantity: 0.5, source: 'manual', fund: 'regular' });
    const free = await t.app.inject({ method: 'POST', url: P(`/${id}/lines`), headers: h(), payload: { description: 'Замена брава', pricing: 'fixed_per_unit', unitPriceMinor: 2500, appliesTo: ['apartment'], fund: 'regular' } });
    expect(free.statusCode).toBe(201);
    expect(free.json()).toMatchObject({ serviceId: null, taxRateBp: 0, appliesTo: ['apartment'] });
    expect((await t.app.inject({ method: 'POST', url: P(`/${id}/lines`), headers: h(), payload: { quantity: 2 } })).statusCode).toBe(400);
  });

  it('requires a note to edit an auto line and flips it to manual; refresh keeps manual lines', async () => {
    const id = (await t.app.inject({ method: 'GET', url: P(), headers: h() })).json().rows.find((p: { period: string }) => p.period === '2026-02').id;
    const detail = (await t.app.inject({ method: 'GET', url: P(`/${id}`), headers: h() })).json();
    const auto = detail.lines.find((l: { source: string }) => l.source === 'auto');
    const noNote = await t.app.inject({ method: 'PATCH', url: P(`/${id}/lines/${auto.id}`), headers: h(), payload: { unitPriceMinor: 32000 } });
    expect(noNote.statusCode).toBe(400);
    expect(noNote.json().error.code).toBe('note_required');
    const withNote = await t.app.inject({ method: 'PATCH', url: P(`/${id}/lines/${auto.id}`), headers: h(), payload: { unitPriceMinor: 32000, note: 'договорено попуст' } });
    expect(withNote.json()).toMatchObject({ unitPriceMinor: 32000, source: 'manual', note: 'договорено попуст' });
    const refreshed = (await t.app.inject({ method: 'POST', url: P(`/${id}/refresh-lines`), headers: h() })).json();
    const descs = refreshed.lines.map((l: { description: string; source: string; unitPriceMinor: number }) => `${l.description}:${l.source}:${l.unitPriceMinor}`);
    expect(descs).toContain('Чистење:auto:30000');   // rebuilt auto line
    expect(descs).toContain('Чистење:manual:32000'); // the edited copy survives as manual
    expect(descs).toContain('Замена брава:manual:2500');
    const del = await t.app.inject({ method: 'DELETE', url: P(`/${id}/lines/${refreshed.lines.find((l: { description: string }) => l.description === 'Замена брава').id}`), headers: h() });
    expect(del.statusCode).toBe(204);
  });

  it('updates fee and numbering, lists periods, and is tenant isolated', async () => {
    const rows = (await t.app.inject({ method: 'GET', url: P(), headers: h() })).json().rows;
    expect(rows.map((p: { period: string }) => p.period)).toEqual(['2026-04', '2026-02']);
    const id = rows[1].id;
    const upd = await t.app.inject({ method: 'PATCH', url: P(`/${id}`), headers: h(), payload: { numberPrefix: 'F-', numberSuffix: '/{year}-A', managementFeeMinor: 12000, managementFeeTaxRateId: null, managementFeeAppliesTo: ['apartment'] } });
    expect(upd.json()).toMatchObject({ numberPrefix: 'F-', numberSuffix: '/{year}-A', managementFeeMinor: 12000, managementFeeTaxRateBp: 0, managementFeeAppliesTo: ['apartment'] });
    const b = await registerTenant(t.app, 'firma-b');
    expect((await t.app.inject({ method: 'GET', url: P(`/${id}`), headers: { cookie: b.cookie } })).statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @domar/api test -- periods`
Expected: FAIL, 404.

- [ ] **Step 3: Implement**

`apps/api/src/resources/periods/schema.ts`:
```ts
import { z } from 'zod';
import { dedupe, moneyMinor, nullableStr, periodStr, unitKindEnum } from '../common.js';
import { fundEnum } from '../reserve-fund/schema.js';
import { pricingEnum } from '../services/schema.js';

export const periodStatusEnum = z.enum(['open', 'generated', 'published']);
export const lineOut = z.object({
  id: z.string(), serviceId: z.string().nullable(), description: z.string(), pricing: pricingEnum, quantity: z.number(), unitPriceMinor: z.number().int(),
  taxRateBp: z.number().int(), appliesTo: z.array(unitKindEnum), fund: fundEnum, source: z.enum(['auto', 'manual']), note: z.string().nullable(), sortOrder: z.number().int(),
});
export const periodOut = z.object({
  id: z.string(), buildingId: z.string(), period: z.string(), status: periodStatusEnum, managementFeeMinor: z.number().int(), managementFeeTaxRateBp: z.number().int(),
  managementFeeAppliesTo: z.array(unitKindEnum), numberPrefix: z.string(), numberSuffix: z.string(), currency: z.string(),
  issuedAt: z.date().or(z.string()).nullable(), dueAt: z.date().or(z.string()).nullable(), generatedAt: z.date().or(z.string()).nullable(), publishedAt: z.date().or(z.string()).nullable(),
  warnings: z.array(z.record(z.unknown())), invoiceCount: z.number().int(), totalMinor: z.number().int(), createdAt: z.date().or(z.string()), updatedAt: z.date().or(z.string()),
});
export const periodDetailOut = periodOut.extend({ lines: z.array(lineOut) });
export const periodCreate = z.object({
  period: periodStr, managementFeeMinor: moneyMinor.optional(), managementFeeTaxRateId: z.string().uuid().nullable().optional(),
  managementFeeAppliesTo: z.array(unitKindEnum).max(5).transform(dedupe).optional(),
});
export const periodPatch = z.object({
  managementFeeMinor: moneyMinor.optional(), managementFeeTaxRateId: z.string().uuid().nullable().optional(),
  managementFeeAppliesTo: z.array(unitKindEnum).max(5).transform(dedupe).optional(),
  numberPrefix: z.string().max(20).optional(), numberSuffix: z.string().max(20).optional(),
});
export const lineCreate = z.object({
  serviceId: z.string().uuid().optional(), description: z.string().min(1).max(300).optional(), pricing: pricingEnum.optional(),
  quantity: z.number().positive().max(1_000_000).optional(), unitPriceMinor: moneyMinor.optional(), taxRateId: z.string().uuid().nullable().optional(),
  appliesTo: z.array(unitKindEnum).max(5).transform(dedupe).optional(), fund: fundEnum.optional(), note: nullableStr(500),
}).refine((v) => v.serviceId || (v.description && v.pricing && v.unitPriceMinor !== undefined), { message: 'description, pricing and unitPriceMinor are required without serviceId' });
export const linePatch = z.object({
  description: z.string().min(1).max(300).optional(), pricing: pricingEnum.optional(), quantity: z.number().positive().max(1_000_000).optional(),
  unitPriceMinor: moneyMinor.optional(), taxRateId: z.string().uuid().nullable().optional(), appliesTo: z.array(unitKindEnum).max(5).transform(dedupe).optional(),
  fund: fundEnum.optional(), note: z.string().max(500).optional(),
});
export const periodParam = z.object({ buildingId: z.string().uuid(), id: z.string().uuid() });
export const lineParam = periodParam.extend({ lineId: z.string().uuid() });
export type PeriodCreate = z.infer<typeof periodCreate>;
export type PeriodPatch = z.infer<typeof periodPatch>;
export type LineCreate = z.infer<typeof lineCreate>;
export type LinePatch = z.infer<typeof linePatch>;
```

`apps/api/src/resources/periods/auto-lines.ts`:
```ts
import { type Db, schema } from '@domar/db';
import { isServiceDue } from '@domar/domain';
import { and, eq } from 'drizzle-orm';
import type { TenantContext } from '../../tenant-context.js';

export interface NewPeriodLine {
  serviceId: string | null;
  description: string;
  pricing: 'fixed_per_unit' | 'per_m2' | 'shared_total';
  quantity: string;
  unitPriceMinor: number;
  taxRateBp: number;
  appliesTo: string[];
  fund: 'regular' | 'reserve';
  source: 'auto' | 'manual';
  note: string | null;
  sortOrder: number;
}

export async function buildAutoLines(db: Db, ctx: TenantContext, buildingId: string, period: string): Promise<NewPeriodLine[]> {
  const BS = schema.buildingServices; const S = schema.services;
  const rows = await db.select({ bs: BS, s: S, rateBp: schema.taxRates.rateBp }).from(BS)
    .innerJoin(S, eq(S.id, BS.serviceId)).leftJoin(schema.taxRates, eq(schema.taxRates.id, S.taxRateId))
    .where(and(eq(BS.tenantId, ctx.tenantId), eq(BS.buildingId, buildingId), eq(BS.isActive, true), eq(S.isActive, true)))
    .orderBy(S.name);
  return rows
    .filter((r) => isServiceDue(period, { frequency: r.bs.frequency, intervalMonths: r.bs.intervalMonths, startsPeriod: r.bs.startsPeriod, endsPeriod: r.bs.endsPeriod }))
    .map((r, i) => ({
      serviceId: r.s.id, description: r.s.name, pricing: r.bs.pricing ?? r.s.pricing, quantity: '1', unitPriceMinor: r.bs.priceMinor ?? r.s.defaultPriceMinor,
      taxRateBp: r.rateBp ?? 0, appliesTo: r.s.appliesTo, fund: 'regular', source: 'auto', note: null, sortOrder: i * 10,
    }));
}
```

`apps/api/src/resources/periods/repo.ts`:
```ts
import { type Db, schema } from '@domar/db';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { badRequest, conflict, isUniqueViolation, notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import { stripUndefined } from '../common.js';
import { resolveTaxRateBp } from '../services/repo.js';
import { buildAutoLines, type NewPeriodLine } from './auto-lines.js';
import type { LineCreate, LinePatch, PeriodCreate, PeriodPatch } from './schema.js';

const BP = schema.billingPeriods; const PL = schema.periodLines; const INV = schema.invoices;
type PeriodRow = typeof BP.$inferSelect;

export function assertPeriodEditable(p: { status: string }) {
  if (p.status === 'published') throw conflict('period_locked', 'A published period cannot be changed');
}

function lineOut(l: typeof PL.$inferSelect) {
  return { ...l, quantity: Number(l.quantity) };
}

async function stats(db: Db, ctx: TenantContext, periodId: string) {
  const [r] = await db.select({ invoiceCount: count(), totalMinor: sql<string>`coalesce(sum(${INV.totalMinor}), 0)` }).from(INV).where(and(eq(INV.tenantId, ctx.tenantId), eq(INV.periodId, periodId)));
  return { invoiceCount: Number(r?.invoiceCount ?? 0), totalMinor: Number(r?.totalMinor ?? 0) };
}

export async function getPeriodRow(db: Db, ctx: TenantContext, buildingId: string, id: string): Promise<PeriodRow> {
  const row = await db.query.billingPeriods.findFirst({ where: and(eq(BP.tenantId, ctx.tenantId), eq(BP.buildingId, buildingId), eq(BP.id, id)) });
  if (!row) throw notFound('Billing period');
  return row;
}

export async function getPeriod(db: Db, ctx: TenantContext, buildingId: string, id: string) {
  const row = await getPeriodRow(db, ctx, buildingId, id);
  const lines = await db.query.periodLines.findMany({ where: and(eq(PL.tenantId, ctx.tenantId), eq(PL.periodId, id)), orderBy: [asc(PL.sortOrder), asc(PL.createdAt)] });
  return { ...row, ...(await stats(db, ctx, id)), lines: lines.map(lineOut) };
}

export async function listPeriods(db: Db, ctx: TenantContext, buildingId: string) {
  await getBuilding(db, ctx, buildingId);
  const rows = await db.select({ p: BP, invoiceCount: sql<number>`(select count(*) from ${INV} i where i.period_id = "billing_periods"."id")`.mapWith(Number), totalMinor: sql<string>`(select coalesce(sum(i.total_minor),0) from ${INV} i where i.period_id = "billing_periods"."id")` })
    .from(BP).where(and(eq(BP.tenantId, ctx.tenantId), eq(BP.buildingId, buildingId))).orderBy(desc(BP.period));
  return { rows: rows.map((r) => ({ ...r.p, invoiceCount: r.invoiceCount, totalMinor: Number(r.totalMinor) })) };
}

async function insertLines(db: Db, ctx: TenantContext, periodId: string, lines: NewPeriodLine[]) {
  if (lines.length === 0) return;
  await db.insert(PL).values(lines.map((l) => ({ ...l, tenantId: ctx.tenantId, periodId })));
}

export async function createPeriod(db: Db, ctx: TenantContext, buildingId: string, input: PeriodCreate) {
  return db.transaction(async (tx) => {
    await getBuilding(tx, ctx, buildingId);
    const tenant = await tx.query.tenants.findFirst({ where: eq(schema.tenants.id, ctx.tenantId), columns: { currency: true } });
    const feeBp = (await resolveTaxRateBp(tx, ctx, input.managementFeeTaxRateId)) ?? 0;
    let row: PeriodRow | undefined;
    try {
      [row] = await tx.insert(BP).values({
        tenantId: ctx.tenantId, buildingId, period: input.period, currency: tenant!.currency,
        managementFeeMinor: input.managementFeeMinor ?? 0, managementFeeTaxRateBp: feeBp,
        ...(input.managementFeeAppliesTo ? { managementFeeAppliesTo: input.managementFeeAppliesTo } : {}),
      }).returning();
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('period_exists', `Period ${input.period} already exists for this building`);
      throw e;
    }
    await insertLines(tx, ctx, row!.id, await buildAutoLines(tx, ctx, buildingId, input.period));
    await writeAudit(tx, ctx, { action: 'period.create', entityType: 'billing_period', entityId: row!.id, after: row });
    return getPeriod(tx, ctx, buildingId, row!.id);
  });
}

export async function updatePeriod(db: Db, ctx: TenantContext, buildingId: string, id: string, patch: PeriodPatch) {
  return db.transaction(async (tx) => {
    const before = await getPeriodRow(tx, ctx, buildingId, id);
    assertPeriodEditable(before);
    const { managementFeeTaxRateId, ...rest } = patch;
    const set: Record<string, unknown> = { ...stripUndefined(rest), updatedAt: new Date() };
    if (managementFeeTaxRateId !== undefined) set.managementFeeTaxRateBp = (await resolveTaxRateBp(tx, ctx, managementFeeTaxRateId)) ?? 0;
    const [row] = await tx.update(BP).set(set).where(and(eq(BP.tenantId, ctx.tenantId), eq(BP.id, id))).returning();
    await writeAudit(tx, ctx, { action: 'period.update', entityType: 'billing_period', entityId: id, before, after: row });
    return getPeriod(tx, ctx, buildingId, id);
  });
}

export async function refreshAutoLines(db: Db, ctx: TenantContext, buildingId: string, id: string) {
  return db.transaction(async (tx) => {
    const period = await getPeriodRow(tx, ctx, buildingId, id);
    assertPeriodEditable(period);
    await tx.delete(PL).where(and(eq(PL.tenantId, ctx.tenantId), eq(PL.periodId, id), eq(PL.source, 'auto')));
    await insertLines(tx, ctx, id, await buildAutoLines(tx, ctx, buildingId, period.period));
    await writeAudit(tx, ctx, { action: 'period.refresh_lines', entityType: 'billing_period', entityId: id });
    return getPeriod(tx, ctx, buildingId, id);
  });
}

export async function addLine(db: Db, ctx: TenantContext, buildingId: string, id: string, input: LineCreate) {
  return db.transaction(async (tx) => {
    const period = await getPeriodRow(tx, ctx, buildingId, id);
    assertPeriodEditable(period);
    let base: Partial<NewPeriodLine> = {};
    if (input.serviceId) {
      const s = await tx.select({ s: schema.services, rateBp: schema.taxRates.rateBp }).from(schema.services).leftJoin(schema.taxRates, eq(schema.taxRates.id, schema.services.taxRateId))
        .where(and(eq(schema.services.tenantId, ctx.tenantId), eq(schema.services.id, input.serviceId), eq(schema.services.isActive, true))).limit(1);
      if (!s[0]) throw badRequest('invalid_reference', 'serviceId is not an active service of this organization');
      base = { serviceId: s[0].s.id, description: s[0].s.name, pricing: s[0].s.pricing, unitPriceMinor: s[0].s.defaultPriceMinor, taxRateBp: s[0].rateBp ?? 0, appliesTo: s[0].s.appliesTo };
    }
    const taxRateBp = input.taxRateId !== undefined ? ((await resolveTaxRateBp(tx, ctx, input.taxRateId)) ?? 0) : (base.taxRateBp ?? 0);
    const [{ max }] = await tx.select({ max: sql<number>`coalesce(max(${PL.sortOrder}), -10)`.mapWith(Number) }).from(PL).where(eq(PL.periodId, id));
    const line: NewPeriodLine = {
      serviceId: base.serviceId ?? null, description: input.description ?? base.description!, pricing: input.pricing ?? base.pricing!,
      quantity: String(input.quantity ?? 1), unitPriceMinor: input.unitPriceMinor ?? base.unitPriceMinor!, taxRateBp,
      appliesTo: input.appliesTo ?? base.appliesTo ?? [], fund: input.fund ?? 'regular', source: 'manual', note: input.note ?? null, sortOrder: (max ?? -10) + 10,
    };
    const [row] = await tx.insert(PL).values({ ...line, tenantId: ctx.tenantId, periodId: id }).returning();
    await writeAudit(tx, ctx, { action: 'period_line.create', entityType: 'period_line', entityId: row!.id, after: row });
    return lineOut(row!);
  });
}

export async function updateLine(db: Db, ctx: TenantContext, buildingId: string, id: string, lineId: string, patch: LinePatch) {
  return db.transaction(async (tx) => {
    const period = await getPeriodRow(tx, ctx, buildingId, id);
    assertPeriodEditable(period);
    const before = await tx.query.periodLines.findFirst({ where: and(eq(PL.tenantId, ctx.tenantId), eq(PL.periodId, id), eq(PL.id, lineId)) });
    if (!before) throw notFound('Period line');
    if (before.source === 'auto' && !patch.note) throw badRequest('note_required', 'Editing an automatic line requires a note');
    const { taxRateId, quantity, ...rest } = patch;
    const set: Record<string, unknown> = { ...stripUndefined(rest), source: 'manual', updatedAt: new Date() };
    if (quantity !== undefined) set.quantity = String(quantity);
    if (taxRateId !== undefined) set.taxRateBp = (await resolveTaxRateBp(tx, ctx, taxRateId)) ?? 0;
    const [row] = await tx.update(PL).set(set).where(eq(PL.id, lineId)).returning();
    await writeAudit(tx, ctx, { action: 'period_line.update', entityType: 'period_line', entityId: lineId, before, after: row });
    return lineOut(row!);
  });
}

export async function deleteLine(db: Db, ctx: TenantContext, buildingId: string, id: string, lineId: string) {
  return db.transaction(async (tx) => {
    const period = await getPeriodRow(tx, ctx, buildingId, id);
    assertPeriodEditable(period);
    const before = await tx.query.periodLines.findFirst({ where: and(eq(PL.tenantId, ctx.tenantId), eq(PL.periodId, id), eq(PL.id, lineId)) });
    if (!before) throw notFound('Period line');
    await tx.delete(PL).where(eq(PL.id, lineId));
    await writeAudit(tx, ctx, { action: 'period_line.delete', entityType: 'period_line', entityId: lineId, before });
  });
}
```

`apps/api/src/resources/periods/routes.ts`:
```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { buildingParam } from '../units/schema.js';
import { addLine, createPeriod, deleteLine, getPeriod, listPeriods, refreshAutoLines, updateLine, updatePeriod } from './repo.js';
import { lineCreate, lineOut, lineParam, linePatch, periodCreate, periodDetailOut, periodOut, periodParam, periodPatch } from './schema.js';

export const periodRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  const write = { preHandler: requireRole(...WRITE_ROLES) };
  app.get('/', { schema: { params: buildingParam, response: { 200: z.object({ rows: z.array(periodOut) }) } } }, async (req) => listPeriods(req.db, req.ctx!, req.params.buildingId));
  app.post('/', { ...write, schema: { params: buildingParam, body: periodCreate, response: { 201: periodDetailOut } } }, async (req, reply) => reply.status(201).send(await createPeriod(req.db, req.ctx!, req.params.buildingId, req.body)));
  app.get('/:id', { schema: { params: periodParam, response: { 200: periodDetailOut } } }, async (req) => getPeriod(req.db, req.ctx!, req.params.buildingId, req.params.id));
  app.patch('/:id', { ...write, schema: { params: periodParam, body: periodPatch, response: { 200: periodDetailOut } } }, async (req) => updatePeriod(req.db, req.ctx!, req.params.buildingId, req.params.id, req.body));
  app.post('/:id/refresh-lines', { ...write, schema: { params: periodParam, response: { 200: periodDetailOut } } }, async (req) => refreshAutoLines(req.db, req.ctx!, req.params.buildingId, req.params.id));
  app.post('/:id/lines', { ...write, schema: { params: periodParam, body: lineCreate, response: { 201: lineOut } } }, async (req, reply) => reply.status(201).send(await addLine(req.db, req.ctx!, req.params.buildingId, req.params.id, req.body)));
  app.patch('/:id/lines/:lineId', { ...write, schema: { params: lineParam, body: linePatch, response: { 200: lineOut } } }, async (req) => updateLine(req.db, req.ctx!, req.params.buildingId, req.params.id, req.params.lineId, req.body));
  app.delete('/:id/lines/:lineId', { ...write, schema: { params: lineParam } }, async (req, reply) => { await deleteLine(req.db, req.ctx!, req.params.buildingId, req.params.id, req.params.lineId); return reply.status(204).send(); });
};
```

`app.ts`: `await api.register(periodRoutes, { prefix: '/buildings/:buildingId/periods' });`

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @domar/api test && pnpm typecheck && pnpm lint`
Expected: PASS (+5 tests). If drizzle rejects `"billing_periods"."id"` inside the raw subquery, alias the outer table with `BP.id` via `sql\`${BP.id}\`` — the Foundation note about unqualified rendering applies only inside `select({...})` of a single table; check the generated SQL with the drizzle logger if in doubt and report which form worked.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): billing periods with automatic and manual lines"
```

---

### Task 7: Generate, publish and invoices

**Files:**
- Create: `apps/api/src/resources/invoicing/generate.ts`, `apps/api/src/resources/invoicing/publish.ts`, `apps/api/src/resources/invoicing/numbering.ts`, `apps/api/src/resources/invoicing/routes.ts`
- Create: `apps/api/src/resources/invoices/schema.ts`, `apps/api/src/resources/invoices/repo.ts`, `apps/api/src/resources/invoices/routes.ts`
- Create: `apps/api/test/invoicing.test.ts`
- Modify: `apps/api/src/app.ts` (register invoicing routes under `/buildings/:buildingId/periods` after `periodRoutes`, and `invoiceRoutes` under `/invoices`)

**Interfaces:**
- Produces:
  - `generatePeriod(db, ctx, buildingId, periodId)` → `{ period: periodDetail, invoiceCount, totalMinor, warnings, skippedUnits }`. Steps in one transaction: load period (status `open`|`generated`, else `409 period_locked`), units + owners, lines, reserve fund setting, building; assemble `CalcInput` (engine lines from period lines with `kind: serviceId ? 'service' : 'manual'`, plus `reserve_fund` line when the setting is active with `amountMinor > 0`, plus `management_fee` line when `managementFeeMinor > 0` using `managementFeeAppliesTo`), `previousBalances = ownerBalances(...)`, `reserveFundBuildingBalanceMinor = fundBalance(reserve)`; delete existing draft invoices of the period (cascade lines; no postings exist for drafts); insert invoices + lines; set period `status='generated'`, `generatedAt`, `warnings`; audit.
  - `deleteDrafts(db, ctx, buildingId, periodId)` → period back to `open` (409 if published).
  - `publishPeriod(db, ctx, buildingId, periodId)` → requires `status === 'generated'` and ≥1 draft (`409 nothing_to_publish`); `issuedAt = now`, `dueAt = now + 15 days`; for each draft in `contact lastName, firstName` order: `number = nextInvoiceNumber(tx, ctx, issuedAt.getFullYear(), prefix, suffix)`, status `published`, `publishedAt`; `charge` postings (`account 'owner'`, `fund = line.fund`, `contactId`, `amountMinor = ownerGrossMinor`, `refType 'invoice'`, `refId = invoice.id`, `period`) — one posting per invoice line; period `status='published'`, `issuedAt`, `dueAt`, `publishedAt`; audit `period.publish`.
  - `nextInvoiceNumber(tx, ctx, year, prefix, suffix)` using `INSERT ... ON CONFLICT (tenant_id, year) DO UPDATE SET next = invoice_sequences.next + 1 RETURNING next` → `seq = next - 1`; number `${prefix}${String(seq).padStart(4,'0')}${suffix.replace('{year}', String(year))}`.
  - Invoices: `listInvoices(db, ctx, { buildingId?, period?, status?, contactId?, page, pageSize })` → `{ rows, total }` rows with `contact: { id, firstName, lastName }`, `building: { id, name }`, `period: string`; `getInvoice(db, ctx, id)` → invoice + `lines` (ordered) + `contact` (full) + `building` + `periodLabel`; `deleteDraftInvoice(db, ctx, id)` (409 `not_draft` otherwise; if the period has no drafts left → `open`).
  - Routes: `POST /api/buildings/:buildingId/periods/:id/generate`, `DELETE .../drafts`, `POST .../publish` (all write roles); `GET /api/invoices`, `GET /api/invoices/:id`, `DELETE /api/invoices/:id`.
  - `invoiceOut`: `id, periodId, buildingId, contactId, number, status, currency, unitIds, subtotalMinor, taxMinor, totalMinor, previousBalanceMinor, amountDueMinor, reserveFundBuildingBalanceMinor, issuedAt, dueAt, publishedAt, period, contact, building, createdAt`; `invoiceLineOut`: `id, kind, description, fund, unitId, unitLabel, buildingWideNetMinor, ownerNetMinor, taxRateBp, ownerTaxMinor, ownerGrossMinor, sortOrder`.

- [ ] **Step 1: Write the failing tests**

`apps/api/test/invoicing.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('generate and publish', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let buildingId: string; let vatId: string; let periodId: string;
  const owners: Record<string, string> = {};
  const h = () => ({ cookie: a.cookie });
  const P = (s = '') => `/api/buildings/${buildingId}/periods${s}`;
  const post = (url: string, payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url, headers: h(), payload });

  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-a');
    vatId = (await t.app.inject({ method: 'GET', url: '/api/tax-rates', headers: h() })).json().rows.find((r: { rateBp: number }) => r.rateBp === 1800).id;
    for (const [k, ln] of [['O1', 'Анѓеловски'], ['O2', 'Бошковски'], ['O3', 'Велковски']] as const) {
      owners[k] = (await post('/api/contacts', { firstName: 'Тест', lastName: ln })).json().id;
    }
    buildingId = (await post('/api/buildings', { name: 'Партизанска 12', shareBasis: 'area' })).json().id;
    const U = (p: Record<string, unknown>) => post(`/api/buildings/${buildingId}/units`, p);
    const A = (await U({ label: '1', kind: 'apartment', areaM2: 50, ownerContactId: owners.O1 })).json().id;
    await U({ label: '2', kind: 'apartment', areaM2: 75, ownerContactId: owners.O2 });
    await U({ label: 'L1', kind: 'commercial', areaM2: 100, ownerContactId: owners.O3 });
    await U({ label: 'P-1', kind: 'parking', attachedToUnitId: A });
    await U({ label: 'S-1', kind: 'storage', areaM2: 10 });
    const cleaning = (await post('/api/services', { name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 30000, taxRateId: vatId, appliesTo: ['apartment', 'commercial'] })).json().id;
    const lift = (await post('/api/services', { name: 'Лифт', pricing: 'shared_total', defaultPriceMinor: 600000, taxRateId: vatId })).json().id;
    await post(`/api/buildings/${buildingId}/services`, { serviceId: cleaning, startsPeriod: '2026-01' });
    await post(`/api/buildings/${buildingId}/services`, { serviceId: lift, startsPeriod: '2026-01' });
    await t.app.inject({ method: 'PUT', url: `/api/buildings/${buildingId}/reserve-fund`, headers: h(), payload: { basis: 'per_m2', amountMinor: 1000, appliesTo: ['apartment', 'commercial'], active: true } });
    await post(`/api/buildings/${buildingId}/reserve-fund/opening-balance`, { amountMinor: 3500000 });
    const period = await post(P(), { period: '2026-09', managementFeeMinor: 15000, managementFeeTaxRateId: vatId });
    periodId = period.json().id;
    await post(P(`/${periodId}/lines`), { description: 'Осветлување паркинг', pricing: 'fixed_per_unit', unitPriceMinor: 2000, taxRateId: vatId, appliesTo: ['parking'] });
  });
  afterAll(async () => { await t.close(); });

  it('generates one draft per owner with the engine totals and no postings', async () => {
    const gen = await post(P(`/${periodId}/generate`), {});
    expect(gen.statusCode).toBe(200);
    expect(gen.json()).toMatchObject({ invoiceCount: 3, totalMinor: 256099 + 354057 + 454376 });
    expect(gen.json().warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'missing_area' }), expect.objectContaining({ code: 'no_owner' })]));
    expect(gen.json().period.status).toBe('generated');
    const list = await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}&period=2026-09`, headers: h() });
    expect(list.json().total).toBe(3);
    const o1 = list.json().rows.find((i: { contactId: string }) => i.contactId === owners.O1);
    expect(o1).toMatchObject({ status: 'draft', number: null, subtotalMinor: 224660, taxMinor: 31439, totalMinor: 256099, previousBalanceMinor: 0, amountDueMinor: 256099, reserveFundBuildingBalanceMinor: 3500000, currency: 'MKD' });
    const postings = await t.db.query.postings.findMany();
    expect(postings.filter((p) => p.kind === 'charge')).toHaveLength(0);
  });

  it('regenerates idempotently (drafts replaced, still 3)', async () => {
    const before = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}`, headers: h() })).json().rows.map((i: { id: string }) => i.id).sort();
    const gen = await post(P(`/${periodId}/generate`), {});
    expect(gen.json().invoiceCount).toBe(3);
    const after = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}`, headers: h() })).json().rows.map((i: { id: string }) => i.id).sort();
    expect(after).toHaveLength(3);
    expect(after).not.toEqual(before);
  });

  it('shows invoice detail with Art. 33 lines', async () => {
    const list = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}`, headers: h() })).json().rows;
    const o1 = list.find((i: { contactId: string }) => i.contactId === owners.O1);
    const detail = (await t.app.inject({ method: 'GET', url: `/api/invoices/${o1.id}`, headers: h() })).json();
    expect(detail.lines).toHaveLength(5);
    expect(detail.lines.map((l: { kind: string }) => l.kind).sort()).toEqual(['management_fee', 'manual', 'reserve_fund', 'service', 'service']);
    const lift = detail.lines.find((l: { description: string }) => l.description === 'Лифт');
    expect(lift).toMatchObject({ buildingWideNetMinor: 600000, ownerNetMinor: 127660, ownerTaxMinor: 22979, ownerGrossMinor: 150639, unitLabel: '1' });
    expect(detail.contact.lastName).toBe('Анѓеловски');
    expect(detail.building.name).toBe('Партизанска 12');
    expect(detail.period).toBe('2026-09');
  });

  it('publishes: numbers, dates, postings, balances', async () => {
    const pub = await post(P(`/${periodId}/publish`), {});
    expect(pub.statusCode).toBe(200);
    expect(pub.json().period.status).toBe('published');
    const rows = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}&status=published`, headers: h() })).json().rows;
    expect(rows.map((i: { number: string }) => i.number).sort()).toEqual(['INV-0001/2026', 'INV-0002/2026', 'INV-0003/2026']);
    expect(rows.every((i: { issuedAt: string | null; dueAt: string | null }) => i.issuedAt && i.dueAt)).toBe(true);
    const due = new Date(rows[0].dueAt).getTime() - new Date(rows[0].issuedAt).getTime();
    expect(due).toBe(15 * 24 * 3600 * 1000);
    const charges = (await t.db.query.postings.findMany()).filter((p) => p.kind === 'charge');
    expect(charges.reduce((s, p) => s + p.amountMinor, 0)).toBe(256099 + 354057 + 454376);
    expect(charges.filter((p) => p.fund === 'reserve').reduce((s, p) => s + p.amountMinor, 0)).toBe(225000);
    const rf = (await t.app.inject({ method: 'GET', url: `/api/buildings/${buildingId}/reserve-fund`, headers: h() })).json();
    expect(rf).toMatchObject({ balanceMinor: 3500000, contributionsBilledMinor: 225000 });
    expect((await post(P(`/${periodId}/publish`), {})).statusCode).toBe(409);
    expect((await post(P(`/${periodId}/lines`), { description: 'x', pricing: 'fixed_per_unit', unitPriceMinor: 1 })).json().error.code).toBe('period_locked');
  });

  it('carries the previous balance into the next period and continues numbering', async () => {
    const oct = (await post(P(), { period: '2026-10' })).json();
    await post(P(`/${oct.id}/generate`), {});
    const rows = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}&period=2026-10`, headers: h() })).json().rows;
    const o1 = rows.find((i: { contactId: string }) => i.contactId === owners.O1);
    expect(o1.previousBalanceMinor).toBe(256099);
    expect(o1.amountDueMinor).toBe(o1.totalMinor + 256099);
    await post(P(`/${oct.id}/publish`), {});
    const numbers = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}&period=2026-10`, headers: h() })).json().rows.map((i: { number: string }) => i.number).sort();
    expect(numbers).toEqual(['INV-0004/2026', 'INV-0005/2026', 'INV-0006/2026']);
  });

  it('refuses to delete a published invoice, deletes drafts, and is tenant isolated', async () => {
    const pubRows = (await t.app.inject({ method: 'GET', url: `/api/invoices?status=published`, headers: h() })).json().rows;
    expect((await t.app.inject({ method: 'DELETE', url: `/api/invoices/${pubRows[0].id}`, headers: h() })).statusCode).toBe(409);
    const nov = (await post(P(), { period: '2026-11' })).json();
    await post(P(`/${nov.id}/generate`), {});
    const drafts = (await t.app.inject({ method: 'GET', url: `/api/invoices?period=2026-11`, headers: h() })).json().rows;
    expect((await t.app.inject({ method: 'DELETE', url: `/api/invoices/${drafts[0].id}`, headers: h() })).statusCode).toBe(204);
    const del = await t.app.inject({ method: 'DELETE', url: P(`/${nov.id}/drafts`), headers: h() });
    expect(del.statusCode).toBe(200);
    expect(del.json().status).toBe('open');
    expect((await t.app.inject({ method: 'GET', url: `/api/invoices?period=2026-11`, headers: h() })).json().total).toBe(0);
    expect((await post(P(`/${nov.id}/publish`), {})).json().error.code).toBe('nothing_to_publish');
    const b = await registerTenant(t.app, 'firma-b');
    expect((await t.app.inject({ method: 'GET', url: `/api/invoices/${pubRows[0].id}`, headers: { cookie: b.cookie } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/api/invoices', headers: { cookie: b.cookie } })).json().total).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @domar/api test -- invoicing`
Expected: FAIL, 404 on generate.

- [ ] **Step 3: Implement**

`apps/api/src/resources/invoicing/numbering.ts`:
```ts
import { type Db, schema } from '@domar/db';
import { sql } from 'drizzle-orm';
import type { TenantContext } from '../../tenant-context.js';

export function formatInvoiceNumber(seq: number, prefix: string, suffix: string, year: number): string {
  return `${prefix}${String(seq).padStart(4, '0')}${suffix.replaceAll('{year}', String(year))}`;
}

/** Atomically reserves the next sequence number for the tenant and year. */
export async function nextInvoiceNumber(db: Db, ctx: TenantContext, year: number, prefix: string, suffix: string): Promise<string> {
  const S = schema.invoiceSequences;
  const [row] = await db.insert(S).values({ tenantId: ctx.tenantId, year, next: 2 })
    .onConflictDoUpdate({ target: [S.tenantId, S.year], set: { next: sql`${S.next} + 1` } })
    .returning({ next: S.next });
  return formatInvoiceNumber(row!.next - 1, prefix, suffix, year);
}
```

`apps/api/src/resources/invoicing/generate.ts`:
```ts
import { type Db, schema } from '@domar/db';
import { calculatePeriod, type CalcInput, type CalcLine, type UnitKind } from '@domar/domain';
import { and, eq, inArray } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { conflict } from '../../errors.js';
import { fundBalance, ownerBalances } from '../../ledger.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import { getPeriod, getPeriodRow } from '../periods/repo.js';
import { getReserveFundSetting } from '../reserve-fund/repo.js';

const INV = schema.invoices; const IL = schema.invoiceLines;

export async function buildCalcInput(db: Db, ctx: TenantContext, buildingId: string, periodId: string): Promise<CalcInput> {
  const building = await getBuilding(db, ctx, buildingId);
  const period = await getPeriod(db, ctx, buildingId, periodId);
  const units = await db.query.units.findMany({ where: and(eq(schema.units.tenantId, ctx.tenantId), eq(schema.units.buildingId, buildingId)), orderBy: (u, { asc }) => [asc(u.floor), asc(u.label)] });
  const lines: CalcLine[] = period.lines.map((l) => ({
    id: l.id, kind: l.serviceId ? 'service' : 'manual', description: l.description, pricing: l.pricing, quantity: l.quantity,
    unitPriceMinor: l.unitPriceMinor, taxRateBp: l.taxRateBp, appliesTo: l.appliesTo as UnitKind[], fund: l.fund,
  }));
  const rf = await getReserveFundSetting(db, ctx, buildingId);
  if (rf?.active && rf.amountMinor > 0) {
    lines.push({ id: `reserve-fund:${rf.id}`, kind: 'reserve_fund', description: 'Резервен фонд', pricing: rf.basis === 'per_m2' ? 'per_m2' : 'fixed_per_unit', quantity: 1, unitPriceMinor: rf.amountMinor, taxRateBp: 0, appliesTo: rf.appliesTo as UnitKind[], fund: 'reserve' });
  }
  if (period.managementFeeMinor > 0) {
    lines.push({ id: `management-fee:${period.id}`, kind: 'management_fee', description: 'Управувачки услуги', pricing: 'fixed_per_unit', quantity: 1, unitPriceMinor: period.managementFeeMinor, taxRateBp: period.managementFeeTaxRateBp, appliesTo: period.managementFeeAppliesTo as UnitKind[], fund: 'regular' });
  }
  return {
    building: { id: building.id, shareBasis: building.shareBasis },
    units: units.map((u) => ({ id: u.id, label: u.label, kind: u.kind, areaM2: u.areaM2 === null ? null : Number(u.areaM2), ownershipShare: u.ownershipShare === null ? null : Number(u.ownershipShare), ownerContactId: u.ownerContactId, attachedToUnitId: u.attachedToUnitId })),
    lines,
    previousBalances: await ownerBalances(db, ctx, buildingId),
    reserveFundBuildingBalanceMinor: await fundBalance(db, ctx, buildingId, 'reserve'),
  };
}

async function deleteDraftInvoices(db: Db, ctx: TenantContext, periodId: string) {
  const drafts = await db.select({ id: INV.id }).from(INV).where(and(eq(INV.tenantId, ctx.tenantId), eq(INV.periodId, periodId), eq(INV.status, 'draft')));
  if (drafts.length) await db.delete(INV).where(inArray(INV.id, drafts.map((d) => d.id))); // cascades invoice_lines
  return drafts.length;
}

export async function generatePeriod(db: Db, ctx: TenantContext, buildingId: string, periodId: string) {
  return db.transaction(async (tx) => {
    const period = await getPeriodRow(tx, ctx, buildingId, periodId);
    if (period.status === 'published') throw conflict('period_locked', 'A published period cannot be regenerated');
    const input = await buildCalcInput(tx, ctx, buildingId, periodId);
    const result = calculatePeriod(input);
    await deleteDraftInvoices(tx, ctx, periodId);
    const lineIdIsPeriodLine = new Set(input.lines.filter((l) => l.kind === 'service' || l.kind === 'manual').map((l) => l.id));
    for (const draft of result.invoices) {
      const [inv] = await tx.insert(INV).values({
        tenantId: ctx.tenantId, periodId, buildingId, contactId: draft.contactId, status: 'draft', currency: period.currency, unitIds: draft.unitIds,
        subtotalMinor: draft.subtotalMinor, taxMinor: draft.taxMinor, totalMinor: draft.totalMinor, previousBalanceMinor: draft.previousBalanceMinor,
        amountDueMinor: draft.amountDueMinor, reserveFundBuildingBalanceMinor: draft.reserveFundBuildingBalanceMinor,
      }).returning({ id: INV.id });
      await tx.insert(IL).values(draft.lines.map((l, i) => ({
        tenantId: ctx.tenantId, invoiceId: inv!.id, periodLineId: lineIdIsPeriodLine.has(l.lineId) ? l.lineId : null, kind: l.kind, description: l.description, fund: l.fund,
        unitId: l.unitId, unitLabel: l.unitLabel, buildingWideNetMinor: l.buildingWideNetMinor, ownerNetMinor: l.ownerNetMinor, taxRateBp: l.taxRateBp,
        ownerTaxMinor: l.ownerTaxMinor, ownerGrossMinor: l.ownerGrossMinor, sortOrder: i,
      })));
    }
    await tx.update(schema.billingPeriods).set({ status: 'generated', generatedAt: new Date(), warnings: result.warnings, updatedAt: new Date() }).where(eq(schema.billingPeriods.id, periodId));
    await writeAudit(tx, ctx, { action: 'period.generate', entityType: 'billing_period', entityId: periodId, after: { invoiceCount: result.invoices.length, warnings: result.warnings } });
    const detail = await getPeriod(tx, ctx, buildingId, periodId);
    return { period: detail, invoiceCount: detail.invoiceCount, totalMinor: detail.totalMinor, warnings: result.warnings, skippedUnits: result.skippedUnits };
  });
}

export async function deleteDrafts(db: Db, ctx: TenantContext, buildingId: string, periodId: string) {
  return db.transaction(async (tx) => {
    const period = await getPeriodRow(tx, ctx, buildingId, periodId);
    if (period.status === 'published') throw conflict('period_locked', 'A published period has no drafts');
    const n = await deleteDraftInvoices(tx, ctx, periodId);
    await tx.update(schema.billingPeriods).set({ status: 'open', generatedAt: null, warnings: [], updatedAt: new Date() }).where(eq(schema.billingPeriods.id, periodId));
    await writeAudit(tx, ctx, { action: 'period.delete_drafts', entityType: 'billing_period', entityId: periodId, after: { deleted: n } });
    return getPeriod(tx, ctx, buildingId, periodId);
  });
}
```

`apps/api/src/resources/invoicing/publish.ts`:
```ts
import { type Db, schema } from '@domar/db';
import { and, asc, eq } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { conflict } from '../../errors.js';
import { addPostings, type NewPosting } from '../../ledger.js';
import type { TenantContext } from '../../tenant-context.js';
import { getPeriod, getPeriodRow } from '../periods/repo.js';
import { nextInvoiceNumber } from './numbering.js';

const INV = schema.invoices; const IL = schema.invoiceLines; const C = schema.contacts;
const DUE_DAYS = 15;

export async function publishPeriod(db: Db, ctx: TenantContext, buildingId: string, periodId: string) {
  return db.transaction(async (tx) => {
    const period = await getPeriodRow(tx, ctx, buildingId, periodId);
    if (period.status !== 'generated') throw conflict(period.status === 'published' ? 'period_locked' : 'nothing_to_publish', 'Generate drafts before publishing');
    const drafts = await tx.select({ inv: INV, lastName: C.lastName, firstName: C.firstName }).from(INV).innerJoin(C, eq(C.id, INV.contactId))
      .where(and(eq(INV.tenantId, ctx.tenantId), eq(INV.periodId, periodId), eq(INV.status, 'draft'))).orderBy(asc(C.lastName), asc(C.firstName));
    if (drafts.length === 0) throw conflict('nothing_to_publish', 'There are no draft invoices in this period');
    const issuedAt = new Date();
    const dueAt = new Date(issuedAt.getTime() + DUE_DAYS * 24 * 3600 * 1000);
    const postings: NewPosting[] = [];
    for (const { inv } of drafts) {
      const number = await nextInvoiceNumber(tx, ctx, issuedAt.getFullYear(), period.numberPrefix, period.numberSuffix);
      await tx.update(INV).set({ number, status: 'published', issuedAt, dueAt, publishedAt: issuedAt, updatedAt: issuedAt }).where(eq(INV.id, inv.id));
      const lines = await tx.select().from(IL).where(eq(IL.invoiceId, inv.id));
      for (const l of lines) {
        postings.push({ buildingId, account: 'owner', fund: l.fund, contactId: inv.contactId, kind: 'charge', amountMinor: l.ownerGrossMinor, refType: 'invoice', refId: inv.id, period: period.period, bookedAt: issuedAt });
      }
    }
    await addPostings(tx, ctx, postings);
    await tx.update(schema.billingPeriods).set({ status: 'published', issuedAt, dueAt, publishedAt: issuedAt, updatedAt: issuedAt }).where(eq(schema.billingPeriods.id, periodId));
    await writeAudit(tx, ctx, { action: 'period.publish', entityType: 'billing_period', entityId: periodId, after: { invoices: drafts.length, issuedAt, dueAt } });
    const detail = await getPeriod(tx, ctx, buildingId, periodId);
    return { period: detail, invoiceCount: detail.invoiceCount, totalMinor: detail.totalMinor };
  });
}
```

`apps/api/src/resources/invoicing/routes.ts`:
```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { periodDetailOut, periodParam } from '../periods/schema.js';
import { deleteDrafts, generatePeriod } from './generate.js';
import { publishPeriod } from './publish.js';

const summaryOut = z.object({ period: periodDetailOut, invoiceCount: z.number().int(), totalMinor: z.number().int(), warnings: z.array(z.record(z.unknown())).optional(), skippedUnits: z.array(z.object({ unitId: z.string(), reason: z.string() })).optional() });

export const invoicingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  const write = { preHandler: requireRole(...WRITE_ROLES) };
  app.post('/:id/generate', { ...write, schema: { params: periodParam, response: { 200: summaryOut } } }, async (req) => generatePeriod(req.db, req.ctx!, req.params.buildingId, req.params.id));
  app.delete('/:id/drafts', { ...write, schema: { params: periodParam, response: { 200: periodDetailOut } } }, async (req) => deleteDrafts(req.db, req.ctx!, req.params.buildingId, req.params.id));
  app.post('/:id/publish', { ...write, schema: { params: periodParam, response: { 200: summaryOut } } }, async (req) => publishPeriod(req.db, req.ctx!, req.params.buildingId, req.params.id));
};
```

`apps/api/src/resources/invoices/schema.ts`:
```ts
import { z } from 'zod';
import { pageQuery, periodStr } from '../common.js';
import { fundEnum } from '../reserve-fund/schema.js';

export const invoiceStatusEnum = z.enum(['draft', 'published', 'partially_paid', 'paid', 'cancelled']);
const dt = () => z.date().or(z.string()).nullable();
export const invoiceRowOut = z.object({
  id: z.string(), periodId: z.string(), buildingId: z.string(), contactId: z.string(), number: z.string().nullable(), status: invoiceStatusEnum, currency: z.string(),
  unitIds: z.array(z.string()), subtotalMinor: z.number().int(), taxMinor: z.number().int(), totalMinor: z.number().int(), previousBalanceMinor: z.number().int(),
  amountDueMinor: z.number().int(), reserveFundBuildingBalanceMinor: z.number().int(), issuedAt: dt(), dueAt: dt(), publishedAt: dt(), period: z.string(),
  contact: z.object({ id: z.string(), firstName: z.string(), lastName: z.string() }), building: z.object({ id: z.string(), name: z.string() }), createdAt: z.date().or(z.string()),
});
export const invoiceLineOut = z.object({
  id: z.string(), kind: z.enum(['service', 'manual', 'reserve_fund', 'management_fee']), description: z.string(), fund: fundEnum, unitId: z.string().nullable(), unitLabel: z.string(),
  buildingWideNetMinor: z.number().int(), ownerNetMinor: z.number().int(), taxRateBp: z.number().int(), ownerTaxMinor: z.number().int(), ownerGrossMinor: z.number().int(), sortOrder: z.number().int(),
});
export const invoiceDetailOut = invoiceRowOut.extend({
  lines: z.array(invoiceLineOut),
  contact: z.object({ id: z.string(), kind: z.enum(['person', 'company']), firstName: z.string(), lastName: z.string(), email: z.string().nullable(), address: z.string().nullable(), companyNumber: z.string().nullable(), vatNumber: z.string().nullable() }),
  building: z.object({ id: z.string(), name: z.string(), address: z.string(), city: z.string(), postalCode: z.string(), regularFundAccount: z.string().nullable(), reserveFundAccount: z.string().nullable() }),
});
export const invoiceListQuery = pageQuery.extend({ buildingId: z.string().uuid().optional(), period: periodStr.optional(), status: invoiceStatusEnum.optional(), contactId: z.string().uuid().optional() });
```

`apps/api/src/resources/invoices/repo.ts`:
```ts
import { type Db, schema } from '@domar/db';
import { and, asc, count, desc, eq } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { conflict, notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';

const INV = schema.invoices; const IL = schema.invoiceLines; const C = schema.contacts; const B = schema.buildings; const BP = schema.billingPeriods;

const rowSelect = { inv: INV, period: BP.period, contact: { id: C.id, firstName: C.firstName, lastName: C.lastName }, building: { id: B.id, name: B.name } };
function joined(db: Db) {
  return db.select(rowSelect).from(INV).innerJoin(BP, eq(BP.id, INV.periodId)).innerJoin(C, eq(C.id, INV.contactId)).innerJoin(B, eq(B.id, INV.buildingId));
}
const toRow = (r: { inv: typeof INV.$inferSelect; period: string; contact: { id: string; firstName: string; lastName: string }; building: { id: string; name: string } }) => ({ ...r.inv, period: r.period, contact: r.contact, building: r.building });

export async function listInvoices(db: Db, ctx: TenantContext, q: { buildingId?: string | undefined; period?: string | undefined; status?: string | undefined; contactId?: string | undefined; page: number; pageSize: number }) {
  const conds = [eq(INV.tenantId, ctx.tenantId)];
  if (q.buildingId) conds.push(eq(INV.buildingId, q.buildingId));
  if (q.period) conds.push(eq(BP.period, q.period));
  if (q.status) conds.push(eq(INV.status, q.status as typeof INV.$inferSelect.status));
  if (q.contactId) conds.push(eq(INV.contactId, q.contactId));
  const where = and(...conds);
  const [rows, totalRows] = await Promise.all([
    joined(db).where(where).orderBy(desc(BP.period), asc(C.lastName), asc(C.firstName)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db.select({ total: count() }).from(INV).innerJoin(BP, eq(BP.id, INV.periodId)).where(where),
  ]);
  return { rows: rows.map(toRow), total: Number(totalRows[0]?.total ?? 0) };
}

export async function getInvoice(db: Db, ctx: TenantContext, id: string) {
  const [r] = await joined(db).where(and(eq(INV.tenantId, ctx.tenantId), eq(INV.id, id))).limit(1);
  if (!r) throw notFound('Invoice');
  const [contact, building, lines] = await Promise.all([
    db.query.contacts.findFirst({ where: eq(C.id, r.inv.contactId) }),
    db.query.buildings.findFirst({ where: eq(B.id, r.inv.buildingId) }),
    db.query.invoiceLines.findMany({ where: and(eq(IL.tenantId, ctx.tenantId), eq(IL.invoiceId, id)), orderBy: [asc(IL.sortOrder)] }),
  ]);
  return { ...toRow(r), contact: contact!, building: building!, lines };
}

export async function deleteDraftInvoice(db: Db, ctx: TenantContext, id: string) {
  return db.transaction(async (tx) => {
    const inv = await tx.query.invoices.findFirst({ where: and(eq(INV.tenantId, ctx.tenantId), eq(INV.id, id)) });
    if (!inv) throw notFound('Invoice');
    if (inv.status !== 'draft') throw conflict('not_draft', 'Only draft invoices can be deleted');
    await tx.delete(INV).where(eq(INV.id, id));
    const [left] = await tx.select({ n: count() }).from(INV).where(and(eq(INV.periodId, inv.periodId), eq(INV.status, 'draft')));
    if (Number(left?.n ?? 0) === 0) await tx.update(BP).set({ status: 'open', generatedAt: null, updatedAt: new Date() }).where(eq(BP.id, inv.periodId));
    await writeAudit(tx, ctx, { action: 'invoice.delete_draft', entityType: 'invoice', entityId: id, before: inv });
  });
}
```

`apps/api/src/resources/invoices/routes.ts`:
```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { idParam } from '../common.js';
import { deleteDraftInvoice, getInvoice, listInvoices } from './repo.js';
import { invoiceDetailOut, invoiceListQuery, invoiceRowOut } from './schema.js';

export const invoiceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  app.get('/', { schema: { querystring: invoiceListQuery, response: { 200: z.object({ rows: z.array(invoiceRowOut), total: z.number() }) } } }, async (req) => listInvoices(req.db, req.ctx!, req.query));
  app.get('/:id', { schema: { params: idParam, response: { 200: invoiceDetailOut } } }, async (req) => getInvoice(req.db, req.ctx!, req.params.id));
  app.delete('/:id', { preHandler: requireRole(...WRITE_ROLES), schema: { params: idParam } }, async (req, reply) => { await deleteDraftInvoice(req.db, req.ctx!, req.params.id); return reply.status(204).send(); });
};
```

`app.ts`: `await api.register(invoicingRoutes, { prefix: '/buildings/:buildingId/periods' });` (a second plugin on the same prefix is fine — different routes) and `await api.register(invoiceRoutes, { prefix: '/invoices' });`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @domar/api test && pnpm typecheck && pnpm lint`
Expected: PASS (+6 tests). The totals in the test are the engine fixture values; if a number differs, the engine or the input assembly deviates — do not adjust the expectation, find the difference (units order, appliesTo of the management fee, reserve setting).

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): generate drafts, publish with numbering and ledger charges, invoice list and detail"
```

---

### Task 8: Invoice HTML (Art. 33 layout) and PDF endpoint

**Files:**
- Create: `apps/api/src/pdf/invoice-html.ts`, `apps/api/src/pdf/html-to-pdf.ts`, `apps/api/src/pdf/routes.ts`
- Create: `apps/api/test/invoice-html.test.ts`
- Modify: `apps/api/package.json` (add `playwright-core ^1.48.0`), `apps/api/src/app.ts` (register `pdfRoutes` under `/invoices`), `.env.example` (`PDF_BROWSER_CHANNEL=chrome`), `apps/api/src/config.ts` (`pdfBrowserChannel: string`, default `chrome`)

**Interfaces:**
- Produces: `renderInvoiceHtml(data: InvoiceHtmlData): string` — pure; `InvoiceHtmlData = { invoice: Awaited<ReturnType<typeof getInvoice>>, tenant: { name, companyNumber, vatNumber, address, phone, email, bankName, bankAccount }, formatMoney: (minor: number) => string, locale: 'mk' }`. Layout sections, in order: header (tenant "Од", invoice number or "НАЦРТ", period, issued/due), recipient (contact name, address, units), lines table with columns `Опис | Единица | За зградата | Ваш дел (нето) | ДДВ % | ДДВ | Вкупно` grouped: services & manual, then `Управувачки услуги`, then `Резервен фонд` (Art. 33 §2), totals (subtotal, tax, total, previous balance, amount due), reserve fund building balance line, payment block (bank name, account of the building's regular fund or tenant account, reference = invoice number), footer with portal hint placeholder. All labels from a `mk` dictionary inside the file (owner-facing document language is the tenant's; `en` later).
- `htmlToPdf(html: string, channel: string): Promise<Buffer>` — launches `chromium.launch({ channel })` from `playwright-core`, `page.setContent`, `page.pdf({ format: 'A4', printBackground: true, margin: 15mm })`, closes the browser; throws on launch failure.
- Routes: `GET /api/invoices/:id/html` → `text/html; charset=utf-8`; `GET /api/invoices/:id/pdf` → `application/pdf` with `Content-Disposition: inline; filename="<number or draft-id>.pdf"`; launch failure → `503 pdf_unavailable`.

- [ ] **Step 1: Write the failing test**

`apps/api/test/invoice-html.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { mkPack } from '@domar/domain';
import { renderInvoiceHtml } from '../src/pdf/invoice-html.js';

const invoice = {
  id: 'inv1', periodId: 'p1', buildingId: 'b1', contactId: 'c1', number: 'INV-0001/2026', status: 'published' as const, currency: 'MKD', unitIds: ['A', 'P1'],
  subtotalMinor: 224660, taxMinor: 31439, totalMinor: 256099, previousBalanceMinor: 5000, amountDueMinor: 261099, reserveFundBuildingBalanceMinor: 3500000,
  issuedAt: new Date('2026-10-01T08:00:00Z'), dueAt: new Date('2026-10-16T08:00:00Z'), publishedAt: new Date('2026-10-01T08:00:00Z'), createdAt: new Date(), updatedAt: new Date(), period: '2026-09',
  contact: { id: 'c1', kind: 'person' as const, firstName: 'Тест', lastName: 'Анѓеловски', email: null, address: 'Партизанска 12/1', companyNumber: null, vatNumber: null, phone: null, notes: null, tenantId: 't', createdAt: new Date(), updatedAt: new Date() },
  building: { id: 'b1', name: 'Партизанска 12', address: 'Партизанска 12', city: 'Скопје', postalCode: '1000', regularFundAccount: '200001234567890', reserveFundAccount: '200009876543210', countryCode: 'mk', representativeContactId: null, shareBasis: 'area' as const, tenantId: 't', createdAt: new Date(), updatedAt: new Date() },
  lines: [
    { id: 'l1', kind: 'service' as const, description: 'Чистење', fund: 'regular' as const, unitId: 'A', unitLabel: '1', buildingWideNetMinor: 90000, ownerNetMinor: 30000, taxRateBp: 1800, ownerTaxMinor: 5400, ownerGrossMinor: 35400, sortOrder: 0, tenantId: 't', invoiceId: 'inv1', periodLineId: null },
    { id: 'l2', kind: 'management_fee' as const, description: 'Управувачки услуги', fund: 'regular' as const, unitId: 'A', unitLabel: '1', buildingWideNetMinor: 45000, ownerNetMinor: 15000, taxRateBp: 1800, ownerTaxMinor: 2700, ownerGrossMinor: 17700, sortOrder: 1, tenantId: 't', invoiceId: 'inv1', periodLineId: null },
    { id: 'l3', kind: 'reserve_fund' as const, description: 'Резервен фонд', fund: 'reserve' as const, unitId: 'A', unitLabel: '1', buildingWideNetMinor: 225000, ownerNetMinor: 50000, taxRateBp: 0, ownerTaxMinor: 0, ownerGrossMinor: 50000, sortOrder: 2, tenantId: 't', invoiceId: 'inv1', periodLineId: null },
  ],
};
const tenant = { name: 'Тест Фирма ДООЕЛ', companyNumber: '1234567', vatNumber: 'MK4030001234567', address: 'ул. 1 бр. 1, Скопје', phone: '+389 2 000 000', email: 'info@firma.mk', bankName: 'Комерцијална банка', bankAccount: '300000000000000' };

describe('renderInvoiceHtml', () => {
  const html = renderInvoiceHtml({ invoice, tenant, formatMoney: mkPack.formatMoney, locale: 'mk' });
  it('contains header, parties and number', () => {
    for (const s of ['INV-0001/2026', 'Тест Фирма ДООЕЛ', 'MK4030001234567', 'Тест Анѓеловски', 'Партизанска 12/1', '2026-09', 'Партизанска 12']) expect(html).toContain(s);
  });
  it('shows every line with building-wide and owner amounts (Art. 33)', () => {
    expect(html).toContain('Чистење');
    expect(html).toContain('900,00 ден.');   // building-wide net of cleaning
    expect(html).toContain('300,00 ден.');   // owner net
    expect(html).toContain('354,00 ден.');   // owner gross
    expect(html).toContain('Управувачки услуги');
    expect(html).toContain('Резервен фонд');
    expect(html).toContain('2.250,00 ден.'); // reserve fund building-wide
  });
  it('shows totals, previous balance, amount due and the reserve fund building balance', () => {
    for (const s of ['2.246,60 ден.', '314,39 ден.', '2.560,99 ден.', '50,00 ден.', '2.610,99 ден.', '35.000,00 ден.']) expect(html).toContain(s);
  });
  it('shows payment details with the invoice number as reference', () => {
    expect(html).toContain('Комерцијална банка');
    expect(html).toContain('200001234567890');
    expect(html).toMatch(/Цел на дознака[\s\S]{0,80}INV-0001\/2026/);
  });
  it('labels drafts and escapes HTML in user data', () => {
    const draft = renderInvoiceHtml({ invoice: { ...invoice, number: null, status: 'draft', contact: { ...invoice.contact, lastName: '<b>X</b>' } }, tenant, formatMoney: mkPack.formatMoney, locale: 'mk' });
    expect(draft).toContain('НАЦРТ');
    expect(draft).not.toContain('<b>X</b>');
    expect(draft).toContain('&lt;b&gt;X&lt;/b&gt;');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @domar/api test -- invoice-html`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement**

`apps/api/src/pdf/invoice-html.ts`:
```ts
import type { getInvoice } from '../resources/invoices/repo.js';

export interface InvoiceHtmlData {
  invoice: Awaited<ReturnType<typeof getInvoice>>;
  tenant: { name: string; companyNumber: string | null; vatNumber: string | null; address: string | null; phone: string | null; email: string | null; bankName: string | null; bankAccount: string | null };
  formatMoney: (minor: number) => string;
  locale: 'mk';
}

const L = {
  mk: {
    title: 'Пресметка за трошоци', draft: 'НАЦРТ', from: 'Од', to: 'За', number: 'Број', period: 'Период', issued: 'Датум', due: 'Рок за плаќање', units: 'Единици',
    companyNumber: 'ЕМБС', vatNumber: 'ЕДБ', description: 'Опис', unit: 'Единица', buildingWide: 'За зградата', ownerNet: 'Ваш дел (нето)', vatRate: 'ДДВ %', vat: 'ДДВ', gross: 'Вкупно',
    services: 'Услуги и трошоци', managementFee: 'Надоместок за управувачки услуги', reserveFund: 'Резервен фонд', subtotal: 'Нето', tax: 'ДДВ', total: 'Вкупно за периодот', previous: 'Претходно салдо', due_: 'Вкупно за плаќање',
    rfBalance: 'Состојба на резервниот фонд на зградата', payment: 'Плаќање', bank: 'Банка', account: 'Сметка', reference: 'Цел на дознака', footer: 'Пресметката е изготвена согласно член 33 од Законот за домување.',
  },
} as const;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
const e = escapeHtml;
const date = (d: Date | string | null) => (d ? new Date(d).toLocaleDateString('mk-MK', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—');

export function renderInvoiceHtml({ invoice, tenant, formatMoney: m, locale }: InvoiceHtmlData): string {
  const t = L[locale];
  const inv = invoice;
  const groups: [string, typeof inv.lines][] = [
    [t.services, inv.lines.filter((l) => l.kind === 'service' || l.kind === 'manual')],
    [t.managementFee, inv.lines.filter((l) => l.kind === 'management_fee')],
    [t.reserveFund, inv.lines.filter((l) => l.kind === 'reserve_fund')],
  ];
  const rows = groups.filter(([, ls]) => ls.length > 0).map(([title, ls]) => `
    <tr class="group"><td colspan="7">${e(title)}</td></tr>
    ${ls.map((l) => `<tr><td>${e(l.description)}</td><td>${e(l.unitLabel)}</td><td class="num">${e(m(l.buildingWideNetMinor))}</td><td class="num">${e(m(l.ownerNetMinor))}</td><td class="num">${(l.taxRateBp / 100).toFixed(2)}</td><td class="num">${e(m(l.ownerTaxMinor))}</td><td class="num">${e(m(l.ownerGrossMinor))}</td></tr>`).join('')}`).join('');
  const contactName = `${inv.contact.firstName} ${inv.contact.lastName}`.trim();
  const unitLabels = [...new Set(inv.lines.map((l) => l.unitLabel))].join(', ');
  const account = inv.building.regularFundAccount ?? tenant.bankAccount ?? '';
  const reference = inv.number ?? inv.id;
  return `<!doctype html><html lang="mk"><head><meta charset="utf-8"><title>${e(inv.number ?? t.draft)}</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#111;margin:0}
h1{font-size:18px;margin:0 0 4px}.muted{color:#555}.draft{color:#b00;font-weight:bold;font-size:14px}
.row{display:flex;justify-content:space-between;gap:24px;margin-bottom:16px}.box{flex:1}
table{width:100%;border-collapse:collapse;margin-top:8px}th,td{padding:4px 6px;border-bottom:1px solid #ddd;text-align:left}th{background:#f3f3f3}
td.num,th.num{text-align:right;white-space:nowrap}tr.group td{background:#fafafa;font-weight:bold;border-top:2px solid #ccc}
.totals td{border:none}.totals tr.due td{font-weight:bold;font-size:13px;border-top:2px solid #111}
.footer{margin-top:24px;font-size:10px;color:#555}
</style></head><body>
<div class="row"><div class="box"><h1>${e(t.title)}</h1>${inv.number ? `<div><strong>${e(t.number)}:</strong> ${e(inv.number)}</div>` : `<div class="draft">${e(t.draft)}</div>`}
<div><strong>${e(t.period)}:</strong> ${e(inv.period)}</div><div><strong>${e(t.issued)}:</strong> ${e(date(inv.issuedAt))} &nbsp; <strong>${e(t.due)}:</strong> ${e(date(inv.dueAt))}</div></div>
<div class="box"><div class="muted">${e(t.from)}</div><strong>${e(tenant.name)}</strong><br>${e(tenant.address ?? '')}<br>${tenant.companyNumber ? `${e(t.companyNumber)}: ${e(tenant.companyNumber)}<br>` : ''}${tenant.vatNumber ? `${e(t.vatNumber)}: ${e(tenant.vatNumber)}<br>` : ''}${e(tenant.phone ?? '')} ${e(tenant.email ?? '')}</div></div>
<div class="row"><div class="box"><div class="muted">${e(t.to)}</div><strong>${e(contactName)}</strong><br>${e(inv.contact.address ?? '')}<br>${inv.contact.companyNumber ? `${e(t.companyNumber)}: ${e(inv.contact.companyNumber)}<br>` : ''}</div>
<div class="box"><div class="muted">${e(inv.building.name)}</div>${e(inv.building.address)}, ${e(inv.building.postalCode)} ${e(inv.building.city)}<br>${e(t.units)}: ${e(unitLabels)}</div></div>
<table><thead><tr><th>${e(t.description)}</th><th>${e(t.unit)}</th><th class="num">${e(t.buildingWide)}</th><th class="num">${e(t.ownerNet)}</th><th class="num">${e(t.vatRate)}</th><th class="num">${e(t.vat)}</th><th class="num">${e(t.gross)}</th></tr></thead><tbody>${rows}</tbody></table>
<table class="totals"><tr><td></td><td class="num" style="width:40%">${e(t.subtotal)}: ${e(m(inv.subtotalMinor))}</td></tr>
<tr><td></td><td class="num">${e(t.tax)}: ${e(m(inv.taxMinor))}</td></tr>
<tr><td></td><td class="num">${e(t.total)}: ${e(m(inv.totalMinor))}</td></tr>
<tr><td></td><td class="num">${e(t.previous)}: ${e(m(inv.previousBalanceMinor))}</td></tr>
<tr class="due"><td></td><td class="num">${e(t.due_)}: ${e(m(inv.amountDueMinor))}</td></tr></table>
<p><strong>${e(t.rfBalance)}:</strong> ${e(m(inv.reserveFundBuildingBalanceMinor))}</p>
<div class="row"><div class="box"><strong>${e(t.payment)}</strong><br>${e(t.bank)}: ${e(tenant.bankName ?? '')}<br>${e(t.account)}: ${e(account)}<br>${e(t.reference)}: ${e(reference)}</div></div>
<div class="footer">${e(t.footer)}</div>
</body></html>`;
}
```

`apps/api/src/pdf/html-to-pdf.ts`:
```ts
import { chromium } from 'playwright-core';

export async function htmlToPdf(html: string, channel: string): Promise<Buffer> {
  const browser = await chromium.launch({ channel, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '15mm', right: '15mm', bottom: '15mm', left: '15mm' } });
  } finally {
    await browser.close();
  }
}
```

`apps/api/src/pdf/routes.ts`:
```ts
import { getCountryPack, type CountryCode } from '@domar/domain';
import { schema } from '@domar/db';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { AppError } from '../errors.js';
import { idParam } from '../resources/common.js';
import { getInvoice } from '../resources/invoices/repo.js';
import { htmlToPdf } from './html-to-pdf.js';
import { renderInvoiceHtml } from './invoice-html.js';

export const pdfRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  const render = async (req: Parameters<Parameters<typeof app.get>[2]>[0] & { params: { id: string } }) => {
    const invoice = await getInvoice(req.db, req.ctx!, req.params.id);
    const tenant = (await req.db.query.tenants.findFirst({ where: eq(schema.tenants.id, req.ctx!.tenantId) }))!;
    const pack = getCountryPack(tenant.countryCode as CountryCode);
    return { html: renderInvoiceHtml({ invoice, tenant, formatMoney: pack.formatMoney, locale: 'mk' }), invoice };
  };
  app.get('/:id/html', { schema: { params: idParam } }, async (req, reply) => {
    const { html } = await render(req);
    return reply.type('text/html; charset=utf-8').send(html);
  });
  app.get('/:id/pdf', { schema: { params: idParam } }, async (req, reply) => {
    const { html, invoice } = await render(req);
    let pdf: Buffer;
    try {
      pdf = await htmlToPdf(html, app.config.pdfBrowserChannel);
    } catch (err) {
      app.log.warn({ err }, 'pdf browser launch failed');
      throw new AppError(503, 'pdf_unavailable', 'PDF rendering is not available on this server');
    }
    const name = (invoice.number ?? `draft-${invoice.id}`).replace(/[^A-Za-z0-9_.-]/g, '_');
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${name}.pdf"`).send(pdf);
  });
};
```
If the `render` helper's request type is awkward, type it as `FastifyRequest<{ Params: { id: string } }>` imported from fastify.

`config.ts`: add `PDF_BROWSER_CHANNEL: z.string().default('chrome')` → `pdfBrowserChannel`. `.env.example`: `# Browser channel for PDF rendering (chrome | chromium | msedge)` + `PDF_BROWSER_CHANNEL=chrome`. `app.ts`: `await api.register(pdfRoutes, { prefix: '/invoices' });`. Add `playwright-core` to apps/api dependencies.

Add to `apps/api/test/invoicing.test.ts` one assertion at the end of the publish test: `GET /api/invoices/:id/html` for a published invoice → 200, content-type text/html, body contains the invoice number and 'Резервен фонд'.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @domar/api test && pnpm typecheck && pnpm lint`
Expected: PASS (+5 tests, +1 assertion). Manually: `curl -b cookie http://localhost:3001/api/invoices/<id>/pdf -o x.pdf` produces a PDF when Chrome is installed (report the result; not a test).

- [ ] **Step 5: Commit**

```bash
git add apps/api .env.example
git commit -m "feat(api): Art. 33 invoice HTML renderer and PDF endpoint"
```

---

### Task 9: Web — services page, money formatting, i18n keys for billing

**Files:**
- Create: `apps/web/src/pages/ServicesPage.vue`, `apps/web/src/utils/money.ts`, `apps/web/test/money.test.ts`
- Modify: `apps/web/src/i18n/mk.ts`, `apps/web/src/i18n/en.ts` (add `services.*`, `billing.*`, `periods.*`, `invoices.*`, `reserveFund.*`, `nav.services`, `nav.invoices` — full key list below; both locales), `apps/web/src/api/types.ts` (billing types), `apps/web/src/router/index.ts` (`/app/services`, `/app/invoices`, `/app/invoices/:id`, `/app/buildings/:id/periods/:periodId` — the last three point at pages created in Tasks 10–11; create placeholders now), `apps/web/src/layouts/AppShell.vue` (nav items `nav-services`, `nav-invoices`)

**Interfaces:**
- Produces: `formatMoney(minor: number, currency = 'MKD'): string` → `1.234,56 ден.` for MKD (grouping `.`, decimal `,`, suffix ` ден.`; other currencies use `Intl.NumberFormat('mk-MK', { style: 'currency', currency })`), `toMinor(input: string | number): number | null` (parses `1234,56` / `1234.56` → 123456; empty → null), `percentFromBp(bp)`.
- Types: `Service`, `BuildingService`, `ReserveFundState`, `Expense`, `Period`, `PeriodLine`, `Invoice`, `InvoiceLine`, `PricingModel`, `Fund` mirroring the API schemas of Tasks 3–7.
- i18n keys (both locales; mk shown, en mirrors): `nav.services` 'Услуги', `nav.invoices` 'Фактури'; `services.title` 'Услуги', `services.add` 'Додади услуга', `services.name` 'Име', `services.category` 'Категорија', `services.pricing` 'Модел на цена', `services.pricingOptions.fixed_per_unit` 'Фиксно по единица', `services.pricingOptions.per_m2` 'По m²', `services.pricingOptions.shared_total` 'Заедничко (се дели)', `services.defaultPrice` 'Стандардна цена', `services.taxRate` 'Даночна стапка', `services.noTax` 'Без данок', `services.recurring` 'Периодична', `services.oneTime` 'Еднократна', `services.appliesTo` 'Се однесува на', `services.allKinds` 'Сите типови'; `billing.regular` 'Редовен фонд', `billing.reserve` 'Резервен фонд', `billing.fund` 'Фонд', `billing.amount` 'Износ', `billing.quantity` 'Количина', `billing.unitPrice` 'Цена', `billing.tax` 'ДДВ', `billing.total` 'Вкупно', `billing.subtotal` 'Нето', `billing.previousBalance` 'Претходно салдо', `billing.amountDue` 'За плаќање', `billing.buildingWide` 'За зградата', `billing.ownerShare` 'Ваш дел', `billing.description` 'Опис', `billing.period` 'Период', `billing.status` 'Статус'; `buildingServices.title` 'Периодични услуги', `buildingServices.attach` 'Додади периодична услуга', `buildingServices.frequency` 'Фреквенција', `buildingServices.monthly` 'Месечно', `buildingServices.everyN` 'На секои N месеци', `buildingServices.intervalMonths` 'Интервал (месеци)', `buildingServices.startsPeriod` 'Од период', `buildingServices.endsPeriod` 'До период', `buildingServices.overridePrice` 'Цена за оваа зграда (опционално)', `buildingServices.detach` 'Отстрани'; `reserveFund.title` 'Резервен фонд', `reserveFund.basis` 'Основ', `reserveFund.perUnit` 'По единица', `reserveFund.perM2` 'По m²', `reserveFund.active` 'Активен', `reserveFund.balance` 'Состојба', `reserveFund.billed` 'Фактурирано на сопственици', `reserveFund.openingBalance` 'Почетно салдо', `reserveFund.addOpening` 'Внеси почетно салдо', `reserveFund.expenses` 'Трошоци', `reserveFund.addExpense` 'Евидентирај трошок', `reserveFund.supplier` 'Добавувач', `reserveFund.paidAt` 'Платено на', `reserveFund.void` 'Поништи', `reserveFund.voided` 'Поништено', `reserveFund.transactions` 'Трансакции'; `periods.title` 'Пресметки', `periods.create` 'Нов период', `periods.managementFee` 'Надоместок за управување (по единица)', `periods.managementFeeTax` 'ДДВ на надоместокот', `periods.numbering` 'Нумерација', `periods.prefix` 'Префикс', `periods.suffix` 'Суфикс', `periods.lines` 'Ставки', `periods.addLine` 'Додади ставка', `periods.fromService` 'Од услуга', `periods.auto` 'Авто', `periods.manual` 'Рачно', `periods.note` 'Забелешка (задолжителна за авто ставки)', `periods.refresh` 'Освежи авто ставки', `periods.generate` 'Генерирај фактури', `periods.regenerate` 'Генерирај повторно', `periods.deleteDrafts` 'Избриши нацрти', `periods.publish` 'Објави ги сите', `periods.publishConfirm` 'Објавените фактури не може да се избришат. Продолжи?', `periods.warnings` 'Предупредувања', `periods.warning.missing_area` 'Единица {unit} нема површина — не учествува во распределбата по m².', `periods.warning.missing_share` 'Единица {unit} нема сопственички удел.', `periods.warning.no_owner` 'Единица {unit} нема сопственик — не е фактурирана.', `periods.warning.no_weight` 'Ставка без единици за распределба — изоставена.', `periods.status.open` 'Отворен', `periods.status.generated` 'Нацрти', `periods.status.published` 'Објавен', `periods.invoices` 'Фактури', `periods.locked` 'Периодот е објавен и не може да се менува.'; `invoices.title` 'Фактури', `invoices.number` 'Број', `invoices.owner` 'Сопственик', `invoices.building` 'Зграда', `invoices.status.draft` 'Нацрт', `invoices.status.published` 'Објавена', `invoices.status.partially_paid` 'Делумно платена', `invoices.status.paid` 'Платена', `invoices.status.cancelled` 'Откажана', `invoices.openHtml` 'Отвори (HTML)', `invoices.downloadPdf` 'Преземи PDF', `invoices.deleteDraft` 'Избриши нацрт', `invoices.reserveBalance` 'Состојба на резервен фонд на зградата', `invoices.issued` 'Издадена', `invoices.due` 'Рок', `invoices.units` 'Единици', `invoices.lineKind.service` 'Услуга', `invoices.lineKind.manual` 'Ставка', `invoices.lineKind.reserve_fund` 'Резервен фонд', `invoices.lineKind.management_fee` 'Управување'.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/money.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { formatMoney, percentFromBp, toMinor } from '@/utils/money';

describe('money utils', () => {
  it('formats MKD minor units the Macedonian way', () => {
    expect(formatMoney(123456789)).toBe('1.234.567,89 ден.');
    expect(formatMoney(-50)).toBe('-0,50 ден.');
    expect(formatMoney(0)).toBe('0,00 ден.');
  });
  it('parses user input to minor units', () => {
    expect(toMinor('1234,56')).toBe(123456);
    expect(toMinor('1234.56')).toBe(123456);
    expect(toMinor('1.234,5')).toBe(123450);
    expect(toMinor(300)).toBe(30000);
    expect(toMinor('')).toBeNull();
    expect(toMinor('abc')).toBeNull();
  });
  it('converts basis points to percent text', () => {
    expect(percentFromBp(1800)).toBe('18,00 %');
    expect(percentFromBp(0)).toBe('0,00 %');
  });
});
```
Also extend `test/LoginPage.test.ts`'s i18n parity test? It already compares all keys of both locales — adding keys to both keeps it green; adding to one fails it. Good.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @domar/web test`
Expected: FAIL, `@/utils/money` missing.

- [ ] **Step 3: Implement**

`apps/web/src/utils/money.ts`:
```ts
export function formatMoney(minor: number, currency = 'MKD'): string {
  if (currency !== 'MKD') return new Intl.NumberFormat('mk-MK', { style: 'currency', currency }).format(minor / 100);
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const int = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${int},${String(abs % 100).padStart(2, '0')} ден.`;
}

/** "1.234,56" | "1234.56" | 300 → minor units; empty/garbage → null */
export function toMinor(input: string | number): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) : null;
  const s = input.replace(/\s/g, '');
  if (!/^-?[\d.,]+$/.test(s)) return null;
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  let normalized: string;
  if (lastComma > lastDot) normalized = s.replace(/\./g, '').replace(',', '.');
  else if (lastDot > lastComma) normalized = s.replace(/,/g, '');
  else normalized = s;
  const n = Number(normalized);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function percentFromBp(bp: number): string {
  return `${(bp / 100).toFixed(2).replace('.', ',')} %`;
}
```

`apps/web/src/api/types.ts` — add:
```ts
export type PricingModel = 'fixed_per_unit' | 'per_m2' | 'shared_total';
export type Fund = 'regular' | 'reserve';
export interface Service { id: string; name: string; category: string | null; description: string | null; pricing: PricingModel; defaultPriceMinor: number; taxRateId: string | null; taxRateBp: number; appliesTo: UnitKind[]; recurring: boolean; isActive: boolean }
export interface BuildingService { id: string; buildingId: string; serviceId: string; priceMinor: number | null; pricing: PricingModel | null; frequency: 'monthly' | 'every_n_months'; intervalMonths: number; startsPeriod: string; endsPeriod: string | null; isActive: boolean; effectivePriceMinor: number; effectivePricing: PricingModel; service: { id: string; name: string; pricing: PricingModel; defaultPriceMinor: number; taxRateBp: number; appliesTo: UnitKind[]; isActive: boolean } }
export interface ReserveFundSetting { id: string; buildingId: string; basis: 'per_unit' | 'per_m2'; amountMinor: number; appliesTo: UnitKind[]; active: boolean }
export interface ReserveFundState { setting: ReserveFundSetting | null; balanceMinor: number; contributionsBilledMinor: number }
export interface Expense { id: string; buildingId: string; fund: Fund; description: string; supplierText: string | null; amountMinor: number; paidAt: string; voidedAt: string | null; voidReason: string | null }
export interface FundTransaction { id: string; kind: string; fund: Fund; amountMinor: number; refType: string; refId: string | null; bookedAt: string; description: string | null }
export interface PeriodLine { id: string; serviceId: string | null; description: string; pricing: PricingModel; quantity: number; unitPriceMinor: number; taxRateBp: number; appliesTo: UnitKind[]; fund: Fund; source: 'auto' | 'manual'; note: string | null; sortOrder: number }
export interface Period { id: string; buildingId: string; period: string; status: 'open' | 'generated' | 'published'; managementFeeMinor: number; managementFeeTaxRateBp: number; managementFeeAppliesTo: UnitKind[]; numberPrefix: string; numberSuffix: string; currency: string; issuedAt: string | null; dueAt: string | null; generatedAt: string | null; publishedAt: string | null; warnings: Record<string, unknown>[]; invoiceCount: number; totalMinor: number; lines?: PeriodLine[] }
export type InvoiceStatus = 'draft' | 'published' | 'partially_paid' | 'paid' | 'cancelled';
export interface InvoiceLine { id: string; kind: 'service' | 'manual' | 'reserve_fund' | 'management_fee'; description: string; fund: Fund; unitId: string | null; unitLabel: string; buildingWideNetMinor: number; ownerNetMinor: number; taxRateBp: number; ownerTaxMinor: number; ownerGrossMinor: number; sortOrder: number }
export interface Invoice { id: string; periodId: string; buildingId: string; contactId: string; number: string | null; status: InvoiceStatus; currency: string; unitIds: string[]; subtotalMinor: number; taxMinor: number; totalMinor: number; previousBalanceMinor: number; amountDueMinor: number; reserveFundBuildingBalanceMinor: number; issuedAt: string | null; dueAt: string | null; publishedAt: string | null; period: string; contact: { id: string; firstName: string; lastName: string; address?: string | null }; building: { id: string; name: string; address?: string; city?: string }; lines?: InvoiceLine[] }
```

`apps/web/src/pages/ServicesPage.vue`:
```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { PricingModel, Service, TaxRate, UnitKind } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import ModalDialog from '@/components/ModalDialog.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { swallow, useResource } from '@/composables/useResource';
import { formatMoney, percentFromBp, toMinor } from '@/utils/money';

const { t } = useI18n();
const res = useResource<Service>('/api/services');
const taxRates = ref<TaxRate[]>([]);
const open = ref(false);
const kinds: UnitKind[] = ['apartment', 'commercial', 'parking', 'storage', 'other'];
const pricings: PricingModel[] = ['fixed_per_unit', 'per_m2', 'shared_total'];
const blank = () => ({ name: '', category: '', pricing: 'fixed_per_unit' as PricingModel, price: '', taxRateId: null as string | null, recurring: 'true', appliesTo: [] as UnitKind[] });
const form = ref(blank());
const formError = ref('');
onMounted(async () => { await res.load(); taxRates.value = (await api.get<{ rows: TaxRate[] }>('/api/tax-rates')).rows; form.value.taxRateId = taxRates.value.find((r) => r.isDefault)?.id ?? null; });
function toggleKind(k: UnitKind) { const i = form.value.appliesTo.indexOf(k); if (i >= 0) form.value.appliesTo.splice(i, 1); else form.value.appliesTo.push(k); }
async function submit() {
  formError.value = '';
  const price = toMinor(form.value.price);
  if (price === null) { formError.value = t('auth.errors.validation'); return; }
  try {
    await res.create({ name: form.value.name, category: form.value.category || null, pricing: form.value.pricing, defaultPriceMinor: price, taxRateId: form.value.taxRateId, recurring: form.value.recurring === 'true', appliesTo: form.value.appliesTo });
    open.value = false; form.value = blank();
  } catch { formError.value = t('auth.errors.validation'); }
}
</script>
<template>
  <div class="mb-4 flex items-center justify-between"><h1 class="text-2xl font-semibold">{{ t('services.title') }}</h1><AppButton data-test="add" @click="open = true">{{ t('services.add') }}</AppButton></div>
  <p v-if="res.error.value" class="mb-2 text-sm text-red-600" data-test="page-error">{{ t('app.error') }}</p>
  <DataTable :columns="[{ key: 'name', label: t('services.name') }, { key: 'pricing', label: t('services.pricing') }, { key: 'defaultPriceMinor', label: t('services.defaultPrice') }, { key: 'taxRateBp', label: t('services.taxRate') }, { key: 'recurring', label: t('services.recurring') }, { key: 'appliesTo', label: t('services.appliesTo') }]" :rows="res.rows.value">
    <template #cell-pricing="{ row }">{{ t(`services.pricingOptions.${row.pricing}`) }}</template>
    <template #cell-defaultPriceMinor="{ row }">{{ formatMoney(row.defaultPriceMinor) }}</template>
    <template #cell-taxRateBp="{ row }">{{ percentFromBp(row.taxRateBp) }}</template>
    <template #cell-recurring="{ row }">{{ row.recurring ? t('services.recurring') : t('services.oneTime') }}</template>
    <template #cell-appliesTo="{ row }">{{ row.appliesTo.length ? row.appliesTo.map((k) => t(`units.kinds.${k}`)).join(', ') : t('services.allKinds') }}</template>
    <template #actions="{ row }"><AppButton variant="danger" @click="swallow(res.remove(row.id))">{{ t('app.delete') }}</AppButton></template>
  </DataTable>
  <ModalDialog :open="open" :title="t('services.add')" @close="open = false">
    <form class="grid grid-cols-2 gap-3" @submit.prevent="submit">
      <AppInput v-model="form.name" :label="t('services.name')" data-test="service-name" class="col-span-2" />
      <AppInput v-model="form.category" :label="t('services.category')" />
      <AppSelect v-model="form.pricing" :label="t('services.pricing')" :options="pricings.map((p) => ({ value: p, label: t(`services.pricingOptions.${p}`) }))" data-test="service-pricing" />
      <AppInput v-model="form.price" :label="t('services.defaultPrice')" data-test="service-price" placeholder="300,00" />
      <AppSelect v-model="form.taxRateId" :label="t('services.taxRate')" :options="[{ value: null, label: t('services.noTax') }, ...taxRates.map((r) => ({ value: r.id, label: `${r.name} (${percentFromBp(r.rateBp)})` }))]" data-test="service-tax" />
      <AppSelect v-model="form.recurring" :label="t('services.recurring')" :options="[{ value: 'true', label: t('services.recurring') }, { value: 'false', label: t('services.oneTime') }]" />
      <fieldset class="col-span-2 text-sm"><legend class="mb-1 font-medium text-slate-700">{{ t('services.appliesTo') }}</legend>
        <label v-for="k in kinds" :key="k" class="mr-3 inline-flex items-center gap-1"><input type="checkbox" :checked="form.appliesTo.includes(k)" :data-test="`kind-${k}`" @change="toggleKind(k)" /> {{ t(`units.kinds.${k}`) }}</label>
        <p class="mt-1 text-xs text-slate-500">{{ t('services.allKinds') }}</p></fieldset>
      <p v-if="formError" class="col-span-2 text-sm text-red-600" data-test="error">{{ formError }}</p>
      <div class="col-span-2 flex justify-end gap-2"><AppButton variant="secondary" @click="open = false">{{ t('app.cancel') }}</AppButton><AppButton type="submit" data-test="submit">{{ t('app.create') }}</AppButton></div>
    </form>
  </ModalDialog>
</template>
```

Router: add `{ path: 'services', component: () => import('@/pages/ServicesPage.vue') }`, `{ path: 'invoices', component: () => import('@/pages/InvoicesPage.vue') }`, `{ path: 'invoices/:id', component: () => import('@/pages/InvoicePage.vue'), props: true }`, `{ path: 'buildings/:id/periods/:periodId', component: () => import('@/pages/PeriodPage.vue'), props: true }` under `/app`; create placeholder `InvoicesPage.vue`, `InvoicePage.vue`, `PeriodPage.vue` (`<template><div /></template>`). AppShell nav: insert `{ to: '/app/services', key: 'nav.services' }` after buildings and `{ to: '/app/invoices', key: 'nav.invoices' }` after contacts (test ids derive automatically: `nav-services`, `nav-invoices`).

- [ ] **Step 4: Run tests, typecheck, build**

Run: `pnpm --filter @domar/web test && pnpm --filter @domar/web typecheck && pnpm --filter @domar/web build && pnpm lint`
Expected: PASS (+3 tests; i18n parity test still green).

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): services page, billing types, money utils and billing i18n"
```

---

### Task 10: Web — building tabs: recurring services, reserve fund, periods

**Files:**
- Create: `apps/web/src/components/building/BuildingServicesTab.vue`, `apps/web/src/components/building/ReserveFundTab.vue`, `apps/web/src/components/building/PeriodsTab.vue`
- Modify: `apps/web/src/pages/BuildingDetailPage.vue` (tabs: units | services | reserve-fund | periods, selected via `?tab=`; default `units`)
- Create: `apps/web/test/PeriodsTab.test.ts`

**Interfaces:**
- `BuildingServicesTab` props `buildingId`; lists `/api/buildings/:id/services`, attach modal (service select from `/api/services?recurring=true`, startsPeriod default current month `YYYY-MM`, frequency, intervalMonths, optional price override), detach button.
- `ReserveFundTab` props `buildingId`; shows state (balance, billed, setting form with basis/amount/appliesTo/active → `PUT`), opening balance form (`POST /opening-balance`), expenses table (`GET /expenses`, add modal → `POST /expenses` with `fund: 'reserve'`, void button with prompt for reason), transactions table.
- `PeriodsTab` props `buildingId`; lists periods (period, status badge, invoiceCount, total), create form (period input `type="month"` → `YYYY-MM`, management fee amount, fee tax rate select), each row links to `/app/buildings/:id/periods/:periodId` with `data-test="period-link"`.
- Test ids: `tab-services`, `tab-reserve-fund`, `tab-periods`, `attach-service`, `attach-service-select`, `attach-submit`, `rf-amount`, `rf-active`, `rf-save`, `period-month`, `period-fee`, `period-create`, `period-link`.

- [ ] **Step 1: Write the failing test**

`apps/web/test/PeriodsTab.test.ts`:
```ts
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import PeriodsTab from '@/components/building/PeriodsTab.vue';
import { i18n } from '@/i18n';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

describe('PeriodsTab', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('lists periods with status and posts a new period with fee in minor units', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ rows: [{ id: 'p1', period: '2026-09', status: 'published', invoiceCount: 3, totalMinor: 1064532, currency: 'MKD' }] }))
      .mockResolvedValueOnce(json({ rows: [{ id: 'tr', name: 'ДДВ 18%', rateBp: 1800, isDefault: true, isActive: true }] }))
      .mockResolvedValueOnce(json({ id: 'p2', period: '2026-10', status: 'open', invoiceCount: 0, totalMinor: 0, lines: [] }, 201))
      .mockResolvedValueOnce(json({ rows: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div/>' } }] });
    const w = mount(PeriodsTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n, router] } });
    await vi.waitFor(() => expect(w.text()).toContain('2026-09'));
    expect(w.text()).toContain(i18n.global.t('periods.status.published'));
    expect(w.text()).toContain('10.645,32 ден.');
    await w.get('[data-test=period-month]').setValue('2026-10');
    await w.get('[data-test=period-fee]').setValue('150');
    await w.get('form').trigger('submit');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const [url, init] = fetchMock.mock.calls[2] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/api/buildings/b1/periods');
    expect(JSON.parse(String(init.body))).toEqual({ period: '2026-10', managementFeeMinor: 15000, managementFeeTaxRateId: 'tr' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @domar/web test -- PeriodsTab`
Expected: FAIL, component missing.

- [ ] **Step 3: Implement**

`apps/web/src/components/building/PeriodsTab.vue`:
```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { Period, TaxRate } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { useResource } from '@/composables/useResource';
import { formatMoney, percentFromBp, toMinor } from '@/utils/money';

const props = defineProps<{ buildingId: string }>();
const { t } = useI18n();
const res = useResource<Period>(`/api/buildings/${props.buildingId}/periods`);
const taxRates = ref<TaxRate[]>([]);
const now = new Date();
const month = ref(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
const fee = ref('');
const feeTax = ref<string | null>(null);
const error = ref('');
onMounted(async () => {
  await res.load();
  taxRates.value = (await api.get<{ rows: TaxRate[] }>('/api/tax-rates')).rows;
  feeTax.value = taxRates.value.find((r) => r.isDefault)?.id ?? null;
});
async function create() {
  error.value = '';
  const feeMinor = fee.value.trim() === '' ? 0 : toMinor(fee.value);
  if (feeMinor === null) { error.value = t('auth.errors.validation'); return; }
  try { await res.create({ period: month.value, managementFeeMinor: feeMinor, managementFeeTaxRateId: feeTax.value }); fee.value = ''; }
  catch (e) { error.value = (e as { code?: string }).code === 'period_exists' ? t('periods.exists') : t('app.error'); }
}
</script>
<template>
  <form class="mb-4 grid grid-cols-4 items-end gap-3 rounded-xl bg-white p-4 shadow-sm" @submit.prevent="create">
    <AppInput v-model="month" :label="t('billing.period')" type="month" data-test="period-month" />
    <AppInput v-model="fee" :label="t('periods.managementFee')" data-test="period-fee" placeholder="150,00" />
    <AppSelect v-model="feeTax" :label="t('periods.managementFeeTax')" :options="[{ value: null, label: t('services.noTax') }, ...taxRates.map((r) => ({ value: r.id, label: `${r.name} (${percentFromBp(r.rateBp)})` }))]" />
    <AppButton type="submit" data-test="period-create">{{ t('periods.create') }}</AppButton>
    <p v-if="error" class="col-span-4 text-sm text-red-600" data-test="error">{{ error }}</p>
  </form>
  <p v-if="res.error.value" class="mb-2 text-sm text-red-600" data-test="page-error">{{ t('app.error') }}</p>
  <DataTable :columns="[{ key: 'period', label: t('billing.period') }, { key: 'status', label: t('billing.status') }, { key: 'invoiceCount', label: t('periods.invoices') }, { key: 'totalMinor', label: t('billing.total') }]" :rows="res.rows.value">
    <template #cell-period="{ row }"><RouterLink :to="`/app/buildings/${buildingId}/periods/${row.id}`" class="text-emerald-700 underline" data-test="period-link">{{ row.period }}</RouterLink></template>
    <template #cell-status="{ row }"><span class="rounded-full px-2 py-0.5 text-xs" :class="{ 'bg-slate-100': row.status === 'open', 'bg-amber-100 text-amber-800': row.status === 'generated', 'bg-emerald-100 text-emerald-800': row.status === 'published' }">{{ t(`periods.status.${row.status}`) }}</span></template>
    <template #cell-totalMinor="{ row }">{{ formatMoney(row.totalMinor) }}</template>
  </DataTable>
</template>
```
Add i18n key `periods.exists` 'Периодот веќе постои.' / 'Period already exists.' to both locales.

`apps/web/src/components/building/BuildingServicesTab.vue`:
```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { BuildingService, Service } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import ModalDialog from '@/components/ModalDialog.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { swallow, useResource } from '@/composables/useResource';
import { formatMoney, percentFromBp, toMinor } from '@/utils/money';

const props = defineProps<{ buildingId: string }>();
const { t } = useI18n();
const res = useResource<BuildingService>(`/api/buildings/${props.buildingId}/services`);
const catalog = ref<Service[]>([]);
const open = ref(false);
const now = new Date();
const form = ref({ serviceId: null as string | null, startsPeriod: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`, frequency: 'monthly' as 'monthly' | 'every_n_months', intervalMonths: '3', price: '' });
const error = ref('');
onMounted(async () => { await res.load(); catalog.value = (await api.get<{ rows: Service[] }>('/api/services', { recurring: 'true' })).rows; });
async function submit() {
  error.value = '';
  const price = form.value.price.trim() === '' ? null : toMinor(form.value.price);
  if (!form.value.serviceId || price === undefined) { error.value = t('auth.errors.validation'); return; }
  try {
    await res.create({ serviceId: form.value.serviceId, startsPeriod: form.value.startsPeriod, frequency: form.value.frequency, intervalMonths: form.value.frequency === 'monthly' ? 1 : Number(form.value.intervalMonths), priceMinor: price });
    open.value = false;
  } catch (e) { error.value = (e as { code?: string }).code === 'already_attached' ? t('buildingServices.alreadyAttached') : t('auth.errors.validation'); }
}
</script>
<template>
  <div class="mb-3 flex items-center justify-between"><h2 class="text-lg font-semibold">{{ t('buildingServices.title') }}</h2><AppButton data-test="attach-service" @click="open = true">{{ t('buildingServices.attach') }}</AppButton></div>
  <p v-if="res.error.value" class="mb-2 text-sm text-red-600" data-test="page-error">{{ t('app.error') }}</p>
  <DataTable :columns="[{ key: 'service', label: t('services.name') }, { key: 'effectivePricing', label: t('services.pricing') }, { key: 'effectivePriceMinor', label: t('billing.unitPrice') }, { key: 'frequency', label: t('buildingServices.frequency') }, { key: 'startsPeriod', label: t('buildingServices.startsPeriod') }]" :rows="res.rows.value">
    <template #cell-service="{ row }">{{ row.service.name }} <span class="text-slate-500">({{ percentFromBp(row.service.taxRateBp) }})</span></template>
    <template #cell-effectivePricing="{ row }">{{ t(`services.pricingOptions.${row.effectivePricing}`) }}</template>
    <template #cell-effectivePriceMinor="{ row }">{{ formatMoney(row.effectivePriceMinor) }}</template>
    <template #cell-frequency="{ row }">{{ row.frequency === 'monthly' ? t('buildingServices.monthly') : `${t('buildingServices.everyN')}: ${row.intervalMonths}` }}</template>
    <template #actions="{ row }"><AppButton variant="danger" @click="swallow(res.remove(row.id))">{{ t('buildingServices.detach') }}</AppButton></template>
  </DataTable>
  <ModalDialog :open="open" :title="t('buildingServices.attach')" @close="open = false">
    <form class="grid grid-cols-2 gap-3" @submit.prevent="submit">
      <AppSelect v-model="form.serviceId" :label="t('services.name')" :options="[{ value: null, label: '—' }, ...catalog.map((s) => ({ value: s.id, label: `${s.name} · ${formatMoney(s.defaultPriceMinor)}` }))]" data-test="attach-service-select" class="col-span-2" />
      <AppInput v-model="form.startsPeriod" :label="t('buildingServices.startsPeriod')" type="month" data-test="attach-starts" />
      <AppSelect v-model="form.frequency" :label="t('buildingServices.frequency')" :options="[{ value: 'monthly', label: t('buildingServices.monthly') }, { value: 'every_n_months', label: t('buildingServices.everyN') }]" />
      <AppInput v-if="form.frequency === 'every_n_months'" v-model="form.intervalMonths" :label="t('buildingServices.intervalMonths')" type="number" />
      <AppInput v-model="form.price" :label="t('buildingServices.overridePrice')" placeholder="—" />
      <p v-if="error" class="col-span-2 text-sm text-red-600" data-test="error">{{ error }}</p>
      <div class="col-span-2 flex justify-end gap-2"><AppButton variant="secondary" @click="open = false">{{ t('app.cancel') }}</AppButton><AppButton type="submit" data-test="attach-submit">{{ t('app.save') }}</AppButton></div>
    </form>
  </ModalDialog>
</template>
```
Add i18n `buildingServices.alreadyAttached` 'Услугата е веќе додадена на зградата.' / 'This service is already attached.'.

`apps/web/src/components/building/ReserveFundTab.vue`:
```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { Expense, FundTransaction, ReserveFundState, UnitKind } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { formatMoney, toMinor } from '@/utils/money';

const props = defineProps<{ buildingId: string }>();
const { t } = useI18n();
const base = `/api/buildings/${props.buildingId}/reserve-fund`;
const state = ref<ReserveFundState | null>(null);
const expenses = ref<Expense[]>([]);
const transactions = ref<FundTransaction[]>([]);
const kinds: UnitKind[] = ['apartment', 'commercial', 'parking', 'storage', 'other'];
const form = ref({ basis: 'per_unit' as 'per_unit' | 'per_m2', amount: '', appliesTo: [] as UnitKind[], active: false });
const opening = ref('');
const expense = ref({ description: '', supplierText: '', amount: '', paidAt: new Date().toISOString().slice(0, 10) });
const error = ref('');
async function load() {
  state.value = await api.get<ReserveFundState>(base);
  expenses.value = (await api.get<{ rows: Expense[] }>(`${base}/expenses`)).rows;
  transactions.value = (await api.get<{ rows: FundTransaction[] }>(`${base}/transactions`)).rows;
  const s = state.value.setting;
  if (s) form.value = { basis: s.basis, amount: (s.amountMinor / 100).toFixed(2).replace('.', ','), appliesTo: [...s.appliesTo], active: s.active };
}
onMounted(load);
function toggleKind(k: UnitKind) { const i = form.value.appliesTo.indexOf(k); if (i >= 0) form.value.appliesTo.splice(i, 1); else form.value.appliesTo.push(k); }
async function saveSetting() {
  error.value = '';
  const amountMinor = toMinor(form.value.amount);
  if (amountMinor === null) { error.value = t('auth.errors.validation'); return; }
  try { await api.put(base, { basis: form.value.basis, amountMinor, appliesTo: form.value.appliesTo, active: form.value.active }); await load(); } catch { error.value = t('app.error'); }
}
async function addOpening() {
  const amountMinor = toMinor(opening.value);
  if (amountMinor === null) { error.value = t('auth.errors.validation'); return; }
  try { await api.post(`${base}/opening-balance`, { amountMinor }); opening.value = ''; await load(); } catch { error.value = t('app.error'); }
}
async function addExpense() {
  const amountMinor = toMinor(expense.value.amount);
  if (amountMinor === null || !expense.value.description) { error.value = t('auth.errors.validation'); return; }
  try {
    await api.post(`${base}/expenses`, { fund: 'reserve', description: expense.value.description, supplierText: expense.value.supplierText || null, amountMinor, paidAt: new Date(expense.value.paidAt).toISOString() });
    expense.value = { description: '', supplierText: '', amount: '', paidAt: new Date().toISOString().slice(0, 10) }; await load();
  } catch { error.value = t('app.error'); }
}
async function voidExpense(id: string) {
  const reason = window.prompt(t('reserveFund.voidReason'));
  if (!reason) return;
  try { await api.post(`${base}/expenses/${id}/void`, { reason }); await load(); } catch { error.value = t('app.error'); }
}
</script>
<template>
  <div v-if="state" class="space-y-6">
    <div class="grid grid-cols-2 gap-4">
      <div class="rounded-xl bg-white p-4 shadow-sm"><div class="text-sm text-slate-500">{{ t('reserveFund.balance') }}</div><div class="text-2xl font-semibold" data-test="rf-balance">{{ formatMoney(state.balanceMinor) }}</div></div>
      <div class="rounded-xl bg-white p-4 shadow-sm"><div class="text-sm text-slate-500">{{ t('reserveFund.billed') }}</div><div class="text-2xl font-semibold">{{ formatMoney(state.contributionsBilledMinor) }}</div></div>
    </div>
    <p v-if="error" class="text-sm text-red-600" data-test="error">{{ error }}</p>
    <form class="grid grid-cols-4 items-end gap-3 rounded-xl bg-white p-4 shadow-sm" @submit.prevent="saveSetting">
      <AppSelect v-model="form.basis" :label="t('reserveFund.basis')" :options="[{ value: 'per_unit', label: t('reserveFund.perUnit') }, { value: 'per_m2', label: t('reserveFund.perM2') }]" data-test="rf-basis" />
      <AppInput v-model="form.amount" :label="t('billing.amount')" data-test="rf-amount" placeholder="10,00" />
      <label class="text-sm"><input v-model="form.active" type="checkbox" data-test="rf-active" /> {{ t('reserveFund.active') }}</label>
      <AppButton type="submit" data-test="rf-save">{{ t('app.save') }}</AppButton>
      <fieldset class="col-span-4 text-sm"><legend class="mb-1 font-medium text-slate-700">{{ t('services.appliesTo') }}</legend>
        <label v-for="k in kinds" :key="k" class="mr-3 inline-flex items-center gap-1"><input type="checkbox" :checked="form.appliesTo.includes(k)" :data-test="`rf-kind-${k}`" @change="toggleKind(k)" /> {{ t(`units.kinds.${k}`) }}</label></fieldset>
    </form>
    <form class="flex items-end gap-3 rounded-xl bg-white p-4 shadow-sm" @submit.prevent="addOpening">
      <AppInput v-model="opening" :label="t('reserveFund.openingBalance')" data-test="rf-opening" placeholder="35.000,00" class="flex-1" />
      <AppButton type="submit" variant="secondary" data-test="rf-opening-submit">{{ t('reserveFund.addOpening') }}</AppButton>
    </form>
    <div>
      <h3 class="mb-2 font-semibold">{{ t('reserveFund.expenses') }}</h3>
      <form class="mb-3 grid grid-cols-5 items-end gap-3" @submit.prevent="addExpense">
        <AppInput v-model="expense.description" :label="t('billing.description')" data-test="exp-description" class="col-span-2" />
        <AppInput v-model="expense.supplierText" :label="t('reserveFund.supplier')" />
        <AppInput v-model="expense.amount" :label="t('billing.amount')" data-test="exp-amount" />
        <div class="flex items-end gap-2"><AppInput v-model="expense.paidAt" :label="t('reserveFund.paidAt')" type="date" /><AppButton type="submit" variant="secondary" data-test="exp-submit">{{ t('reserveFund.addExpense') }}</AppButton></div>
      </form>
      <DataTable :columns="[{ key: 'paidAt', label: t('reserveFund.paidAt') }, { key: 'description', label: t('billing.description') }, { key: 'supplierText', label: t('reserveFund.supplier') }, { key: 'amountMinor', label: t('billing.amount') }]" :rows="expenses">
        <template #cell-paidAt="{ row }">{{ new Date(row.paidAt).toLocaleDateString('mk-MK') }}</template>
        <template #cell-amountMinor="{ row }"><span :class="{ 'line-through text-slate-400': row.voidedAt }">{{ formatMoney(row.amountMinor) }}</span> <span v-if="row.voidedAt" class="text-xs text-slate-500">({{ t('reserveFund.voided') }})</span></template>
        <template #actions="{ row }"><AppButton v-if="!row.voidedAt" variant="danger" @click="voidExpense(row.id)">{{ t('reserveFund.void') }}</AppButton></template>
      </DataTable>
    </div>
    <div>
      <h3 class="mb-2 font-semibold">{{ t('reserveFund.transactions') }}</h3>
      <DataTable :columns="[{ key: 'bookedAt', label: t('reserveFund.paidAt') }, { key: 'kind', label: t('billing.description') }, { key: 'description', label: '' }, { key: 'amountMinor', label: t('billing.amount') }]" :rows="transactions">
        <template #cell-bookedAt="{ row }">{{ new Date(row.bookedAt).toLocaleDateString('mk-MK') }}</template>
        <template #cell-kind="{ row }">{{ t(`reserveFund.kind.${row.kind}`) }}</template>
        <template #cell-amountMinor="{ row }">{{ formatMoney(row.amountMinor) }}</template>
      </DataTable>
    </div>
  </div>
</template>
```
Add `api.put` to `apps/web/src/api/client.ts` (`put: <T>(path, body) => request<T>('PUT', path, body)`). Add i18n keys: `reserveFund.voidReason` 'Причина за поништување', `reserveFund.kind.opening` 'Почетно салдо', `reserveFund.kind.expense` 'Трошок', `reserveFund.kind.adjustment` 'Корекција', `reserveFund.kind.payment` 'Уплата', `reserveFund.kind.charge` 'Задолжување' (en mirrors).

`apps/web/src/pages/BuildingDetailPage.vue` — wrap the existing units section in a tab switcher:
```vue
<!-- add to <script setup>: -->
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BuildingServicesTab from '@/components/building/BuildingServicesTab.vue';
import PeriodsTab from '@/components/building/PeriodsTab.vue';
import ReserveFundTab from '@/components/building/ReserveFundTab.vue';
const route = useRoute(); const router = useRouter();
const tabs = ['units', 'services', 'reserve-fund', 'periods'] as const;
const tab = computed(() => (tabs.includes(route.query.tab as never) ? (route.query.tab as (typeof tabs)[number]) : 'units'));
const tabLabel = (k: string) => ({ units: t('units.title'), services: t('buildingServices.title'), 'reserve-fund': t('reserveFund.title'), periods: t('periods.title') })[k];
<!-- template: after the address <p>, insert: -->
<nav class="mb-4 flex gap-2 border-b border-slate-200">
  <button v-for="k in tabs" :key="k" class="-mb-px border-b-2 px-3 py-2 text-sm" :class="tab === k ? 'border-emerald-600 font-medium text-emerald-800' : 'border-transparent text-slate-600'" :data-test="`tab-${k}`" @click="router.replace({ query: { ...route.query, tab: k } })">{{ tabLabel(k) }}</button>
</nav>
<!-- wrap the existing units block in <div v-if="tab === 'units'"> … </div> and add: -->
<BuildingServicesTab v-else-if="tab === 'services'" :building-id="id" />
<ReserveFundTab v-else-if="tab === 'reserve-fund'" :building-id="id" />
<PeriodsTab v-else :building-id="id" />
```

- [ ] **Step 4: Run tests, typecheck, build**

Run: `pnpm --filter @domar/web test && pnpm --filter @domar/web typecheck && pnpm --filter @domar/web build && pnpm lint`
Expected: PASS (+1 test); i18n parity green.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): building tabs for recurring services, reserve fund and periods"
```

---

### Task 11: Web — period page, invoices list and invoice page

**Files:**
- Create (replace placeholders): `apps/web/src/pages/PeriodPage.vue`, `apps/web/src/pages/InvoicesPage.vue`, `apps/web/src/pages/InvoicePage.vue`
- Create: `apps/web/src/components/billing/PeriodLineForm.vue`, `apps/web/test/PeriodLineForm.test.ts`

**Interfaces:**
- `PeriodPage` props `id` (building), `periodId`: loads `GET /api/buildings/:id/periods/:periodId`; header (period, status badge, fee, numbering with inline edit when not published), warnings list (i18n `periods.warning.<code>` with `{unit}` = unit label looked up from `/api/buildings/:id/units`), lines table (description, pricing, quantity, unit price, tax, fund, source badge Авто/Рачно, actions edit/delete when editable), add-line modal (`PeriodLineForm`), buttons: refresh auto lines (`POST .../refresh-lines`), generate/regenerate (`POST .../generate`), delete drafts (`DELETE .../drafts`), publish (confirm dialog `periods.publishConfirm`, `POST .../publish`), and an invoices table for the period (`GET /api/invoices?buildingId&period`) with links to `/app/invoices/:id` (`data-test="invoice-link"`). Test ids: `add-line`, `line-submit`, `refresh-lines`, `generate`, `publish`, `delete-drafts`, `invoice-link`, `period-status`.
- `PeriodLineForm` props `services: Service[]`, `taxRates: TaxRate[]`, `initial?: PeriodLine`, `requireNote: boolean`; emits `submit(payload)` where payload is the API `lineCreate`/`linePatch` body (`serviceId?`, `description`, `pricing`, `quantity`, `unitPriceMinor`, `taxRateId`, `appliesTo`, `fund`, `note?`); choosing a service prefills description/pricing/price/appliesTo; test ids `line-service`, `line-description`, `line-pricing`, `line-quantity`, `line-price`, `line-tax`, `line-fund`, `line-note`, `line-submit`.
- `InvoicesPage`: filters (building select, period `type=month`, status select) → `GET /api/invoices`, table (number or Нацрт, period, building, owner, total, due, status), row link `data-test="invoice-link"`.
- `InvoicePage` props `id`: `GET /api/invoices/:id`; renders the Art. 33 layout in-app (header, parties, grouped lines with building-wide and owner columns, totals, previous balance, amount due, reserve fund building balance), buttons `invoices.openHtml` (`<a target=_blank :href="\`${API}/api/invoices/${id}/html\`">`), `invoices.downloadPdf` (`/pdf`), delete draft (when draft). Test ids: `invoice-number`, `invoice-total`, `invoice-due`, `open-html`.

- [ ] **Step 1: Write the failing test**

`apps/web/test/PeriodLineForm.test.ts`:
```ts
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { Service, TaxRate } from '@/api/types';
import PeriodLineForm from '@/components/billing/PeriodLineForm.vue';
import { i18n } from '@/i18n';

const services: Service[] = [{ id: 's1', name: 'Лифт', category: null, description: null, pricing: 'shared_total', defaultPriceMinor: 600000, taxRateId: 'tr', taxRateBp: 1800, appliesTo: [], recurring: true, isActive: true }];
const taxRates: TaxRate[] = [{ id: 'tr', name: 'ДДВ 18%', rateBp: 1800, isDefault: true, isActive: true }];

describe('PeriodLineForm', () => {
  it('prefills from a service and emits the API body with minor units', async () => {
    const w = mount(PeriodLineForm, { props: { services, taxRates, requireNote: false }, global: { plugins: [i18n] } });
    await w.get('[data-test=line-service]').setValue('s1');
    expect((w.get('[data-test=line-description]').element as HTMLInputElement).value).toBe('Лифт');
    expect((w.get('[data-test=line-price]').element as HTMLInputElement).value).toBe('6000,00');
    await w.get('[data-test=line-quantity]').setValue('0,5');
    await w.get('form').trigger('submit');
    expect(w.emitted('submit')![0]![0]).toEqual({ serviceId: 's1', description: 'Лифт', pricing: 'shared_total', quantity: 0.5, unitPriceMinor: 600000, taxRateId: 'tr', appliesTo: [], fund: 'regular' });
  });
  it('requires a note when editing an auto line', async () => {
    const w = mount(PeriodLineForm, { props: { services, taxRates, requireNote: true, initial: { id: 'l1', serviceId: 's1', description: 'Лифт', pricing: 'shared_total', quantity: 1, unitPriceMinor: 600000, taxRateBp: 1800, appliesTo: [], fund: 'regular', source: 'auto', note: null, sortOrder: 0 } }, global: { plugins: [i18n] } });
    await w.get('form').trigger('submit');
    expect(w.emitted('submit')).toBeUndefined();
    expect(w.text()).toContain(i18n.global.t('periods.noteRequired'));
    await w.get('[data-test=line-note]').setValue('попуст');
    await w.get('form').trigger('submit');
    expect(w.emitted('submit')![0]![0]).toMatchObject({ note: 'попуст', unitPriceMinor: 600000 });
  });
});
```
Add i18n `periods.noteRequired` 'Внесете забелешка за измена на авто ставка.' / 'Enter a note to edit an automatic line.'.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @domar/web test -- PeriodLineForm`
Expected: FAIL, component missing.

- [ ] **Step 3: Implement**

`apps/web/src/components/billing/PeriodLineForm.vue`:
```vue
<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Fund, PeriodLine, PricingModel, Service, TaxRate, UnitKind } from '@/api/types';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { percentFromBp, toMinor } from '@/utils/money';

export interface LinePayload { serviceId?: string; description: string; pricing: PricingModel; quantity: number; unitPriceMinor: number; taxRateId: string | null; appliesTo: UnitKind[]; fund: Fund; note?: string }
const props = defineProps<{ services: Service[]; taxRates: TaxRate[]; initial?: PeriodLine | undefined; requireNote: boolean }>();
const emit = defineEmits<{ submit: [payload: LinePayload] }>();
const { t } = useI18n();
const fmt = (minor: number) => (minor / 100).toFixed(2).replace('.', ',');
const kinds: UnitKind[] = ['apartment', 'commercial', 'parking', 'storage', 'other'];
const serviceId = ref<string | null>(props.initial?.serviceId ?? null);
const description = ref(props.initial?.description ?? '');
const pricing = ref<PricingModel>(props.initial?.pricing ?? 'fixed_per_unit');
const quantity = ref(props.initial ? String(props.initial.quantity).replace('.', ',') : '1');
const price = ref(props.initial ? fmt(props.initial.unitPriceMinor) : '');
const taxRateId = ref<string | null>(props.initial ? (props.taxRates.find((r) => r.rateBp === props.initial!.taxRateBp)?.id ?? null) : (props.taxRates.find((r) => r.isDefault)?.id ?? null));
const appliesTo = ref<UnitKind[]>([...(props.initial?.appliesTo ?? [])]);
const fund = ref<Fund>(props.initial?.fund ?? 'regular');
const note = ref(props.initial?.note ?? '');
const error = ref('');
watch(serviceId, (id) => {
  const s = props.services.find((x) => x.id === id);
  if (!s) return;
  description.value = s.name; pricing.value = s.pricing; price.value = fmt(s.defaultPriceMinor); appliesTo.value = [...s.appliesTo];
  taxRateId.value = s.taxRateId ?? null;
});
function toggleKind(k: UnitKind) { const i = appliesTo.value.indexOf(k); if (i >= 0) appliesTo.value.splice(i, 1); else appliesTo.value.push(k); }
function submit() {
  error.value = '';
  if (props.requireNote && !note.value.trim()) { error.value = t('periods.noteRequired'); return; }
  const unitPriceMinor = toMinor(price.value); const q = Number(quantity.value.replace(',', '.'));
  if (!description.value.trim() || unitPriceMinor === null || !Number.isFinite(q) || q <= 0) { error.value = t('auth.errors.validation'); return; }
  const payload: LinePayload = { description: description.value.trim(), pricing: pricing.value, quantity: q, unitPriceMinor, taxRateId: taxRateId.value, appliesTo: [...appliesTo.value], fund: fund.value };
  if (serviceId.value && !props.initial) payload.serviceId = serviceId.value;
  if (note.value.trim()) payload.note = note.value.trim();
  emit('submit', payload);
}
</script>
<template>
  <form class="grid grid-cols-2 gap-3" @submit.prevent="submit">
    <AppSelect v-if="!initial" v-model="serviceId" :label="t('periods.fromService')" :options="[{ value: null, label: '—' }, ...services.map((s) => ({ value: s.id, label: s.name }))]" data-test="line-service" class="col-span-2" />
    <AppInput v-model="description" :label="t('billing.description')" data-test="line-description" class="col-span-2" />
    <AppSelect v-model="pricing" :label="t('services.pricing')" :options="(['fixed_per_unit', 'per_m2', 'shared_total'] as PricingModel[]).map((p) => ({ value: p, label: t(`services.pricingOptions.${p}`) }))" data-test="line-pricing" />
    <AppInput v-model="quantity" :label="t('billing.quantity')" data-test="line-quantity" />
    <AppInput v-model="price" :label="t('billing.unitPrice')" data-test="line-price" />
    <AppSelect v-model="taxRateId" :label="t('services.taxRate')" :options="[{ value: null, label: t('services.noTax') }, ...taxRates.map((r) => ({ value: r.id, label: `${r.name} (${percentFromBp(r.rateBp)})` }))]" data-test="line-tax" />
    <AppSelect v-model="fund" :label="t('billing.fund')" :options="[{ value: 'regular', label: t('billing.regular') }, { value: 'reserve', label: t('billing.reserve') }]" data-test="line-fund" />
    <fieldset class="col-span-2 text-sm"><legend class="mb-1 font-medium text-slate-700">{{ t('services.appliesTo') }}</legend>
      <label v-for="k in kinds" :key="k" class="mr-3 inline-flex items-center gap-1"><input type="checkbox" :checked="appliesTo.includes(k)" @change="toggleKind(k)" /> {{ t(`units.kinds.${k}`) }}</label></fieldset>
    <AppInput v-model="note" :label="t('periods.note')" data-test="line-note" class="col-span-2" />
    <p v-if="error" class="col-span-2 text-sm text-red-600" data-test="error">{{ error }}</p>
    <div class="col-span-2 flex justify-end"><AppButton type="submit" data-test="line-submit">{{ t('app.save') }}</AppButton></div>
  </form>
</template>
```

`apps/web/src/pages/PeriodPage.vue`:
```vue
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { Invoice, Period, PeriodLine, Service, TaxRate, Unit } from '@/api/types';
import PeriodLineForm, { type LinePayload } from '@/components/billing/PeriodLineForm.vue';
import DataTable from '@/components/DataTable.vue';
import ModalDialog from '@/components/ModalDialog.vue';
import AppButton from '@/components/ui/AppButton.vue';
import { formatMoney, percentFromBp } from '@/utils/money';

const props = defineProps<{ id: string; periodId: string }>();
const { t } = useI18n();
const base = `/api/buildings/${props.id}/periods/${props.periodId}`;
const period = ref<Period | null>(null);
const invoices = ref<Invoice[]>([]);
const units = ref<Unit[]>([]);
const services = ref<Service[]>([]);
const taxRates = ref<TaxRate[]>([]);
const open = ref(false); const editing = ref<PeriodLine | null>(null); const busy = ref(false); const error = ref('');
const editable = computed(() => period.value?.status !== 'published');
async function load() {
  period.value = await api.get<Period>(base);
  invoices.value = (await api.get<{ rows: Invoice[] }>('/api/invoices', { buildingId: props.id, period: period.value.period, pageSize: 200 })).rows;
}
onMounted(async () => {
  await load();
  [units.value, services.value, taxRates.value] = await Promise.all([
    api.get<{ rows: Unit[] }>(`/api/buildings/${props.id}/units`).then((r) => r.rows),
    api.get<{ rows: Service[] }>('/api/services').then((r) => r.rows),
    api.get<{ rows: TaxRate[] }>('/api/tax-rates').then((r) => r.rows),
  ]);
});
const unitLabel = (unitId: unknown) => units.value.find((u) => u.id === unitId)?.label ?? String(unitId ?? '');
async function run(fn: () => Promise<unknown>) {
  busy.value = true; error.value = '';
  try { await fn(); await load(); } catch (e) { const code = (e as { code?: string }).code; error.value = code === 'period_locked' ? t('periods.locked') : t('app.error'); } finally { busy.value = false; }
}
function openNew() { editing.value = null; open.value = true; }
function openEdit(l: PeriodLine) { editing.value = l; open.value = true; }
async function onLine(payload: LinePayload) {
  await run(async () => { if (editing.value) await api.patch(`${base}/lines/${editing.value.id}`, payload); else await api.post(`${base}/lines`, payload); });
  if (!error.value) open.value = false;
}
async function publish() { if (window.confirm(t('periods.publishConfirm'))) await run(() => api.post(`${base}/publish`)); }
</script>
<template>
  <div v-if="period">
    <div class="mb-4 flex items-center justify-between">
      <div><RouterLink :to="`/app/buildings/${id}?tab=periods`" class="text-sm text-emerald-700 underline">← {{ t('periods.title') }}</RouterLink>
        <h1 class="text-2xl font-semibold">{{ t('billing.period') }} {{ period.period }} <span class="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-sm" data-test="period-status">{{ t(`periods.status.${period.status}`) }}</span></h1>
        <p class="text-sm text-slate-600">{{ t('periods.managementFee') }}: {{ formatMoney(period.managementFeeMinor) }} ({{ percentFromBp(period.managementFeeTaxRateBp) }}) · {{ t('periods.numbering') }}: {{ period.numberPrefix }}0001{{ period.numberSuffix }}</p></div>
      <div class="flex gap-2">
        <AppButton v-if="editable" variant="secondary" :loading="busy" data-test="refresh-lines" @click="run(() => api.post(`${base}/refresh-lines`))">{{ t('periods.refresh') }}</AppButton>
        <AppButton v-if="editable" :loading="busy" data-test="generate" @click="run(() => api.post(`${base}/generate`))">{{ period.status === 'generated' ? t('periods.regenerate') : t('periods.generate') }}</AppButton>
        <AppButton v-if="period.status === 'generated'" variant="secondary" :loading="busy" data-test="delete-drafts" @click="run(() => api.del(`${base}/drafts`))">{{ t('periods.deleteDrafts') }}</AppButton>
        <AppButton v-if="period.status === 'generated'" :loading="busy" data-test="publish" @click="publish">{{ t('periods.publish') }}</AppButton>
      </div>
    </div>
    <p v-if="error" class="mb-2 text-sm text-red-600" data-test="error">{{ error }}</p>
    <p v-if="!editable" class="mb-2 text-sm text-slate-600">{{ t('periods.locked') }}</p>
    <ul v-if="period.warnings.length" class="mb-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900" data-test="warnings">
      <li v-for="(w, i) in period.warnings" :key="i">{{ t(`periods.warning.${w.code}`, { unit: unitLabel(w.unitId) }) }}</li>
    </ul>
    <div class="mb-2 flex items-center justify-between"><h2 class="text-lg font-semibold">{{ t('periods.lines') }}</h2><AppButton v-if="editable" data-test="add-line" @click="openNew">{{ t('periods.addLine') }}</AppButton></div>
    <DataTable :columns="[{ key: 'description', label: t('billing.description') }, { key: 'pricing', label: t('services.pricing') }, { key: 'quantity', label: t('billing.quantity') }, { key: 'unitPriceMinor', label: t('billing.unitPrice') }, { key: 'taxRateBp', label: t('billing.tax') }, { key: 'fund', label: t('billing.fund') }, { key: 'source', label: '' }]" :rows="period.lines ?? []">
      <template #cell-pricing="{ row }">{{ t(`services.pricingOptions.${row.pricing}`) }}</template>
      <template #cell-unitPriceMinor="{ row }">{{ formatMoney(row.unitPriceMinor) }}</template>
      <template #cell-taxRateBp="{ row }">{{ percentFromBp(row.taxRateBp) }}</template>
      <template #cell-fund="{ row }">{{ t(`billing.${row.fund}`) }}</template>
      <template #cell-source="{ row }"><span class="rounded-full px-2 py-0.5 text-xs" :class="row.source === 'auto' ? 'bg-sky-100 text-sky-800' : 'bg-slate-100'">{{ t(`periods.${row.source}`) }}</span><span v-if="row.note" class="ml-2 text-xs text-slate-500">{{ row.note }}</span></template>
      <template #actions="{ row }"><template v-if="editable"><AppButton variant="secondary" @click="openEdit(row)">{{ t('app.edit') }}</AppButton><AppButton variant="danger" class="ml-2" @click="run(() => api.del(`${base}/lines/${row.id}`))">{{ t('app.delete') }}</AppButton></template></template>
    </DataTable>
    <h2 class="mb-2 mt-6 text-lg font-semibold">{{ t('periods.invoices') }} <span class="text-slate-500">{{ invoices.length }}</span></h2>
    <DataTable :columns="[{ key: 'number', label: t('invoices.number') }, { key: 'contact', label: t('invoices.owner') }, { key: 'totalMinor', label: t('billing.total') }, { key: 'amountDueMinor', label: t('billing.amountDue') }, { key: 'status', label: t('billing.status') }]" :rows="invoices">
      <template #cell-number="{ row }"><RouterLink :to="`/app/invoices/${row.id}`" class="text-emerald-700 underline" data-test="invoice-link">{{ row.number ?? t('invoices.status.draft') }}</RouterLink></template>
      <template #cell-contact="{ row }">{{ row.contact.firstName }} {{ row.contact.lastName }}</template>
      <template #cell-totalMinor="{ row }">{{ formatMoney(row.totalMinor) }}</template>
      <template #cell-amountDueMinor="{ row }">{{ formatMoney(row.amountDueMinor) }}</template>
      <template #cell-status="{ row }">{{ t(`invoices.status.${row.status}`) }}</template>
    </DataTable>
    <ModalDialog :open="open" :title="editing ? t('app.edit') : t('periods.addLine')" @close="open = false">
      <PeriodLineForm :key="editing?.id ?? 'new'" :services="services" :tax-rates="taxRates" :initial="editing ?? undefined" :require-note="editing?.source === 'auto'" @submit="onLine" />
    </ModalDialog>
  </div>
  <p v-else>{{ t('app.loading') }}</p>
</template>
```

`apps/web/src/pages/InvoicesPage.vue`:
```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { Building, Invoice, InvoiceStatus } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { useResource } from '@/composables/useResource';
import { formatMoney } from '@/utils/money';

const { t } = useI18n();
const res = useResource<Invoice>('/api/invoices');
const buildings = ref<Building[]>([]);
const f = ref({ buildingId: null as string | null, period: '', status: null as InvoiceStatus | null });
const statuses: InvoiceStatus[] = ['draft', 'published', 'partially_paid', 'paid', 'cancelled'];
function search() { void res.load({ buildingId: f.value.buildingId ?? undefined, period: f.value.period || undefined, status: f.value.status ?? undefined, pageSize: 200 }); }
onMounted(async () => { search(); buildings.value = (await api.get<{ rows: Building[] }>('/api/buildings')).rows; });
</script>
<template>
  <h1 class="mb-4 text-2xl font-semibold">{{ t('invoices.title') }} <span class="text-base text-slate-500">{{ res.total.value }}</span></h1>
  <form class="mb-3 grid grid-cols-4 items-end gap-3" @submit.prevent="search">
    <AppSelect v-model="f.buildingId" :label="t('invoices.building')" :options="[{ value: null, label: t('buildings.none') }, ...buildings.map((b) => ({ value: b.id, label: b.name }))]" />
    <AppInput v-model="f.period" :label="t('billing.period')" type="month" />
    <AppSelect v-model="f.status" :label="t('billing.status')" :options="[{ value: null, label: '—' }, ...statuses.map((s) => ({ value: s, label: t(`invoices.status.${s}`) }))]" />
    <AppButton type="submit" variant="secondary">{{ t('app.search') }}</AppButton>
  </form>
  <p v-if="res.error.value" class="mb-2 text-sm text-red-600" data-test="page-error">{{ t('app.error') }}</p>
  <DataTable :columns="[{ key: 'number', label: t('invoices.number') }, { key: 'period', label: t('billing.period') }, { key: 'building', label: t('invoices.building') }, { key: 'contact', label: t('invoices.owner') }, { key: 'amountDueMinor', label: t('billing.amountDue') }, { key: 'dueAt', label: t('invoices.due') }, { key: 'status', label: t('billing.status') }]" :rows="res.rows.value">
    <template #cell-number="{ row }"><RouterLink :to="`/app/invoices/${row.id}`" class="text-emerald-700 underline" data-test="invoice-link">{{ row.number ?? t('invoices.status.draft') }}</RouterLink></template>
    <template #cell-building="{ row }">{{ row.building.name }}</template>
    <template #cell-contact="{ row }">{{ row.contact.firstName }} {{ row.contact.lastName }}</template>
    <template #cell-amountDueMinor="{ row }">{{ formatMoney(row.amountDueMinor) }}</template>
    <template #cell-dueAt="{ row }">{{ row.dueAt ? new Date(row.dueAt).toLocaleDateString('mk-MK') : '—' }}</template>
    <template #cell-status="{ row }">{{ t(`invoices.status.${row.status}`) }}</template>
  </DataTable>
</template>
```

`apps/web/src/pages/InvoicePage.vue`:
```vue
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api } from '@/api/client';
import type { Invoice, InvoiceLine } from '@/api/types';
import AppButton from '@/components/ui/AppButton.vue';
import { formatMoney, percentFromBp } from '@/utils/money';

const props = defineProps<{ id: string }>();
const { t } = useI18n();
const router = useRouter();
const API = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3001';
const inv = ref<Invoice | null>(null);
const error = ref('');
onMounted(async () => { inv.value = await api.get<Invoice>(`/api/invoices/${props.id}`); });
const groups = computed(() => {
  const ls = inv.value?.lines ?? [];
  return ([['service', ls.filter((l) => l.kind === 'service' || l.kind === 'manual')], ['management_fee', ls.filter((l) => l.kind === 'management_fee')], ['reserve_fund', ls.filter((l) => l.kind === 'reserve_fund')]] as [InvoiceLine['kind'], InvoiceLine[]][]).filter(([, x]) => x.length);
});
const date = (d: string | null) => (d ? new Date(d).toLocaleDateString('mk-MK') : '—');
async function remove() { try { await api.del(`/api/invoices/${props.id}`); await router.push('/app/invoices'); } catch { error.value = t('app.error'); } }
</script>
<template>
  <div v-if="inv" class="mx-auto max-w-4xl">
    <div class="mb-4 flex items-start justify-between">
      <div><h1 class="text-2xl font-semibold" data-test="invoice-number">{{ inv.number ?? t('invoices.status.draft') }}</h1>
        <p class="text-slate-600">{{ inv.building.name }} · {{ t('billing.period') }} {{ inv.period }} · {{ t(`invoices.status.${inv.status}`) }}</p>
        <p class="text-slate-600">{{ t('invoices.issued') }}: {{ date(inv.issuedAt) }} · {{ t('invoices.due') }}: <span data-test="invoice-due">{{ date(inv.dueAt) }}</span></p></div>
      <div class="flex gap-2">
        <a :href="`${API}/api/invoices/${inv.id}/html`" target="_blank" rel="noopener" class="rounded-md bg-white px-3 py-2 text-sm ring-1 ring-slate-300" data-test="open-html">{{ t('invoices.openHtml') }}</a>
        <a :href="`${API}/api/invoices/${inv.id}/pdf`" target="_blank" rel="noopener" class="rounded-md bg-emerald-600 px-3 py-2 text-sm text-white">{{ t('invoices.downloadPdf') }}</a>
        <AppButton v-if="inv.status === 'draft'" variant="danger" @click="remove">{{ t('invoices.deleteDraft') }}</AppButton>
      </div>
    </div>
    <p v-if="error" class="mb-2 text-sm text-red-600">{{ error }}</p>
    <div class="mb-4 grid grid-cols-2 gap-4 rounded-xl bg-white p-4 shadow-sm">
      <div><div class="text-sm text-slate-500">{{ t('invoices.owner') }}</div><div class="font-medium">{{ inv.contact.firstName }} {{ inv.contact.lastName }}</div><div class="text-sm text-slate-600">{{ inv.contact.address }}</div></div>
      <div><div class="text-sm text-slate-500">{{ t('invoices.units') }}</div><div>{{ [...new Set((inv.lines ?? []).map((l) => l.unitLabel))].join(', ') }}</div></div>
    </div>
    <table class="w-full rounded-xl bg-white text-sm shadow-sm">
      <thead class="bg-slate-50 text-left text-slate-600"><tr><th class="px-3 py-2">{{ t('billing.description') }}</th><th class="px-3 py-2">{{ t('units.label') }}</th><th class="px-3 py-2 text-right">{{ t('billing.buildingWide') }}</th><th class="px-3 py-2 text-right">{{ t('billing.ownerShare') }}</th><th class="px-3 py-2 text-right">{{ t('billing.tax') }}</th><th class="px-3 py-2 text-right">{{ t('billing.total') }}</th></tr></thead>
      <tbody>
        <template v-for="[kind, lines] in groups" :key="kind">
          <tr class="bg-slate-50 font-medium"><td colspan="6" class="px-3 py-1">{{ t(`invoices.lineKind.${kind}`) }}</td></tr>
          <tr v-for="l in lines" :key="l.id" class="border-t border-slate-100"><td class="px-3 py-1">{{ l.description }}</td><td class="px-3 py-1">{{ l.unitLabel }}</td><td class="px-3 py-1 text-right">{{ formatMoney(l.buildingWideNetMinor) }}</td><td class="px-3 py-1 text-right">{{ formatMoney(l.ownerNetMinor) }}</td><td class="px-3 py-1 text-right">{{ percentFromBp(l.taxRateBp) }} / {{ formatMoney(l.ownerTaxMinor) }}</td><td class="px-3 py-1 text-right">{{ formatMoney(l.ownerGrossMinor) }}</td></tr>
        </template>
      </tbody>
    </table>
    <div class="mt-4 ml-auto w-80 space-y-1 text-sm">
      <div class="flex justify-between"><span>{{ t('billing.subtotal') }}</span><span>{{ formatMoney(inv.subtotalMinor) }}</span></div>
      <div class="flex justify-between"><span>{{ t('billing.tax') }}</span><span>{{ formatMoney(inv.taxMinor) }}</span></div>
      <div class="flex justify-between font-medium"><span>{{ t('billing.total') }}</span><span data-test="invoice-total">{{ formatMoney(inv.totalMinor) }}</span></div>
      <div class="flex justify-between"><span>{{ t('billing.previousBalance') }}</span><span>{{ formatMoney(inv.previousBalanceMinor) }}</span></div>
      <div class="flex justify-between border-t border-slate-300 pt-1 text-base font-semibold"><span>{{ t('billing.amountDue') }}</span><span>{{ formatMoney(inv.amountDueMinor) }}</span></div>
      <div class="flex justify-between pt-2 text-slate-600"><span>{{ t('invoices.reserveBalance') }}</span><span>{{ formatMoney(inv.reserveFundBuildingBalanceMinor) }}</span></div>
    </div>
  </div>
  <p v-else>{{ t('app.loading') }}</p>
</template>
```

- [ ] **Step 4: Run tests, typecheck, build**

Run: `pnpm --filter @domar/web test && pnpm --filter @domar/web typecheck && pnpm --filter @domar/web build && pnpm lint`
Expected: PASS (+2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): period page with lines, generate and publish; invoices list and invoice page"
```

---

### Task 12: End-to-end: services → recurring → reserve fund → period → publish → invoice

**Files:**
- Create: `e2e/tests/billing.spec.ts`

- [ ] **Step 1: Write the test**

`e2e/tests/billing.spec.ts`:
```ts
import { expect, test } from '@playwright/test';

const slug = `e2e-bill-${Date.now().toString(36)}`;
const password = 'correct-horse-1';

test('bill a building end to end', async ({ page, request }) => {
  await page.goto('/register');
  await page.getByTestId('orgName').fill('Е2Е Наплата');
  await page.getByTestId('slug').fill(slug);
  await page.getByTestId('firstName').fill('Ева');
  await page.getByTestId('lastName').fill('Тест');
  await page.getByTestId('email').fill(`eva@${slug}.mk`);
  await page.getByTestId('password').fill(password);
  await page.getByRole('button', { name: /Отвори сметка|Create account/ }).click();
  await expect(page).toHaveURL(/\/app$/);

  // owner + building + two units through the UI already covered by smoke; use the API through the browser session for speed
  const api = async (method: 'POST' | 'PUT', url: string, data: unknown) => {
    const cookies = await page.context().cookies();
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const res = await request.fetch(`http://localhost:3001${url}`, { method, data, headers: { cookie, origin: 'http://localhost:5180' } });
    expect(res.ok(), `${method} ${url} → ${res.status()} ${await res.text()}`).toBeTruthy();
    return res.json();
  };
  const owner = await api('POST', '/api/contacts', { firstName: 'Марко', lastName: 'Марков' });
  const building = await api('POST', '/api/buildings', { name: 'Е2Е Зграда', address: 'Улица 1', city: 'Скопје' });
  await api('POST', `/api/buildings/${building.id}/units`, { label: '1', kind: 'apartment', areaM2: 50, ownerContactId: owner.id });
  await api('POST', `/api/buildings/${building.id}/units`, { label: '2', kind: 'apartment', areaM2: 70, ownerContactId: owner.id });

  // service through the UI
  await page.getByTestId('nav-services').click();
  await page.getByTestId('add').click();
  await page.getByTestId('service-name').fill('Чистење');
  await page.getByTestId('service-price').fill('300');
  await page.getByTestId('kind-apartment').check();
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('row')).toHaveCount(1);

  // attach + reserve fund + period through the building tabs
  await page.goto(`/app/buildings/${building.id}?tab=services`);
  await page.getByTestId('attach-service').click();
  await page.getByTestId('attach-service-select').selectOption({ index: 1 });
  await page.getByTestId('attach-submit').click();
  await expect(page.getByTestId('row')).toHaveCount(1);

  await page.getByTestId('tab-reserve-fund').click();
  await page.getByTestId('rf-basis').selectOption('per_m2');
  await page.getByTestId('rf-amount').fill('10');
  await page.getByTestId('rf-active').check();
  await page.getByTestId('rf-kind-apartment').check();
  await page.getByTestId('rf-save').click();
  await page.getByTestId('rf-opening').fill('35000');
  await page.getByTestId('rf-opening-submit').click();
  await expect(page.getByTestId('rf-balance')).toHaveText('35.000,00 ден.');

  await page.getByTestId('tab-periods').click();
  await page.getByTestId('period-month').fill('2026-09');
  await page.getByTestId('period-fee').fill('150');
  await page.getByTestId('period-create').click();
  await page.getByTestId('period-link').first().click();
  await expect(page.getByTestId('period-status')).toHaveText(/Отворен|Open/);

  await page.getByTestId('generate').click();
  await expect(page.getByTestId('period-status')).toHaveText(/Нацрти|Drafts/);
  await expect(page.getByTestId('invoice-link')).toHaveCount(1); // one owner → one invoice
  page.once('dialog', (d) => d.accept());
  await page.getByTestId('publish').click();
  await expect(page.getByTestId('period-status')).toHaveText(/Објавен|Published/);
  await page.getByTestId('invoice-link').first().click();
  await expect(page.getByTestId('invoice-number')).toHaveText('INV-0001/2026');
  // cleaning 300×2 = 600 net + 18% = 708; reserve 10×(50+70) = 1200; fee 150×2 = 300 + 18% = 354 → total 2262,00
  await expect(page.getByTestId('invoice-total')).toHaveText('2.262,00 ден.');
  const html = page.getByTestId('open-html');
  const href = await html.getAttribute('href');
  const res = await request.get(href!, { headers: { cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ') } });
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain('INV-0001/2026');
});
```

- [ ] **Step 2: Run**

Run: `pnpm e2e`
Expected: 2 passed. If the API rejects the `request.fetch` calls with CORS/401, the cookie header is wrong — the session cookie is `domar_session`; `origin` header is not required for server-side fetch, remove it. If the total differs, check the fee `appliesTo` default (apartment+commercial) and the reserve setting the test saved.

- [ ] **Step 3: Commit**

```bash
git add e2e
git commit -m "test(e2e): billing flow from service to published invoice"
```

---

## Self-review notes

- Spec §15 item 2 coverage: services (T3), building services (T4), reserve fund (T5), calculation engine (T1), periods (T6), invoices + ledger postings + publish (T7), PDF/HTML (T8); web for all of it (T9–T11); e2e (T12). Schema (T2) includes `expenses`, `postings` and `invoice_sequences` that sub-plans 3–5 build on.
- Type consistency: `NewPosting`, `addPosting(s)`, `ownerBalances`, `fundBalance`, `billedToOwners` (T5 `ledger.ts`) are used by T7; `resolveTaxRateBp` (T3) by T6; `getPeriod`/`getPeriodRow`/`assertPeriodEditable` (T6) by T7; `getReserveFundSetting` (T5) by T7; `periodDetailOut`/`periodParam` (T6) by T7 routes; `getInvoice` (T7) by T8; `buildingParam`/`buildingUnitParam` (Foundation T10) by T4/T5; `unitKindEnum`, `boolQuery`, `moneyMinor`, `periodStr`, `dedupe` added to common.ts in T3 and used by T4–T7.
- Known deliberate simplifications recorded in the design addendum (single reserve-fund row, 15-day due date, no corrections after publish).
- Web: `api.put` is added to the client in T10.
