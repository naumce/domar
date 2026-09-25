import { type Db, schema } from '@domar/db';
import { getCountryPack } from '@domar/domain';
import { and, eq, inArray } from 'drizzle-orm';
import { writeAudit } from '../audit.js';
import { conflict } from '../errors.js';
import { htmlToPdf } from '../pdf/html-to-pdf.js';
import { renderInvoiceHtml } from '../pdf/invoice-html.js';
import { getInvoice } from '../resources/invoices/repo.js';
import { getPeriodRow } from '../resources/periods/repo.js';
import type { ReminderRuntime } from '../resources/reminders/service.js';
import type { TenantContext } from '../tenant-context.js';
import { logEmail } from './log.js';

const INV = schema.invoices; const T = schema.tenants;
const SENDABLE = ['published', 'partially_paid', 'paid'] as const;

/** Emails one invoice's PDF to its owner. 409 when the owner has no email or the invoice is a draft. */
export async function sendInvoiceEmail(db: Db, ctx: TenantContext, invoiceId: string, rt: ReminderRuntime) {
  const invoice = await getInvoice(db, ctx, invoiceId); // 404 across tenants
  if (!SENDABLE.includes(invoice.status as (typeof SENDABLE)[number])) throw conflict('invoice_not_sendable', 'Only a published invoice can be emailed');
  const to = invoice.contact.email;
  if (!to) throw conflict('no_email', 'This owner has no email address');

  const tenant = (await db.query.tenants.findFirst({ where: eq(T.id, ctx.tenantId) }))!;
  const pack = getCountryPack(tenant.countryCode);
  const html = renderInvoiceHtml({ invoice, tenant, formatMoney: pack.formatMoney, locale: 'mk' });
  const name = (invoice.number ?? `draft-${invoice.id}`).replace(/[^A-Za-z0-9_.-]/g, '_');
  const subject = `Фактура ${invoice.number ?? invoice.id} — ${invoice.building.name}`;
  const text = [
    `${invoice.building.name}`,
    '',
    `Во прилог е пресметката ${invoice.number ?? invoice.id} за периодот ${invoice.period}.`,
    `Вкупно за плаќање: ${pack.formatMoney(invoice.amountDueMinor)}`,
    `Рок за плаќање: ${invoice.dueAt ? new Date(invoice.dueAt).toLocaleDateString('mk-MK') : '—'}`,
  ].join('\n');

  let attachments: { filename: string; content: Buffer; contentType: string }[] | undefined;
  try {
    attachments = [{ filename: `${name}.pdf`, content: await htmlToPdf(html, rt.pdfBrowserChannel), contentType: 'application/pdf' }];
  } catch (err) {
    rt.log.warn({ err, invoiceId }, 'invoice pdf render failed; sending without attachment');
  }
  const res = await rt.mailer.send({ to, subject, text, ...(attachments ? { attachments } : {}) });
  const ok = 'id' in res;
  const error = ok ? null : res.error;
  await db.transaction(async (tx) => {
    await logEmail(tx, ctx, { to, subject, template: 'invoice', refType: 'invoice', refId: invoiceId, status: ok ? 'sent' : 'failed', error });
    await writeAudit(tx, ctx, { action: 'invoice.send', entityType: 'invoice', entityId: invoiceId, after: { status: ok ? 'sent' : 'failed', to, error } });
  });
  return { id: invoiceId, status: (ok ? 'sent' : 'failed') as 'sent' | 'failed', to, error };
}

/** Emails every sendable invoice of a period. Owners without an email are skipped, never an error. */
export async function sendPeriodEmails(db: Db, ctx: TenantContext, buildingId: string, periodId: string, rt: ReminderRuntime) {
  await getPeriodRow(db, ctx, buildingId, periodId); // 404 across tenants
  const rows = await db.select({ id: INV.id, contactId: INV.contactId }).from(INV)
    .where(and(eq(INV.tenantId, ctx.tenantId), eq(INV.periodId, periodId), inArray(INV.status, [...SENDABLE])));
  let sent = 0; let failed = 0; let skipped = 0;
  for (const row of rows) {
    try {
      const res = await sendInvoiceEmail(db, ctx, row.id, rt);
      if (res.status === 'sent') sent += 1; else failed += 1;
    } catch (err) {
      // `no_email` is the only expected refusal here and it means "this owner gets a paper copy".
      if (err instanceof Error && 'code' in err && (err as { code: unknown }).code === 'no_email') { skipped += 1; continue; }
      // Anything else (a dead transport, a failed log write) must not cost the remaining owners.
      rt.log.warn({ err, tenantId: ctx.tenantId, buildingId, invoiceId: row.id }, 'invoice send threw; marked failed');
      failed += 1;
    }
  }
  return { sent, failed, skipped };
}
