import { type Db, schema } from '@domar/db';
import { allocateAcrossFunds } from '@domar/domain';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import { addPostings, type NewPosting } from '../../ledger.js';
import type { TenantContext } from '../../tenant-context.js';

const INV = schema.invoices; const IL = schema.invoiceLines; const PAY = schema.payments; const P = schema.postings; const SL = schema.statementLines;
type Method = typeof PAY.$inferSelect.method;

export interface RecordPaymentInput {
  invoiceId?: string | null | undefined; buildingId?: string | undefined; contactId?: string | undefined; amountMinor: number; method: Method; paidAt: Date;
  reference?: string | null | undefined; note?: string | null | undefined; statementLineId?: string | null | undefined; createdBy?: string | null | undefined;
}

/** Re-derives the invoice status from its completed payments. Draft/cancelled invoices keep their status. */
export async function recomputeInvoiceStatus(tx: Db, ctx: TenantContext, invoiceId: string) {
  // Lock the invoice row: a concurrent payment or void on the same invoice must not read the paid
  // total while the other side is still writing it, or the two could settle on different statuses.
  const [inv] = await tx.select().from(INV).where(and(eq(INV.tenantId, ctx.tenantId), eq(INV.id, invoiceId))).for('update');
  if (!inv) throw notFound('Invoice');
  const [r] = await tx.select({ paid: sql<string>`coalesce(sum(${PAY.amountMinor}), 0)` }).from(PAY)
    .where(and(eq(PAY.tenantId, ctx.tenantId), eq(PAY.invoiceId, invoiceId), eq(PAY.status, 'completed')));
  const paidMinor = Number(r?.paid ?? 0);
  const outstandingMinor = Math.max(0, inv.totalMinor - paidMinor);
  let status = inv.status;
  if (status === 'published' || status === 'partially_paid' || status === 'paid') {
    // `paid` needs money actually received: a zero-total invoice would otherwise satisfy `0 >= 0`.
    status = paidMinor <= 0 ? 'published' : paidMinor >= inv.totalMinor ? 'paid' : 'partially_paid';
    if (status !== inv.status) await tx.update(INV).set({ status, updatedAt: new Date() }).where(and(eq(INV.tenantId, ctx.tenantId), eq(INV.id, invoiceId)));
  }
  return { id: invoiceId, status, paidMinor, outstandingMinor };
}

/** Books a payment: owner account down, building funds up, split across the funds the invoice charged. */
export async function recordPayment(tx: Db, ctx: TenantContext, input: RecordPaymentInput) {
  let buildingId: string; let contactId: string;
  const fundTotals: Partial<Record<'regular' | 'reserve', number>> = {};
  if (input.invoiceId) {
    // Claim the invoice row first: the update takes a row lock for the rest of the transaction, so a
    // concurrent payment or cancellation is serialised behind us instead of racing on the postings.
    const [inv] = await tx.update(INV).set({ updatedAt: new Date() })
      .where(and(eq(INV.tenantId, ctx.tenantId), eq(INV.id, input.invoiceId), inArray(INV.status, ['published', 'partially_paid', 'paid']))).returning();
    if (!inv) {
      const exists = await tx.query.invoices.findFirst({ where: and(eq(INV.tenantId, ctx.tenantId), eq(INV.id, input.invoiceId)), columns: { id: true } });
      if (!exists) throw notFound('Invoice');
      throw conflict('invoice_not_payable', 'Only published invoices can receive payments');
    }
    buildingId = inv.buildingId; contactId = inv.contactId;
    const totals = await tx.select({ fund: IL.fund, total: sql<string>`sum(${IL.ownerGrossMinor})` }).from(IL)
      .where(and(eq(IL.tenantId, ctx.tenantId), eq(IL.invoiceId, inv.id))).groupBy(IL.fund);
    for (const row of totals) fundTotals[row.fund] = Number(row.total);
  } else {
    if (!input.buildingId || !input.contactId) throw badRequest('validation', 'buildingId and contactId are required without an invoice');
    const c = await tx.query.contacts.findFirst({ where: and(eq(schema.contacts.tenantId, ctx.tenantId), eq(schema.contacts.id, input.contactId)), columns: { id: true } });
    if (!c) throw badRequest('invalid_reference', 'contactId does not belong to this organization');
    const b = await tx.query.buildings.findFirst({ where: and(eq(schema.buildings.tenantId, ctx.tenantId), eq(schema.buildings.id, input.buildingId)), columns: { id: true } });
    if (!b) throw notFound('Building');
    buildingId = input.buildingId; contactId = input.contactId; fundTotals.regular = 1;
  }
  const [payment] = await tx.insert(PAY).values({
    tenantId: ctx.tenantId, buildingId, invoiceId: input.invoiceId ?? null, contactId, amountMinor: input.amountMinor, method: input.method, paidAt: input.paidAt,
    reference: input.reference ?? null, note: input.note ?? null, statementLineId: input.statementLineId ?? null, createdBy: input.createdBy ?? ctx.userId,
  }).returning();
  const alloc = allocateAcrossFunds(input.amountMinor, fundTotals);
  const postings: NewPosting[] = [];
  for (const fund of ['regular', 'reserve'] as const) {
    const amt = alloc[fund];
    if (amt <= 0) continue;
    postings.push({ account: 'owner', contactId, buildingId, fund, kind: 'payment', amountMinor: -amt, refType: 'payment', refId: payment!.id, bookedAt: input.paidAt });
    postings.push({ account: 'fund', buildingId, fund, kind: 'payment', amountMinor: amt, refType: 'payment', refId: payment!.id, bookedAt: input.paidAt });
  }
  await addPostings(tx, ctx, postings);
  const invoice = input.invoiceId ? await recomputeInvoiceStatus(tx, ctx, input.invoiceId) : null;
  await writeAudit(tx, ctx, { action: 'payment.record', entityType: 'payment', entityId: payment!.id, after: payment });
  return { payment: payment!, invoice };
}

/** Voids a payment by negating its postings; nothing is ever deleted. */
export async function voidPayment(tx: Db, ctx: TenantContext, id: string, reason: string) {
  // Claim the payment row: the `status = 'completed'` predicate makes a concurrent void lose here,
  // so the reversing postings are written exactly once.
  const [payment] = await tx.update(PAY).set({ status: 'voided', voidReason: reason, voidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(PAY.tenantId, ctx.tenantId), eq(PAY.id, id), eq(PAY.status, 'completed'))).returning();
  if (!payment) {
    const exists = await tx.query.payments.findFirst({ where: and(eq(PAY.tenantId, ctx.tenantId), eq(PAY.id, id)), columns: { id: true } });
    if (!exists) throw notFound('Payment');
    throw conflict('already_voided', 'Payment is already voided');
  }
  const originals = await tx.select().from(P).where(and(eq(P.tenantId, ctx.tenantId), eq(P.refType, 'payment'), eq(P.refId, id)));
  // The reversals are dated now, not in the original's billing period, so `period` stays null.
  await addPostings(tx, ctx, originals.map((o): NewPosting => o.account === 'owner'
    ? { account: 'owner', contactId: o.contactId!, buildingId: o.buildingId, fund: o.fund, kind: 'adjustment', amountMinor: -o.amountMinor, refType: 'payment_void', refId: id }
    : { account: 'fund', buildingId: o.buildingId, fund: o.fund, kind: 'adjustment', amountMinor: -o.amountMinor, refType: 'payment_void', refId: id }));
  if (payment.statementLineId) {
    await tx.update(SL).set({ matchStatus: 'unmatched', paymentId: null, confidence: null })
      .where(and(eq(SL.tenantId, ctx.tenantId), eq(SL.id, payment.statementLineId), eq(SL.paymentId, id)));
  }
  const invoice = payment.invoiceId ? await recomputeInvoiceStatus(tx, ctx, payment.invoiceId) : null;
  await writeAudit(tx, ctx, { action: 'payment.void', entityType: 'payment', entityId: id, after: payment });
  return { payment, invoice };
}
