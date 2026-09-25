import { type Db, schema } from '@domar/db';
import {
  type ComplianceSnapshot, type CountryCode, evaluateBuildingCompliance, evaluateOwner,
  getCountryPack, localDayStart,
} from '@domar/domain';
import { and, asc, count, countDistinct, desc, eq, inArray, isNotNull, max } from 'drizzle-orm';
import { countEvents, lastEventAt } from '../../legal-events.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import { overdueByOwner, priorRemindersByOwner } from '../reminders/repo.js';

const B = schema.buildings; const BP = schema.billingPeriods; const BC = schema.buildingContracts; const AS = schema.assemblies;
const OCL = schema.ownerContactLinks; const U = schema.units; const T = schema.tenants;

/** What Art. 37 counts as an assembly of this building: one the owners were actually summoned to. */
const COUNTED_STATUSES = ['invited', 'held'] as const;

/** One day wider than the 30-day suppression rule, exactly as `runBuildingReminders` reads it. */
const PRIOR_WINDOW_MS = 31 * 24 * 3600 * 1000;

async function tenantPack(db: Db, ctx: TenantContext) {
  const tenant = (await db.query.tenants.findFirst({ where: eq(T.id, ctx.tenantId) }))!;
  const pack = getCountryPack(tenant.countryCode as CountryCode);
  if (!pack) throw new Error(`unknown country pack: ${tenant.countryCode}`);
  return { tenant, pack };
}

/**
 * The Art. 28 half of the snapshot, computed with the very functions the nightly job uses, so the
 * compliance screen and the reminder run can never disagree about who is over the threshold.
 */
async function reminderState(db: Db, ctx: TenantContext, buildingId: string, now: Date, rules: ReturnType<typeof getCountryPack>['reminderRules']) {
  const overdue = await overdueByOwner(db, ctx, buildingId, now);
  const priors = await priorRemindersByOwner(db, ctx, buildingId, new Date(now.getTime() - PRIOR_WINDOW_MS));
  let ownersOverThreshold = 0;
  let oldestThresholdSince: number | null = null;
  for (const o of overdue) {
    const ev = evaluateOwner({ invoices: o.invoices, priorReminders: priors.get(o.contactId) ?? [] }, rules, now);
    if (!ev.due) continue;
    ownersOverThreshold += 1;
    // The threshold is crossed by the *newest* of the invoices the evaluation names: until that one
    // fell due the owner was not yet over it, so the 30 days cannot start from an older invoice —
    // otherwise the duty reads `overdue` on the very first day a reminder is owed.
    const counted = new Set(ev.invoiceIds);
    let crossedAt: number | null = null;
    for (const i of o.invoices) {
      if (!counted.has(i.id)) continue;
      const due = Date.parse(i.dueAt);
      if (crossedAt === null || due > crossedAt) crossedAt = due;
    }
    if (crossedAt !== null && (oldestThresholdSince === null || crossedAt < oldestThresholdSince)) oldestThresholdSince = crossedAt;
  }
  // From legal events, not the reminders table: only a delivered reminder writes `reminder_sent`
  // (`resources/reminders/service.ts`), so a failed send is never shown as evidence here.
  const lastReminder = await lastEventAt(db, ctx, buildingId, 'reminder_sent');
  return {
    ownersOverThreshold,
    oldestThresholdSince: oldestThresholdSince === null ? null : new Date(oldestThresholdSince).toISOString(),
    lastReminderAt: lastReminder ? lastReminder.toISOString() : null,
  };
}

/** Spec §11: nothing but legal events plus dates the system already holds. */
export async function buildComplianceSnapshot(db: Db, ctx: TenantContext, building: typeof B.$inferSelect, now: Date): Promise<ComplianceSnapshot> {
  const { pack } = await tenantPack(db, ctx);
  const [[published], [linked], [contract], reminders, [assemblyCount], [lastHeld], [lastInvited], lastAnnualReportAt, lastHandoverReportAt, fundStatementAvailableAt, extraordinaryCostCount] = await Promise.all([
    // Regular periods only: an extraordinary one-off must not satisfy the monthly Art. 19/33 duty.
    db.select({ at: max(BP.publishedAt) }).from(BP)
      .where(and(eq(BP.tenantId, ctx.tenantId), eq(BP.buildingId, building.id), eq(BP.status, 'published'), eq(BP.kind, 'regular'))),
    db.select({ n: countDistinct(OCL.contactId) }).from(OCL)
      .innerJoin(U, and(eq(U.tenantId, OCL.tenantId), eq(U.ownerContactId, OCL.contactId)))
      .where(and(eq(OCL.tenantId, ctx.tenantId), eq(U.buildingId, building.id))),
    db.select({ endsOn: BC.endsOn }).from(BC)
      .where(and(eq(BC.tenantId, ctx.tenantId), eq(BC.buildingId, building.id), eq(BC.kind, 'management')))
      .orderBy(desc(BC.startsOn), desc(BC.createdAt)).limit(1),
    reminderState(db, ctx, building.id, now, pack.reminderRules),
    // The assemblies table, not the event log (plan addendum 9): a *called* assembly already lifts
    // the duty out of `n/a`, and the held/invited pair comes off one row so the Art. 37
    // late-invitation flag compares an assembly's own invitation with its own date. A draft is the
    // manager's notepad — nobody has been summoned yet — and a cancelled assembly summoned nobody,
    // so neither counts and a building with only drafts is still one domar knows nothing about.
    db.select({ n: count() }).from(AS)
      .where(and(eq(AS.tenantId, ctx.tenantId), eq(AS.buildingId, building.id), inArray(AS.status, [...COUNTED_STATUSES]))),
    db.select({ heldAt: AS.heldAt, invitedAt: AS.invitedAt, lateInvitation: AS.lateInvitation }).from(AS)
      .where(and(eq(AS.tenantId, ctx.tenantId), eq(AS.buildingId, building.id), eq(AS.status, 'held')))
      .orderBy(desc(AS.heldAt)).limit(1),
    db.select({ invitedAt: AS.invitedAt }).from(AS)
      .where(and(eq(AS.tenantId, ctx.tenantId), eq(AS.buildingId, building.id), inArray(AS.status, [...COUNTED_STATUSES]), isNotNull(AS.invitedAt)))
      .orderBy(desc(AS.invitedAt)).limit(1),
    lastEventAt(db, ctx, building.id, 'annual_report_issued'),
    lastEventAt(db, ctx, building.id, 'handover_report_issued'),
    lastEventAt(db, ctx, building.id, 'fund_statement_available'),
    countEvents(db, ctx, building.id, 'extraordinary_cost_distributed'),
  ]);
  return {
    buildingCreatedAt: building.createdAt.toISOString(),
    lastPublishedPeriodAt: published?.at ? published.at.toISOString() : null,
    ownersOverThreshold: reminders.ownersOverThreshold,
    oldestThresholdSince: reminders.oldestThresholdSince,
    lastReminderAt: reminders.lastReminderAt,
    assemblyCount: Number(assemblyCount?.n ?? 0),
    lastAssemblyHeldAt: lastHeld?.heldAt?.toISOString() ?? null,
    // The invitation of the assembly that was held, so a punctual assembly is never flagged because
    // a *later* one was called late; only when nothing was ever held does the newest one stand in.
    lastAssemblyInvitedAt: (lastHeld ? lastHeld.invitedAt : (lastInvited?.invitedAt ?? null))?.toISOString() ?? null,
    // The held assembly's own stamp, so an overridden late invitation keeps flagging the card even
    // when the minutes were written long enough after the hold to make the measured gap look ample.
    lastAssemblyLateInvitation: lastHeld?.lateInvitation ?? false,
    lastAnnualReportAt: lastAnnualReportAt?.toISOString() ?? null,
    portalLinkedOwners: Number(linked?.n ?? 0),
    fundStatementAvailableAt: fundStatementAvailableAt?.toISOString() ?? null,
    regularFundAccount: building.regularFundAccount,
    reserveFundAccount: building.reserveFundAccount,
    managementContractEndsOn: contract?.endsOn ?? null,
    lastHandoverReportAt: lastHandoverReportAt?.toISOString() ?? null,
    extraordinaryCostCount,
  };
}

/** The pack's Macedonian title and hint, merged onto the pure duties (plan addendum 7). */
function withLabels(result: ReturnType<typeof evaluateBuildingCompliance>, pack: ReturnType<typeof getCountryPack>) {
  return result.duties.map((d) => ({ ...d, label: pack.labels.compliance[d.key]?.title ?? d.key, hint: pack.labels.compliance[d.key]?.hint ?? '' }));
}

export async function buildingCompliance(db: Db, ctx: TenantContext, buildingId: string) {
  const building = await getBuilding(db, ctx, buildingId); // 404 across tenants
  const { tenant, pack } = await tenantPack(db, ctx);
  const now = new Date();
  const today = localDayStart(now, tenant.timezone);
  const snapshot = await buildComplianceSnapshot(db, ctx, building, now);
  const result = evaluateBuildingCompliance(snapshot, today, pack.complianceRules, tenant.timezone);
  return {
    building: { id: building.id, name: building.name },
    status: result.status,
    counts: result.counts,
    duties: withLabels(result, pack),
    evaluatedAt: today.toISOString(),
  };
}

/**
 * Every building of the tenant, worst status first-class. Sequential per building rather than one
 * clever join: a pilot tenant has tens of buildings, and the snapshot already shares its queries
 * with the reminder job, which is the correctness property worth keeping.
 */
export async function tenantCompliance(db: Db, ctx: TenantContext) {
  const { tenant, pack } = await tenantPack(db, ctx);
  const now = new Date();
  const today = localDayStart(now, tenant.timezone);
  const buildings = await db.select().from(B).where(eq(B.tenantId, ctx.tenantId)).orderBy(asc(B.name));
  const counts = { ok: 0, due: 0, overdue: 0, na: 0 };
  const rows = [];
  for (const building of buildings) {
    const snapshot = await buildComplianceSnapshot(db, ctx, building, now);
    const result = evaluateBuildingCompliance(snapshot, today, pack.complianceRules, tenant.timezone);
    counts[result.status === 'n/a' ? 'na' : result.status] += 1;
    rows.push({
      building: { id: building.id, name: building.name },
      status: result.status,
      counts: result.counts,
      duties: result.duties.map((d) => ({ key: d.key, status: d.status })),
    });
  }
  return { rows, counts, evaluatedAt: today.toISOString() };
}
