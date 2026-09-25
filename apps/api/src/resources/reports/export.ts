import { type Db, schema } from '@domar/db';
import { csvCell, type HandoverReportData } from '@domar/domain';
import { and, asc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { strToU8, zipSync } from 'fflate';
import type { TenantContext } from '../../tenant-context.js';
import { dayIn } from '../common.js';
import { listDocuments } from '../documents/repo.js';
import { listInvoices } from '../invoices/repo.js';
import { listPayments } from '../payments/repo.js';

const U = schema.units; const C = schema.contacts; const E = schema.expenses; const S = schema.suppliers;
const PAY = schema.payments;

/** Excel on a Macedonian Windows reads a `;` file as columns only when a BOM says it is UTF-8. */
const BOM = '﻿';
/** One page of rows; a building never has this many, and the loop below pages anyway. */
const PAGE = 5000;
/** What a reversed row is called in the two files that can carry one. */
const STATUS = { active: 'активна', voided: 'сторнирана' } as const;

function csv(header: string[], rows: (string | number | null)[][]): string {
  const line = (xs: (string | number | null)[]) => xs.map((x) => csvCell(x === null ? '' : String(x))).join(';');
  return `${BOM}${[line(header), ...rows.map(line)].join('\n')}\n`;
}

/** A `numeric` column with the comma decimal every other number in these files uses. */
function decimal(x: string | null): string {
  return x === null ? '' : x.replace('.', ',');
}

/** Minor units as a decimal with a comma, which is what a `;` file means in this locale. Integer arithmetic only. */
function money(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

/**
 * The status the invoice had on the handover day, read off its own money rather than off today's
 * column: a file that says nothing was paid must not also say the invoice is settled.
 */
function statusAt(status: string, totalMinor: number, paidMinor: number): string {
  if (status === 'cancelled' || status === 'draft') return status;
  if (paidMinor >= totalMinor) return 'paid';
  return paidMinor > 0 ? 'partially_paid' : 'published';
}

/**
 * Every page of a paged repo list. A handover that silently stopped at the first page would hand the
 * next manager a file that looks complete and is not, which is the one failure this export cannot have.
 */
async function allRows<T>(pageSize: number, fetch: (page: number) => Promise<{ rows: T[]; total: number }>): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const { rows, total } = await fetch(page);
    out.push(...rows);
    if (rows.length < pageSize || out.length >= total) return out;
  }
}

export interface HandoverExportOptions {
  /** The exclusive end of the handover window: nothing booked after it belongs in this archive. */
  to: Date;
  /** The tenant's zone, so every date is the civil day it was on for the manager. */
  timeZone: string;
  /** One page of rows; the default is far past any real building and the tests shrink it. */
  pageSize?: number | undefined;
}

/**
 * Art. 30's "full export": everything the next manager needs to carry this building on, as seven
 * `;`-separated UTF-8 files in one archive (plan addendum 11). Metadata only — the documents
 * themselves stay where they are and are handed over through the document store. Money and dates are
 * read as of the handover day, so a payment made after it is not in the archive and not in its sums.
 */
export async function buildHandoverExport(
  db: Db, ctx: TenantContext, buildingId: string, data: HandoverReportData, opts: HandoverExportOptions,
): Promise<Buffer> {
  const { to, timeZone } = opts;
  const pageSize = opts.pageSize ?? PAGE;
  const day = dayIn(timeZone);
  const ownerIds = data.owners.map((o) => o.contactId);
  const [units, contacts, invoices, payments, paidByInvoice, expenses, documents] = await Promise.all([
    db.select({ u: U, firstName: C.firstName, lastName: C.lastName, email: C.email, phone: C.phone }).from(U)
      .leftJoin(C, and(eq(C.id, U.ownerContactId), eq(C.tenantId, U.tenantId)))
      .where(and(eq(U.tenantId, ctx.tenantId), eq(U.buildingId, buildingId)))
      .orderBy(asc(U.floor), asc(U.label)),
    // Same guarded shape as `resources/contacts/statement.ts`: an empty `inArray` is not a query.
    ownerIds.length ? db.select().from(C).where(and(eq(C.tenantId, ctx.tenantId), inArray(C.id, ownerIds))).orderBy(asc(C.lastName), asc(C.firstName)) : [],
    allRows(pageSize, (page) => listInvoices(db, ctx, { buildingId, page, pageSize })),
    allRows(pageSize, (page) => listPayments(db, ctx, { buildingId, to: to.toISOString(), page, pageSize })),
    // What each invoice had actually been paid by the handover day; `listInvoices` counts every
    // payment ever made, which for a backdated handover is money the outgoing manager never saw.
    db.select({ invoiceId: PAY.invoiceId, paid: sql<string>`coalesce(sum(${PAY.amountMinor}), 0)` }).from(PAY)
      .where(and(
        eq(PAY.tenantId, ctx.tenantId), eq(PAY.buildingId, buildingId), eq(PAY.status, 'completed'),
        isNotNull(PAY.invoiceId), lt(PAY.paidAt, to),
      ))
      .groupBy(PAY.invoiceId),
    db.select({ e: E, supplierName: S.name }).from(E)
      .leftJoin(S, and(eq(S.id, E.supplierId), eq(S.tenantId, E.tenantId)))
      .where(and(eq(E.tenantId, ctx.tenantId), eq(E.buildingId, buildingId), lt(E.paidAt, to)))
      .orderBy(asc(E.paidAt), asc(E.id)),
    listDocuments(db, ctx, buildingId),
  ]);
  const unitsOf = new Map(data.owners.map((o) => [o.contactId, o.unitLabels.join(', ')]));
  const paid = new Map(paidByInvoice.map((r) => [r.invoiceId!, Number(r.paid)]));
  // An invoice issued after the handover is the next manager's, not a line of this archive.
  const issued = invoices.filter((i) => i.issuedAt !== null && i.issuedAt.getTime() < to.getTime());

  const files: Record<string, Uint8Array> = {
    // The units import's own column names, in its own order: the archive the next manager gets is
    // the file they can feed straight back into the units import (plan addendum 11).
    'edinici.csv': strToU8(csv(
      ['број', 'кат', 'тип', 'површина', 'удел', 'име', 'презиме', 'е-пошта', 'телефон'],
      units.map((r) => [
        r.u.label, r.u.floor, r.u.kind, decimal(r.u.areaM2), decimal(r.u.ownershipShare),
        r.firstName, r.lastName, r.email, r.phone,
      ]),
    )),
    'sopstvenici.csv': strToU8(csv(
      ['име', 'презиме', 'е-пошта', 'телефон', 'адреса', 'единици'],
      contacts.map((c) => [c.firstName, c.lastName, c.email, c.phone, c.address, unitsOf.get(c.id) ?? '']),
    )),
    'salda.csv': strToU8(csv(
      ['сопственик', 'единици', 'фактурирано', 'наплатено', 'салдо'],
      data.owners.map((o) => [o.name, o.unitLabels.join(', '), money(o.billedMinor), money(o.collectedMinor), money(o.balanceMinor)]),
    )),
    'presmetki.csv': strToU8(csv(
      ['број', 'период', 'сопственик', 'издадена', 'рок', 'вкупно', 'платено', 'неплатено', 'статус'],
      issued.map((i) => {
        const paidMinor = paid.get(i.id) ?? 0;
        return [
          i.number, i.period, `${i.contact.firstName} ${i.contact.lastName}`.trim(), day(i.issuedAt), day(i.dueAt),
          money(i.totalMinor), money(paidMinor), money(Math.max(0, i.totalMinor - paidMinor)),
          statusAt(i.status, i.totalMinor, paidMinor),
        ];
      }),
    )),
    'uplati.csv': strToU8(csv(
      ['датум', 'сопственик', 'фактура', 'износ', 'начин', 'референца', 'статус'],
      payments.map((p) => [
        day(p.paidAt), `${p.contact.firstName} ${p.contact.lastName}`.trim(), p.invoice?.number ?? '',
        money(p.amountMinor), p.method, p.reference, p.status,
      ]),
    )),
    'troshoci.csv': strToU8(csv(
      // A reversed expense is carried, not dropped: the next manager sees the money left and came
      // back, and the status is read as of the handover day like every other figure here.
      ['датум', 'фонд', 'опис', 'добавувач', 'износ', 'статус'],
      expenses.map((r) => [
        day(r.e.paidAt), r.e.fund, r.e.description, r.supplierName ?? r.e.supplierText, money(r.e.amountMinor),
        r.e.voidedAt !== null && r.e.voidedAt.getTime() < to.getTime() ? STATUS.voided : STATUS.active,
      ]),
    )),
    'dokumenti.csv': strToU8(csv(
      ['наслов', 'тип', 'датотека', 'мим-тип', 'големина', 'создаден', 'sha256'],
      documents.rows.map((d) => [d.title, d.kind, d.fileName, d.mime, d.sizeBytes, day(d.createdAt), d.sha256]),
    )),
  };
  return Buffer.from(zipSync(files, { level: 6 }));
}
