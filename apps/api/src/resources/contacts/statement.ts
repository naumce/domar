import { type Db, schema } from '@domar/db';
import { getCountryPack, type CountryCode } from '@domar/domain';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { dedupe } from '../common.js';

const C = schema.contacts; const B = schema.buildings; const P = schema.postings; const INV = schema.invoices; const PAY = schema.payments; const T = schema.tenants;

/** Owner-account postings for a contact (optionally scoped to one building), with a running balance. */
export async function ownerStatement(db: Db, ctx: TenantContext, contactId: string, buildingId?: string | undefined) {
  const contact = await db.query.contacts.findFirst({ where: and(eq(C.tenantId, ctx.tenantId), eq(C.id, contactId)), columns: { id: true, firstName: true, lastName: true } });
  if (!contact) throw notFound('Contact');
  let building: { id: string; name: string } | null = null;
  if (buildingId) {
    const b = await db.query.buildings.findFirst({ where: and(eq(B.tenantId, ctx.tenantId), eq(B.id, buildingId)), columns: { id: true, name: true } });
    if (!b) throw notFound('Building');
    building = b;
  }
  const tenant = await db.query.tenants.findFirst({ where: eq(T.id, ctx.tenantId), columns: { countryCode: true } });
  const pack = getCountryPack(tenant!.countryCode as CountryCode);

  const conds = [eq(P.tenantId, ctx.tenantId), eq(P.account, 'owner'), eq(P.contactId, contactId)];
  if (buildingId) conds.push(eq(P.buildingId, buildingId));
  const postings = await db.select().from(P).where(and(...conds)).orderBy(asc(P.bookedAt), asc(P.createdAt));

  const invoiceIds = dedupe(postings.filter((p) => p.refType === 'invoice' && p.refId).map((p) => p.refId!));
  const paymentIds = dedupe(postings.filter((p) => (p.refType === 'payment' || p.refType === 'payment_void') && p.refId).map((p) => p.refId!));
  const [invoices, payments] = await Promise.all([
    invoiceIds.length ? db.select({ id: INV.id, number: INV.number }).from(INV).where(and(eq(INV.tenantId, ctx.tenantId), inArray(INV.id, invoiceIds))) : [],
    paymentIds.length ? db.select({ id: PAY.id, reference: PAY.reference }).from(PAY).where(and(eq(PAY.tenantId, ctx.tenantId), inArray(PAY.id, paymentIds))) : [],
  ]);
  const invoiceNumber = new Map(invoices.map((i) => [i.id, i.number]));
  const paymentRef = new Map(payments.map((p) => [p.id, p.reference]));

  function label(p: (typeof postings)[number]): string {
    if (p.refType === 'invoice') return (p.refId && invoiceNumber.get(p.refId)) || p.refType;
    if (p.refType === 'payment') return (p.refId && paymentRef.get(p.refId)) || pack.labels.payment;
    if (p.refType === 'payment_void') return pack.labels.paymentVoid;
    return p.refType;
  }

  let balanceMinor = 0;
  const rows = postings.map((p) => {
    balanceMinor += p.amountMinor;
    return { id: p.id, bookedAt: p.bookedAt, kind: p.kind, fund: p.fund, amountMinor: p.amountMinor, balanceMinor, refType: p.refType, refId: p.refId, label: label(p) };
  });

  return { contact, building, rows, balanceMinor };
}
