import { type Db, schema } from '@domar/db';
import { type CountryCode, evaluateOwner, getCountryPack } from '@domar/domain';
import { and, eq, inArray } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { logEmail } from '../../email/log.js';
import type { Mailer } from '../../email/mailer.js';
import { conflict } from '../../errors.js';
import { htmlToPdf } from '../../pdf/html-to-pdf.js';
import { renderReminderHtml, type ReminderHtmlInvoice } from '../../pdf/reminder-html.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import { decorate, getReminderRow, listByIds, overdueByOwner, priorRemindersByOwner, type ReminderRecord } from './repo.js';

const R = schema.reminders; const INV = schema.invoices; const C = schema.contacts; const B = schema.buildings; const T = schema.tenants;
const PRIOR_WINDOW_MS = 31 * 24 * 3600 * 1000; // one day wider than the 30-day rule the pure function applies

export interface ReminderRuntime {
  mailer: Mailer;
  pdfBrowserChannel: string;
  log: { warn(obj: unknown, msg: string): void };
}

/** Evaluates one building now, inserts the due reminders, then sends the email ones after the commit. */
export async function runBuildingReminders(db: Db, ctx: TenantContext, buildingId: string, rt: ReminderRuntime, now: Date = new Date()) {
  const building = await getBuilding(db, ctx, buildingId);
  const tenant = (await db.query.tenants.findFirst({ where: eq(T.id, ctx.tenantId) }))!;
  const pack = getCountryPack(tenant.countryCode as CountryCode);

  const [overdue, priors] = await Promise.all([
    overdueByOwner(db, ctx, buildingId, now),
    priorRemindersByOwner(db, ctx, buildingId, new Date(now.getTime() - PRIOR_WINDOW_MS)),
  ]);

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
  if (plans.length === 0) return { rows: [] };

  const allInvoiceIds = [...new Set(plans.flatMap((p) => p.invoiceIds))];
  const [contacts, invoiceNumbers] = await Promise.all([
    db.select().from(C).where(and(eq(C.tenantId, ctx.tenantId), inArray(C.id, plans.map((p) => p.contactId)))),
    db.select({ id: INV.id, number: INV.number }).from(INV).where(and(eq(INV.tenantId, ctx.tenantId), inArray(INV.id, allInvoiceIds))),
  ]);
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
      totalOutstandingMinor, channel: (contact.email ? 'email' : 'letter') as 'email' | 'letter',
      status: 'pending' as const, documentHtml,
    };
  });

  const inserted = await db.transaction(async (tx) => {
    const rows = await tx.insert(R).values(values).returning();
    await writeAudit(tx, ctx, {
      action: 'reminder.create', entityType: 'building', entityId: buildingId,
      after: { created: rows.map((r) => ({ id: r.id, contactId: r.contactId, reason: r.reason, channel: r.channel, totalOutstandingMinor: r.totalOutstandingMinor, invoiceIds: r.invoiceIds })) },
    });
    return rows;
  });

  // After the commit: a failed send updates the row, it never rolls the reminder back (spec §18.8).
  for (const row of inserted) {
    if (row.channel !== 'email') continue;
    const contact = contactById.get(row.contactId)!;
    await sendReminderEmail(db, ctx, row, contact.email!, building.name, pack, rt);
  }
  return listByIds(db, ctx, inserted.map((r) => r.id));
}

type Pack = ReturnType<typeof getCountryPack>;

async function sendReminderEmail(db: Db, ctx: TenantContext, row: ReminderRecord, to: string, buildingName: string, pack: Pack, rt: ReminderRuntime) {
  const subject = `Опомена за неплатени пресметки — ${buildingName}`;
  const text = [
    buildingName,
    '',
    pack.labels.reminderIntro,
    '',
    `Вкупен долг: ${pack.formatMoney(row.totalOutstandingMinor)}`,
    '',
    pack.labels.reminderLegal,
  ].join('\n');
  let attachments: { filename: string; content: Buffer; contentType: string }[] | undefined;
  try {
    attachments = [{ filename: `opomena-${row.id}.pdf`, content: await htmlToPdf(row.documentHtml, rt.pdfBrowserChannel), contentType: 'application/pdf' }];
  } catch (err) {
    // The letter stays available at GET /reminders/:id/pdf; the debt list is in the plain-text body.
    rt.log.warn({ err, reminderId: row.id }, 'reminder pdf render failed; sending without attachment');
  }
  const res = await rt.mailer.send({ to, subject, text, ...(attachments ? { attachments } : {}) });
  const ok = 'id' in res;
  const error = ok ? null : res.error;
  await db.transaction(async (tx) => {
    await tx.update(R).set({ status: ok ? 'sent' : 'failed', sentAt: ok ? new Date() : null, error })
      .where(and(eq(R.tenantId, ctx.tenantId), eq(R.id, row.id)));
    await logEmail(tx, ctx, { to, subject, template: 'reminder', refType: 'reminder', refId: row.id, status: ok ? 'sent' : 'failed', error });
    await writeAudit(tx, ctx, { action: 'reminder.send', entityType: 'reminder', entityId: row.id, after: { status: ok ? 'sent' : 'failed', to, error } });
  });
}

/** Claim-first: only a pending letter can be marked printed. */
export async function markPrinted(db: Db, ctx: TenantContext, id: string) {
  return db.transaction(async (tx) => {
    const [claimed] = await tx.update(R).set({ status: 'printed', sentAt: new Date() })
      .where(and(eq(R.tenantId, ctx.tenantId), eq(R.id, id), eq(R.channel, 'letter'), eq(R.status, 'pending'))).returning();
    if (!claimed) {
      await getReminderRow(tx, ctx, id); // 404 across tenants, otherwise it is simply not pending
      throw conflict('not_pending', 'Only a pending letter reminder can be marked printed');
    }
    await writeAudit(tx, ctx, { action: 'reminder.printed', entityType: 'reminder', entityId: id, after: { status: 'printed' } });
    const [out] = await decorate(tx, ctx, [claimed]);
    return out!;
  });
}

/** The cron entry point: every building of every tenant, with a null user in the audit trail. */
export async function runAllTenants(db: Db, rt: ReminderRuntime, now: Date = new Date()) {
  const tenants = await db.select({ id: T.id }).from(T);
  let buildings = 0;
  let reminders = 0;
  for (const tenant of tenants) {
    const ctx: TenantContext = { tenantId: tenant.id, userId: null, role: 'owner' };
    // One broken tenant must not stop the nightly run for everybody else.
    try {
      const rows = await db.select({ id: B.id }).from(B).where(eq(B.tenantId, tenant.id));
      for (const b of rows) {
        buildings += 1;
        const res = await runBuildingReminders(db, ctx, b.id, rt, now);
        reminders += res.rows.length;
      }
    } catch (err) {
      rt.log.warn({ err, tenantId: tenant.id }, 'reminder run failed for tenant; skipped');
    }
  }
  return { tenants: tenants.length, buildings, reminders };
}
