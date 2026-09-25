import { type Db, schema } from '@domar/db';
import { localDayStart } from '@domar/domain';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import type { DocumentStore } from '../../documents/store.js';
import { logEmail } from '../../email/log.js';
import type { Mailer, SendResult } from '../../email/mailer.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import { recordLegalEvent } from '../../legal-events.js';
import { formatAssemblyDateTime, renderAssemblyInvitationHtml } from '../../pdf/assembly-invitation-html.js';
import { htmlToPdf } from '../../pdf/html-to-pdf.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import { assemblyOwners, claimAssembly, getAssembly, getAssemblyRow, listDecisionRows, publicAssembly, tenantPack } from './repo.js';

const A = schema.assemblies; const AI = schema.assemblyInvitations; const C = schema.contacts;
const DAY_MS = 86_400_000;

export interface AssemblyRuntime {
  mailer: Mailer;
  pdfBrowserChannel: string;
  /** Used by Task 4's `holdAssembly` to file the minutes; carried here so the runtime is built once. */
  documents: DocumentStore;
  log: { warn(obj: unknown, msg: string): void };
}

/**
 * Art. 37 counts civil days, not 24-hour spans: both ends are put onto local midnight in the
 * tenant's zone first, so an assembly fifteen days away at an earlier hour of the day is still
 * fifteen days away. Same measure as the `late_invitation` flag in `evaluateBuildingCompliance`,
 * so the invitation this endpoint accepts is never the one compliance calls late. Rounded, not
 * floored: a DST transition inside the span makes it 23 or 25 hours long.
 */
const civilDaysUntil = (from: Date, to: Date, timeZone: string) =>
  Math.round((localDayStart(to, timeZone).getTime() - localDayStart(from, timeZone).getTime()) / DAY_MS);

interface InvitationTextInput {
  buildingName: string;
  scheduledAt: Date;
  location: string;
  agenda: { title: string }[];
  decisions: { title: string }[];
  labels: { assemblyInvitationIntro: string; assemblyLegal: string };
  timeZone: string;
}

/** The plain-text twin of the invitation document, for clients that never open the attachment. */
function invitationText(x: InvitationTextInput): string {
  return [
    x.buildingName,
    '',
    x.labels.assemblyInvitationIntro,
    '',
    `Датум и час: ${formatAssemblyDateTime(x.scheduledAt, x.timeZone)}`,
    `Место: ${x.location || '—'}`,
    '',
    'Дневен ред:',
    ...x.agenda.map((i, n) => `${n + 1}. ${i.title}`),
    ...(x.decisions.length > 0 ? ['', 'Предлог-одлуки за гласање:', ...x.decisions.map((d, n) => `${n + 1}. ${d.title}`)] : []),
    '',
    x.labels.assemblyLegal,
  ].join('\n');
}

/**
 * Art. 37. One transaction freezes who is invited, how, and that it happened; the sends follow after
 * the commit (plan addendum 11), so a dead SMTP server costs one owner an email and never un-invites
 * the building.
 */
export async function inviteAssembly(db: Db, ctx: TenantContext, id: string, input: { override?: { reason: string } | undefined }, rt: AssemblyRuntime) {
  const prepared = await db.transaction(async (tx) => {
    const claimed = await claimAssembly(tx, ctx, id, ['draft']);
    const building = await getBuilding(tx, ctx, claimed.buildingId);
    const { tenant, pack } = await tenantPack(tx, ctx);
    const now = new Date();
    // Civil days answer Art. 37's fifteen; whether the assembly has already happened is a question
    // about instants, so an assembly scheduled for nine this morning is past at noon, not tonight.
    if (claimed.scheduledAt.getTime() <= now.getTime()) throw badRequest('assembly_in_the_past', 'This assembly is scheduled in the past');
    const days = civilDaysUntil(now, claimed.scheduledAt, tenant.timezone);
    const minDays = pack.complianceRules.assemblyInvitationMinDays;
    const late = days < minDays;
    if (late && !input.override) {
      throw conflict('invitation_too_late', `Art. 37 asks for ${minDays} days; this assembly is ${days} days away`, { days, minDays });
    }
    const owners = await assemblyOwners(tx, ctx, claimed.buildingId, claimed.quorumBasis);
    const contacts = await tx.select().from(C)
      .where(and(eq(C.tenantId, ctx.tenantId), inArray(C.id, owners.map((o) => o.contactId))))
      .orderBy(asc(C.lastName), asc(C.firstName));
    const decisions = await listDecisionRows(tx, ctx, id);
    const labels = { assemblyInvitationIntro: pack.labels.assemblyInvitationIntro, assemblyLegal: pack.labels.assemblyLegal };
    const invitationHtml = renderAssemblyInvitationHtml({
      tenant, building, scheduledAt: claimed.scheduledAt, location: claimed.location,
      agenda: claimed.agenda, decisions: decisions.map((d) => ({ title: d.title, text: d.text })),
      labels, timeZone: tenant.timezone, locale: 'mk', createdAt: now,
    });
    // Without a configured mailer every invitation is a printable letter from the start, exactly as
    // `runBuildingReminders` decides it: a failed email row would be evidence of nothing.
    const invitations = await tx.insert(AI).values(contacts.map((c) => ({
      tenantId: ctx.tenantId, assemblyId: id, contactId: c.id,
      channel: (c.email && rt.mailer.configured ? 'email' : 'letter') as 'email' | 'letter',
      status: 'pending' as const,
    }))).returning();
    const channels = {
      email: invitations.filter((r) => r.channel === 'email').length,
      letter: invitations.filter((r) => r.channel === 'letter').length,
    };
    await tx.update(A).set({
      status: 'invited', invitedAt: now, lateInvitation: late,
      // Only a late invitation has a reason to give: an override sent with a timely one explains nothing.
      lateReason: late ? input.override!.reason : null, invitationHtml, updatedAt: now,
    }).where(and(eq(A.tenantId, ctx.tenantId), eq(A.id, id)));
    await recordLegalEvent(tx, ctx, {
      buildingId: claimed.buildingId, kind: 'assembly_invited', refType: 'assembly', refId: id,
      occurredAt: now, dueAt: claimed.scheduledAt,
      evidence: {
        assemblyId: id, scheduledAt: claimed.scheduledAt.toISOString(), invitedAt: now.toISOString(),
        contacts: invitations.length, channels, late,
        ...(late ? { lateReason: input.override!.reason } : {}),
      },
    });
    await writeAudit(tx, ctx, {
      action: 'assembly.invite', entityType: 'assembly', entityId: id,
      before: publicAssembly(claimed),
      after: { contacts: invitations.length, channels, late, lateReason: late ? input.override!.reason : null, daysAhead: days },
    });
    return {
      invitations, contacts, buildingName: building.name, timeZone: tenant.timezone, invitationHtml, labels,
      scheduledAt: claimed.scheduledAt, location: claimed.location, agenda: claimed.agenda, decisions,
    };
  });

  const emailed = prepared.invitations.filter((r) => r.channel === 'email');
  if (emailed.length > 0) {
    // One render for the whole building (plan addendum 10), and a missing attachment never stops
    // the notice: the body carries the date, the place and the agenda in full.
    let attachments: { filename: string; content: Buffer; contentType: string }[] | undefined;
    try {
      attachments = [{ filename: `pokana-${id}.pdf`, content: await htmlToPdf(prepared.invitationHtml, rt.pdfBrowserChannel), contentType: 'application/pdf' }];
    } catch (err) {
      rt.log.warn({ err, assemblyId: id }, 'assembly invitation pdf render failed; sending without attachment');
    }
    const subject = `Покана за собир — ${prepared.buildingName}`;
    const text = invitationText({
      buildingName: prepared.buildingName, scheduledAt: prepared.scheduledAt, location: prepared.location,
      agenda: prepared.agenda, decisions: prepared.decisions, labels: prepared.labels, timeZone: prepared.timeZone,
    });
    const emailOf = new Map(prepared.contacts.map((c) => [c.id, c.email]));
    for (const invitation of emailed) {
      const to = emailOf.get(invitation.contactId);
      if (!to) continue;
      try {
        const res = await rt.mailer.send({ to, subject, text, ...(attachments ? { attachments } : {}) });
        await recordInvitationSend(db, ctx, invitation.id, to, subject, res);
      } catch (err) {
        // A throw here (a dead transport, a failed log write) must not cost the remaining owners.
        rt.log.warn({ err, assemblyId: id, invitationId: invitation.id }, 'assembly invitation send threw; marked failed');
        await markInvitationFailed(db, ctx, invitation.id, err);
      }
    }
  }
  return getAssembly(db, ctx, id);
}

async function recordInvitationSend(db: Db, ctx: TenantContext, invitationId: string, to: string, subject: string, res: SendResult) {
  const ok = 'id' in res;
  const error = ok ? null : res.error;
  await db.transaction(async (tx) => {
    const logRow = await logEmail(tx, ctx, { to, subject, template: 'assembly_invitation', refType: 'assembly_invitation', refId: invitationId, status: ok ? 'sent' : 'failed', error });
    await tx.update(AI).set({ status: ok ? 'sent' : 'failed', sentAt: ok ? new Date() : null, error, emailLogId: logRow.id })
      .where(and(eq(AI.tenantId, ctx.tenantId), eq(AI.id, invitationId)));
    await writeAudit(tx, ctx, { action: 'assembly_invitation.send', entityType: 'assembly_invitation', entityId: invitationId, after: { status: ok ? 'sent' : 'failed', to, error } });
  });
}

/** Last-resort bookkeeping when a send throws outright, so an invitation is never left pending. */
async function markInvitationFailed(db: Db, ctx: TenantContext, invitationId: string, err: unknown) {
  const error = (err instanceof Error ? err.message : 'send_failed').slice(0, 500);
  await db.transaction(async (tx) => {
    await tx.update(AI).set({ status: 'failed', sentAt: null, error }).where(and(eq(AI.tenantId, ctx.tenantId), eq(AI.id, invitationId)));
    await writeAudit(tx, ctx, { action: 'assembly_invitation.send', entityType: 'assembly_invitation', entityId: invitationId, after: { status: 'failed', error } });
  });
}

/**
 * Claim-first, like `markPrinted` on a reminder: a letter that was never delivered can be marked
 * printed, and so can a failed email — paper is the fallback when the message never left the server.
 * No legal event: `assembly_invited` already evidences the duty (plan addendum 12).
 */
export async function markInvitationPrinted(db: Db, ctx: TenantContext, invitationId: string) {
  return db.transaction(async (tx) => {
    const [claimed] = await tx.update(AI).set({ status: 'printed', sentAt: new Date() })
      .where(and(eq(AI.tenantId, ctx.tenantId), eq(AI.id, invitationId), inArray(AI.status, ['pending', 'failed']))).returning();
    if (!claimed) {
      const [row] = await tx.select({ id: AI.id }).from(AI).where(and(eq(AI.tenantId, ctx.tenantId), eq(AI.id, invitationId))).limit(1);
      if (!row) throw notFound('Invitation'); // 404 across tenants
      throw conflict('not_pending', 'Only a pending or failed invitation can be marked printed');
    }
    // A printed letter is evidence of delivery, so it is only evidence while the assembly is still
    // called: printing the notice of a cancelled or a finished assembly delivers nothing. The throw
    // rolls the claim back with it.
    const assembly = await getAssemblyRow(tx, ctx, claimed.assemblyId);
    if (assembly.status !== 'invited') throw conflict('not_invited', 'This assembly is not currently a called one');
    await writeAudit(tx, ctx, { action: 'assembly_invitation.printed', entityType: 'assembly_invitation', entityId: invitationId, after: { status: 'printed' } });
    return getAssembly(tx, ctx, claimed.assemblyId);
  });
}

export async function cancelAssembly(db: Db, ctx: TenantContext, id: string, reason: string) {
  return db.transaction(async (tx) => {
    const before = await claimAssembly(tx, ctx, id, ['draft', 'invited']);
    const now = new Date();
    await tx.update(A).set({ status: 'cancelled', cancelledAt: now, cancelReason: reason, updatedAt: now })
      .where(and(eq(A.tenantId, ctx.tenantId), eq(A.id, id)));
    // An invitation that was never delivered is closed with the assembly: it can no longer be
    // printed, and it must not sit in the pending-letters queue of an assembly nobody will hold.
    // The delivered ones (`sent`, `printed`) keep their status: they are evidence of what happened.
    const closed = await tx.update(AI).set({ status: 'cancelled' })
      .where(and(eq(AI.tenantId, ctx.tenantId), eq(AI.assemblyId, id), eq(AI.status, 'pending'))).returning({ id: AI.id });
    // No legal event: a cancelled assembly discharged nothing, and the audit row records who and why.
    await writeAudit(tx, ctx, { action: 'assembly.cancel', entityType: 'assembly', entityId: id, before: publicAssembly(before), after: { status: 'cancelled', cancelReason: reason, invitationsCancelled: closed.length } });
    return getAssembly(tx, ctx, id);
  });
}

/**
 * The notice as it went out, for as long as it is evidence of anything: a called assembly, and a
 * held one — what the owners were summoned with outlives the meeting. A draft was never sent and a
 * cancelled one summons nobody, so neither has a document to serve.
 */
/**
 * The minutes as they were rendered when the assembly was held. The PDF is the document of record,
 * but the row keeps the HTML it was made from, and evidence nothing can display is evidence of
 * nothing — the more so since the minutes document is now undeletable (spec §4).
 */
export async function assemblyMinutesHtml(db: Db, ctx: TenantContext, id: string): Promise<string> {
  const row = await getAssemblyRow(db, ctx, id); // 404 across tenants
  if (row.status !== 'held' || !row.minutesHtml) throw conflict('not_held', 'This assembly has no minutes on file');
  return row.minutesHtml;
}

export async function assemblyInvitationHtml(db: Db, ctx: TenantContext, id: string): Promise<string> {
  const row = await getAssemblyRow(db, ctx, id); // 404 across tenants
  const served = row.status === 'invited' || row.status === 'held';
  if (!served || !row.invitationHtml) throw conflict('not_invited', 'This assembly has no invitation on file');
  return row.invitationHtml;
}
