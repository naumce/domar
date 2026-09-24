import { type Db, schema } from '@domar/db';
import { parseUnitImport, type UnitImportRow } from '@domar/domain';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { AppError, conflict } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import { hasPublishedPeriod, insertOpeningBalances } from '../opening-balances/repo.js';
import { insertUnit } from '../units/repo.js';
import type { ImportUnitsBody } from './schema.js';

const C = schema.contacts; const U = schema.units;

/** One key per distinct owner in the file: email when present, else the exact name pair. */
function ownerKey(r: UnitImportRow): string | null {
  if (!r.ownerLastName) return null;
  return r.ownerEmail ? `e:${r.ownerEmail}` : `n:${(r.ownerFirstName ?? '').toLowerCase()}|${r.ownerLastName.toLowerCase()}`;
}

/** Labels of the file that already exist in the building. */
async function existingLabels(db: Db, ctx: TenantContext, buildingId: string, rows: UnitImportRow[]): Promise<string[]> {
  const labels = [...new Set(rows.map((r) => r.label))];
  if (labels.length === 0) return [];
  const found = await db.select({ label: U.label }).from(U)
    .where(and(eq(U.tenantId, ctx.tenantId), eq(U.buildingId, buildingId), inArray(U.label, labels)));
  return found.map((f) => f.label);
}

/**
 * Resolves every distinct owner of `rows` to a contact id: by lower(email) inside the tenant, else by
 * the exact first+last name inside the tenant, else created (only when `create` is set).
 */
async function resolveOwners(db: Db, ctx: TenantContext, rows: UnitImportRow[], create: boolean) {
  const byKey = new Map<string, UnitImportRow>();
  for (const r of rows) {
    const k = ownerKey(r);
    if (k && !byKey.has(k)) byKey.set(k, r);
  }
  const ids = new Map<string, string>();
  let existingContacts = 0;
  let newContacts = 0;
  for (const [k, r] of byKey) {
    const [match] = r.ownerEmail
      ? await db.select({ id: C.id }).from(C).where(and(eq(C.tenantId, ctx.tenantId), sql`lower(${C.email}) = ${r.ownerEmail}`)).limit(1)
      : await db.select({ id: C.id }).from(C).where(and(eq(C.tenantId, ctx.tenantId), eq(C.firstName, r.ownerFirstName ?? ''), eq(C.lastName, r.ownerLastName!))).limit(1);
    if (match) { ids.set(k, match.id); existingContacts++; continue; }
    newContacts++;
    if (!create) continue;
    const [row] = await db.insert(C).values({
      tenantId: ctx.tenantId, kind: 'person', firstName: r.ownerFirstName ?? '', lastName: r.ownerLastName!,
      email: r.ownerEmail, phone: r.ownerPhone,
    }).returning({ id: C.id });
    ids.set(k, row!.id);
  }
  return { ids, existingContacts, newContacts };
}

export async function importUnits(db: Db, ctx: TenantContext, buildingId: string, body: ImportUnitsBody) {
  const { rows, errors } = parseUnitImport(body.content);

  if (body.dryRun) {
    await getBuilding(db, ctx, buildingId);
    const conflicts = await existingLabels(db, ctx, buildingId, rows);
    const importable = rows.filter((r) => !conflicts.includes(r.label));
    const owners = await resolveOwners(db, ctx, importable, false);
    return {
      dryRun: true, rows, errors, conflicts,
      counts: {
        units: importable.length, newContacts: owners.newContacts, existingContacts: owners.existingContacts,
        openingBalances: importable.filter((r) => r.openingBalanceMinor !== 0 && ownerKey(r)).length,
        conflicts: conflicts.length,
      },
    };
  }

  return db.transaction(async (tx) => {
    await getBuilding(tx, ctx, buildingId);
    const conflicts = await existingLabels(tx, ctx, buildingId, rows);
    if (conflicts.length > 0 && body.mode === 'fail') {
      throw new AppError(409, 'label_conflict', 'Some unit labels already exist in this building', { labels: conflicts });
    }
    const importable = rows.filter((r) => !conflicts.includes(r.label));
    const withBalance = importable.filter((r) => r.openingBalanceMinor !== 0 && ownerKey(r));
    if (withBalance.length > 0 && (await hasPublishedPeriod(tx, ctx, buildingId))) {
      throw conflict('period_published', 'This building already has a published period; book opening balances from the Opening balances tab with force');
    }
    const owners = await resolveOwners(tx, ctx, importable, true);
    for (const r of importable) {
      const k = ownerKey(r);
      await insertUnit(tx, ctx, buildingId, {
        label: r.label, kind: r.kind,
        ...(r.floor !== null ? { floor: r.floor } : {}),
        ...(r.areaM2 !== null ? { areaM2: r.areaM2 } : {}),
        ...(r.ownershipShare !== null ? { ownershipShare: r.ownershipShare } : {}),
        ...(k ? { ownerContactId: owners.ids.get(k)! } : {}),
      });
    }
    const postings = withBalance.length > 0
      ? await insertOpeningBalances(tx, ctx, buildingId, withBalance.map((r) => ({
          contactId: owners.ids.get(ownerKey(r)!)!, fund: 'regular' as const, amountMinor: r.openingBalanceMinor, note: `import: ${r.label}`,
        })))
      : [];
    const counts = {
      units: importable.length, newContacts: owners.newContacts, existingContacts: owners.existingContacts,
      openingBalances: postings.length, conflicts: conflicts.length,
    };
    await writeAudit(tx, ctx, {
      action: 'import.units', entityType: 'building', entityId: buildingId,
      after: { counts, mode: body.mode, conflicts, errorCount: errors.length },
    });
    return { dryRun: false, rows: importable, errors, counts, conflicts };
  });
}
