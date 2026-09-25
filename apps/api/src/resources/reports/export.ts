import { type Db, schema } from '@domar/db';
import type { HandoverReportData } from '@domar/domain';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { strToU8, zipSync } from 'fflate';
import type { TenantContext } from '../../tenant-context.js';
import { listDocuments } from '../documents/repo.js';
import { listInvoices } from '../invoices/repo.js';
import { listPayments } from '../payments/repo.js';

const U = schema.units; const C = schema.contacts; const E = schema.expenses; const S = schema.suppliers;

/** Excel on a Macedonian Windows reads a `;` file as columns only when a BOM says it is UTF-8. */
const BOM = '﻿';
/** One page of rows is plenty for a building; 5000 is two centuries of monthly invoices. */
const PAGE = 5000;

/** The same rule `rowsToCanonicalCsv` uses: flatten a cell's own newlines, then quote `;` and `"`. */
function cell(value: string): string {
  const flat = value.replace(/\r\n|[\r\n]/g, ' ');
  return /[;"]/.test(flat) ? `"${flat.replace(/"/g, '""')}"` : flat;
}

function csv(header: string[], rows: (string | number | null)[][]): string {
  const line = (xs: (string | number | null)[]) => xs.map((x) => cell(x === null ? '' : String(x))).join(';');
  return `${BOM}${[line(header), ...rows.map(line)].join('\n')}\n`;
}

/** Minor units as a decimal with a comma, which is what a `;` file means in this locale. Integer arithmetic only. */
function money(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}
const day = (x: Date | string | null): string => (x === null ? '' : new Date(x).toISOString().slice(0, 10));

/**
 * Art. 30's "full export": everything the next manager needs to carry this building on, as seven
 * `;`-separated UTF-8 files in one archive (plan addendum 11). Metadata only — the documents
 * themselves stay where they are and are handed over through the document store.
 */
export async function buildHandoverExport(db: Db, ctx: TenantContext, buildingId: string, data: HandoverReportData): Promise<Buffer> {
  const ownerIds = data.owners.map((o) => o.contactId);
  const [units, contacts, invoices, payments, expenses, documents] = await Promise.all([
    db.select({ u: U, firstName: C.firstName, lastName: C.lastName, email: C.email }).from(U)
      .leftJoin(C, and(eq(C.id, U.ownerContactId), eq(C.tenantId, U.tenantId)))
      .where(and(eq(U.tenantId, ctx.tenantId), eq(U.buildingId, buildingId)))
      .orderBy(asc(U.floor), asc(U.label)),
    // Same guarded shape as `resources/contacts/statement.ts`: an empty `inArray` is not a query.
    ownerIds.length ? db.select().from(C).where(and(eq(C.tenantId, ctx.tenantId), inArray(C.id, ownerIds))).orderBy(asc(C.lastName), asc(C.firstName)) : [],
    listInvoices(db, ctx, { buildingId, page: 1, pageSize: PAGE }),
    listPayments(db, ctx, { buildingId, page: 1, pageSize: PAGE }),
    db.select({ e: E, supplierName: S.name }).from(E)
      .leftJoin(S, and(eq(S.id, E.supplierId), eq(S.tenantId, E.tenantId)))
      .where(and(eq(E.tenantId, ctx.tenantId), eq(E.buildingId, buildingId)))
      .orderBy(asc(E.paidAt), asc(E.id)),
    listDocuments(db, ctx, buildingId),
  ]);
  const unitsOf = new Map(data.owners.map((o) => [o.contactId, o.unitLabels.join(', ')]));

  const files: Record<string, Uint8Array> = {
    'edinici.csv': strToU8(csv(
      ['број', 'кат', 'тип', 'површина', 'удел', 'сопственик', 'е-пошта'],
      units.map((r) => [
        r.u.label, r.u.floor, r.u.kind, r.u.areaM2, r.u.ownershipShare,
        r.firstName === null ? '' : `${r.firstName} ${r.lastName}`.trim(), r.email,
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
      invoices.rows.map((i) => [
        i.number, i.period, `${i.contact.firstName} ${i.contact.lastName}`.trim(), day(i.issuedAt), day(i.dueAt),
        money(i.totalMinor), money(i.paidMinor), money(i.outstandingMinor), i.status,
      ]),
    )),
    'uplati.csv': strToU8(csv(
      ['датум', 'сопственик', 'фактура', 'износ', 'начин', 'референца', 'статус'],
      payments.rows.map((p) => [
        day(p.paidAt), `${p.contact.firstName} ${p.contact.lastName}`.trim(), p.invoice?.number ?? '',
        money(p.amountMinor), p.method, p.reference, p.status,
      ]),
    )),
    'troshoci.csv': strToU8(csv(
      ['датум', 'фонд', 'опис', 'добавувач', 'износ'],
      expenses.map((r) => [day(r.e.paidAt), r.e.fund, r.e.description, r.supplierName ?? r.e.supplierText, money(r.e.amountMinor)]),
    )),
    'dokumenti.csv': strToU8(csv(
      ['наслов', 'тип', 'датотека', 'мим-тип', 'големина', 'создаден', 'sha256'],
      documents.rows.map((d) => [d.title, d.kind, d.fileName, d.mime, d.sizeBytes, day(d.createdAt), d.sha256]),
    )),
  };
  return Buffer.from(zipSync(files, { level: 6 }));
}
