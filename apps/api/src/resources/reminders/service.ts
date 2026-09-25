import { type Db, schema } from '@domar/db';
import { evaluateOwner, getCountryPack } from '@domar/domain';
import { and, eq, inArray } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { logEmail } from '../../email/log.js';
import type { Mailer } from '../../email/mailer.js';
import { conflict } from '../../errors.js';
import { recordLegalEvent } from '../../legal-events.js';
import { notifyOwners } from '../../notifications/repo.js';
import { htmlToPdf } from '../../pdf/html-to-pdf.js';
import { formatDocumentDate, renderReminderHtml, type ReminderHtmlInvoice } from '../../pdf/reminder-html.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import { coveredInvoices, decorate, getReminderRow, listByIds, overdueByOwner, priorRemindersByOwner, type ReminderRecord } from './repo.js';

const R = schema.reminders; const INV = schema.invoices; const C = schema.contacts; const B = schema.buildings; const T = schema.tenants;
const PRIOR_WINDOW_MS = 31 * 24 * 3600 * 1000; // one day wider than the 30-day rule the pure function applies

type Pack = ReturnType<typeof getCountryPack>;

export interface ReminderRuntime {
  mailer: Mailer;
  pdfBrowserChannel: string;
  log: { warn(obj: unknown, msg: string): void };
}

/** The tenant row and its country pack. `getCountryPack` itself throws on an unsupported code. */
async function tenantPack(db: Db, ctx: TenantContext) {
  const tenant = (await db.query.tenants.findFirst({ where: eq(T.id, ctx.tenantId) }))!;
  const pack = getCountryPack(tenant.countryCode);
  return { tenant, pack };
}

/** Evaluates one building now, inserts the due reminders, then sends the email ones after the commit. */
export async function runBuildingReminders(db: Db, ctx: TenantContext, buildingId: string, rt: ReminderRuntime, now: Date = new Date()) {
  const building = await getBuilding(db, ctx, buildingId);
  const { tenant, pack } = await tenantPack(db, ctx);

  // Evaluate and insert under a lock on the building row: two overlapping runs serialise, and the
  // second one then reads the first one's reminders as priors instead of duplicating them.
  const { inserted, contactById } = await db.transaction(async (tx) => {
    await tx.select({ id: B.id }).from(B).where(and(eq(B.tenantId, ctx.tenantId), eq(B.id, buildingId))).for('update');
    const empty = { inserted: [] as ReminderRecord[], contactById: new Map<string, typeof C.$inferSelect>() };

    const overdue = await overdueByOwner(tx, ctx, buildingId, now);
    const priors = await priorRemindersByOwner(tx, ctx, buildingId, new Date(now.getTime() - PRIOR_WINDOW_MS));

    const plans = overdue.flatMap((o) => {
      // One owner with a malformed period or due date must not abort the whole building run.
      try {
        const ev = evaluateOwner({ invoices: o.invoices, priorReminders: priors.get(o.contactId) ?? [] }, pack.reminderRules, now);
        if (!ev.due || ev.reason === null) return [];
        const covered = o.invoices.filter((i) => ev.invoiceIds.includes(i.id));
        return [{ contactId: o.contactId, reason: ev.reason, invoiceIds: ev.invoiceIds, covered }];
      } catch (err) {
        rt.log.warn({ err, tenantId: ctx.tenantId, buildingId, contactId: o.contactId }, 'reminder evaluation failed for owner; skipped');
        return [];
      }
    });
    if (plans.length === 0) return empty;

    const allInvoiceIds = [...new Set(plans.flatMap((p) => p.invoiceIds))];
    const contacts = await tx.select().from(C).where(and(eq(C.tenantId, ctx.tenantId), inArray(C.id, plans.map((p) => p.contactId))));
    const invoiceNumbers = await tx.select({ id: INV.id, number: INV.number }).from(INV).where(and(eq(INV.tenantId, ctx.tenantId), inArray(INV.id, allInvoiceIds)));
    const contactById = new Map(contacts.map((c) => [c.id, c]));
    const numberOf = new Map(invoiceNumbers.map((i) => [i.id, i.number]));

    const values = plans.map((p) => {
      const contact = contactById.get(p.contactId)!;
      const invoices: ReminderHtmlInvoice[] = p.covered
        .map((i) => ({ number: numberOf.get(i.id) ?? null, period: i.period, dueAt: i.dueAt, outstandingMinor: i.outstandingMinor }))
        .sort((x, y) => x.period.localeCompare(y.period));
      const totalOutstandingMinor = p.covered.reduce((s, i) => s + i.outstandingMinor, 0);
      const documentHtml = renderReminderHtml({
        tenant, building, contact, invoices, totalOutstandingMinor,
        labels: { reminderIntro: pack.labels.reminderIntro, reminderLegal: pack.labels.reminderLegal },
        formatMoney: pack.formatMoney, locale: 'mk', createdAt: now,
      });
      return {
        tenantId: ctx.tenantId, buildingId, contactId: p.contactId, reason: p.reason, invoiceIds: p.invoiceIds,
        // Without a configured mailer the reminder is a printable letter from the start: a failed
        // email row would otherwise block a new reminder for 30 days with nothing the manager can do.
        totalOutstandingMinor, channel: (contact.email && rt.mailer.configured ? 'email' : 'letter') as 'email' | 'letter',
        status: 'pending' as const, documentHtml,
      };
    });

    const rows = await tx.insert(R).values(values).returning();
    await notifyOwners(tx, ctx, rows.map((r) => ({
      contactId: r.contactId,
      input: { kind: 'reminder_created' as const, buildingName: building.name, amount: pack.formatMoney(r.totalOutstandingMinor) },
    })));
    await writeAudit(tx, ctx, {
      action: 'reminder.create', entityType: 'building', entityId: buildingId,
      after: { created: rows.map((r) => ({ id: r.id, contactId: r.contactId, reason: r.reason, channel: r.channel, totalOutstandingMinor: r.totalOutstandingMinor, invoiceIds: r.invoiceIds })) },
    });
    return { inserted: rows, contactById };
  });

  // After the commit: a failed send updates the row, it never rolls the reminder back (spec §18.8).
  for (const row of inserted) {
    if (row.channel !== 'email') continue;
    const contact = contactById.get(row.contactId)!;
    try {
      await sendReminderEmail(db, ctx, row, contact.email!, building.name, pack, rt);
    } catch (err) {
      // A throw here (a dead transport, a failed log write) must not cost the remaining owners.
      rt.log.warn({ err, tenantId: ctx.tenantId, buildingId, reminderId: row.id }, 'reminder send threw; marked failed');
      await markSendFailed(db, ctx, row.id, err);
    }
  }
  return listByIds(db, ctx, inserted.map((r) => r.id));
}

/** Last-resort bookkeeping when a send throws outright, so the reminder is never left pending. */
async function markSendFailed(db: Db, ctx: TenantContext, id: string, err: unknown) {
  const error = (err instanceof Error ? err.message : 'send_failed').slice(0, 500);
  await db.transaction(async (tx) => {
    await tx.update(R).set({ status: 'failed', sentAt: null, error }).where(and(eq(R.tenantId, ctx.tenantId), eq(R.id, id)));
    await writeAudit(tx, ctx, { action: 'reminder.send', entityType: 'reminder', entityId: id, after: { status: 'failed', error } });
  });
}

async function sendReminderEmail(db: Db, ctx: TenantContext, row: ReminderRecord, to: string, buildingName: string, pack: Pack, rt: ReminderRuntime) {
  const subject = `Опомена за неплатени пресметки — ${buildingName}`;
  const covered = await coveredInvoices(db, ctx, row.invoiceIds);
  const text = [
    buildingName,
    '',
    pack.labels.reminderIntro,
    '',
    ...covered.map((i) => `${i.number ?? '—'} · ${i.period} · рок: ${formatDocumentDate(i.dueAt)} · ${pack.formatMoney(i.outstandingMinor)}`),
    '',
    `Вкупен долг: ${pack.formatMoney(row.totalOutstandingMinor)}`,
    '',
    pack.labels.reminderLegal,
  ].join('\n');
  let attachments: { filename: string; content: Buffer; contentType: string }[] | undefined;
  try {
    attachments = [{ filename: `opomena-${row.id}.pdf`, content: await htmlToPdf(row.documentHtml, rt.pdfBrowserChannel), contentType: 'application/pdf' }];
  } catch (err) {
    // The owner still gets the itemised debt: the body lists every covered invoice, and the letter
    // itself stays available at GET /reminders/:id/pdf.
    rt.log.warn({ err, reminderId: row.id }, 'reminder pdf render failed; sending without attachment');
  }
  const res = await rt.mailer.send({ to, subject, text, ...(attachments ? { attachments } : {}) });
  const ok = 'id' in res;
  const error = ok ? null : res.error;
  await db.transaction(async (tx) => {
    await tx.update(R).set({ status: ok ? 'sent' : 'failed', sentAt: ok ? new Date() : null, error })
      .where(and(eq(R.tenantId, ctx.tenantId), eq(R.id, row.id)));
    const logRow = await logEmail(tx, ctx, { to, subject, template: 'reminder', refType: 'reminder', refId: row.id, status: ok ? 'sent' : 'failed', error });
    // Only a delivered reminder is evidence of the Art. 28 duty; a failed send is an audit row alone.
    if (ok) {
      await recordLegalEvent(tx, ctx, {
        buildingId: row.buildingId, kind: 'reminder_sent', refType: 'reminder', refId: row.id,
        evidence: { contactId: row.contactId, channel: 'email', emailLogId: logRow.id, invoiceIds: row.invoiceIds, totalOutstandingMinor: row.totalOutstandingMinor, reason: row.reason },
      });
    }
    await writeAudit(tx, ctx, { action: 'reminder.send', entityType: 'reminder', entityId: row.id, after: { status: ok ? 'sent' : 'failed', to, error } });
  });
}

/**
 * Claim-first: a reminder that was never delivered can be marked printed. That is any pending letter
 * and, of either channel, a failed one — paper is the fallback when the email never left the server.
 */
export async function markPrinted(db: Db, ctx: TenantContext, id: string) {
  return db.transaction(async (tx) => {
    const [claimed] = await tx.update(R).set({ status: 'printed', sentAt: new Date() })
      .where(and(eq(R.tenantId, ctx.tenantId), eq(R.id, id), inArray(R.status, ['pending', 'failed']))).returning();
    if (!claimed) {
      await getReminderRow(tx, ctx, id); // 404 across tenants, otherwise it is already sent or printed
      throw conflict('not_pending', 'Only a pending or failed reminder can be marked printed');
    }
    await recordLegalEvent(tx, ctx, {
      buildingId: claimed.buildingId, kind: 'reminder_sent', refType: 'reminder', refId: claimed.id,
      ...(claimed.sentAt ? { occurredAt: claimed.sentAt } : {}),
      evidence: { contactId: claimed.contactId, channel: 'letter', emailLogId: null, invoiceIds: claimed.invoiceIds, totalOutstandingMinor: claimed.totalOutstandingMinor, reason: claimed.reason },
    });
    await writeAudit(tx, ctx, { action: 'reminder.printed', entityType: 'reminder', entityId: id, after: { status: 'printed' } });
    const [out] = await decorate(tx, ctx, [claimed]);
    return out!;
  });
}

/**
 * Claim-first retry of a failed email reminder: the row goes back to `pending` inside the claiming
 * transaction, so two clicks cannot send twice, and the send path then writes the outcome as usual.
 */
export async function resendReminder(db: Db, ctx: TenantContext, id: string, rt: ReminderRuntime) {
  const { row, email } = await db.transaction(async (tx) => {
    const [claimed] = await tx.update(R).set({ status: 'pending', sentAt: null, error: null })
      .where(and(eq(R.tenantId, ctx.tenantId), eq(R.id, id), eq(R.status, 'failed'))).returning();
    if (!claimed) {
      await getReminderRow(tx, ctx, id); // 404 across tenants, otherwise it simply did not fail
      throw conflict('not_resendable', 'Only a failed reminder can be resent');
    }
    const contact = await tx.query.contacts.findFirst({ where: and(eq(C.tenantId, ctx.tenantId), eq(C.id, claimed.contactId)) });
    // The throw rolls the claim back, so a reminder to an owner without an address stays failed.
    if (!contact?.email) throw conflict('no_email', 'This owner has no email address');
    return { row: claimed, email: contact.email };
  });
  const building = await getBuilding(db, ctx, row.buildingId);
  const { pack } = await tenantPack(db, ctx);
  try {
    await sendReminderEmail(db, ctx, row, email, building.name, pack, rt);
  } catch (err) {
    rt.log.warn({ err, tenantId: ctx.tenantId, reminderId: id }, 'reminder resend threw; marked failed');
    await markSendFailed(db, ctx, id, err);
  }
  const { rows } = await listByIds(db, ctx, [id]);
  return rows[0]!;
}

/** The cron entry point: every building of every tenant, with a null user in the audit trail. */
export async function runAllTenants(db: Db, rt: ReminderRuntime, now: Date = new Date()) {
  const tenants = await db.select({ id: T.id }).from(T);
  let buildings = 0;
  let reminders = 0;
  let failed = 0;
  for (const tenant of tenants) {
    const ctx: TenantContext = { tenantId: tenant.id, userId: null, role: 'owner' };
    const rows = await db.select({ id: B.id }).from(B).where(eq(B.tenantId, tenant.id));
    for (const b of rows) {
      // One broken building must not stop the nightly run for any of the others.
      try {
        const res = await runBuildingReminders(db, ctx, b.id, rt, now);
        buildings += 1;
        reminders += res.rows.length;
      } catch (err) {
        // Counted, not just logged: the cron log must tell "nothing was due" from "everything threw".
        failed += 1;
        rt.log.warn({ err, tenantId: tenant.id, buildingId: b.id }, 'reminder run failed for building; skipped');
      }
    }
  }
  return { tenants: tenants.length, buildings, reminders, failed };
}
