import { type Db, schema } from '@domar/db';
import { getCountryPack, type CountryCode } from '@domar/domain';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { notFound } from '../errors.js';
import { billedToOwners, fundBalance } from '../ledger.js';
import { renderInvoiceHtml } from '../pdf/invoice-html.js';
import { ownerStatement } from '../resources/contacts/statement.js';
import { getInvoice, listInvoices, type InvoiceStatus } from '../resources/invoices/repo.js';
import { listPayments } from '../resources/payments/repo.js';
import type { TenantContext } from '../tenant-context.js';
import { portalTenantContext } from './accounts.js';
import type { PortalContext } from './context.js';

const P = schema.postings; const E = schema.expenses; const U = schema.units; const B = schema.buildings; const T = schema.tenants; const DOC = schema.documents;

/** What the manager has published, and nothing before that. A draft is invisible, not forbidden. */
const VISIBLE_STATUSES: InvoiceStatus[] = ['published', 'partially_paid', 'paid', 'cancelled'];
const FUND_WINDOW_MS = 365 * 24 * 3600 * 1000;
/** A twelve-month window is small in practice; the cap keeps a pathological building from paging the whole ledger into one response. */
const FUND_TX_LIMIT = 500;

/**
 * Turns a request's `contactId` into a tenant — the only place that happens. The id must match one
 * of the caller's links; anything else is a 404, never a 403, so the portal never confirms that an
 * id exists in a tenant the caller has no link in (spec §19.6).
 */
export function resolveLink(portal: PortalContext, contactId: string): { ctx: TenantContext; contactId: string } {
  const link = portal.links.find((l) => l.contactId === contactId);
  if (!link) throw notFound('Contact');
  return { ctx: portalTenantContext(link.tenantId), contactId: link.contactId };
}

/**
 * Art. 45(4) is an owner's right about *their* building: a link alone is not enough, the contact has
 * to own a unit in it. Anything else is a 404, so a linked owner cannot enumerate the manager's
 * other buildings.
 */
export async function assertOwnsUnitIn(db: Db, ctx: TenantContext, contactId: string, buildingId: string): Promise<void> {
  const [owned] = await db.select({ id: U.id }).from(U)
    .where(and(eq(U.tenantId, ctx.tenantId), eq(U.buildingId, buildingId), eq(U.ownerContactId, contactId))).limit(1);
  if (!owned) throw notFound('Building');
}

export async function portalInvoices(db: Db, portal: PortalContext, q: { contactId: string; page: number; pageSize: number; status?: InvoiceStatus | undefined }) {
  const { ctx, contactId } = resolveLink(portal, q.contactId);
  // One of the visible statuses, never `draft`: the query schema only admits the four visible ones.
  const statuses = q.status ? [q.status] : VISIBLE_STATUSES;
  const { rows, total } = await listInvoices(db, ctx, { contactId, statuses, page: q.page, pageSize: q.pageSize });
  return { rows, total };
}

async function visibleInvoice(db: Db, ctx: TenantContext, contactId: string, id: string) {
  const invoice = await getInvoice(db, ctx, id); // 404 across tenants
  // The invoice is this tenant's; it still has to be *this owner's*, and still published.
  if (invoice.contactId !== contactId || !VISIBLE_STATUSES.includes(invoice.status)) throw notFound('Invoice');
  return invoice;
}

export async function portalInvoice(db: Db, portal: PortalContext, contactIdParam: string, id: string) {
  const { ctx, contactId } = resolveLink(portal, contactIdParam);
  return visibleInvoice(db, ctx, contactId, id);
}

/** The manager's renderer, the manager's tenant header (spec §19.4: "same renderer as the manager's"). */
export async function portalInvoiceHtml(db: Db, portal: PortalContext, contactIdParam: string, id: string) {
  const { ctx, contactId } = resolveLink(portal, contactIdParam);
  const invoice = await visibleInvoice(db, ctx, contactId, id);
  const tenant = (await db.query.tenants.findFirst({ where: eq(T.id, ctx.tenantId) }))!;
  const pack = getCountryPack(tenant.countryCode as CountryCode);
  return { html: renderInvoiceHtml({ invoice, tenant, formatMoney: pack.formatMoney, locale: 'mk' }), invoice };
}

export async function portalPayments(db: Db, portal: PortalContext, q: { contactId: string; page: number; pageSize: number }) {
  const { ctx, contactId } = resolveLink(portal, q.contactId);
  const { rows, total } = await listPayments(db, ctx, { contactId, page: q.page, pageSize: q.pageSize });
  return { rows, total };
}

export async function portalStatement(db: Db, portal: PortalContext, contactIdParam: string, buildingId?: string | undefined) {
  const { ctx, contactId } = resolveLink(portal, contactIdParam);
  // Narrowing to a building is only allowed for a building the contact owns a unit in, so the filter
  // cannot be used to read back the names of the manager's other buildings.
  if (buildingId) await assertOwnsUnitIn(db, ctx, contactId, buildingId);
  return ownerStatement(db, ctx, contactId, buildingId);
}

/**
 * Art. 45(4): the money in the building's two funds, plus the fund-account movements of the last
 * twelve months. Owner `charge` postings are per-owner rows and are deliberately not listed — what
 * was billed to owners is reported as one number per fund instead (design addendum 15).
 */
export async function portalBuildingFund(db: Db, portal: PortalContext, contactIdParam: string, buildingId: string) {
  const { ctx, contactId } = resolveLink(portal, contactIdParam);
  const [building] = await db.select({ id: B.id, name: B.name }).from(B)
    .where(and(eq(B.tenantId, ctx.tenantId), eq(B.id, buildingId))).limit(1);
  if (!building) throw notFound('Building');
  await assertOwnsUnitIn(db, ctx, contactId, buildingId);

  const since = new Date(Date.now() - FUND_WINDOW_MS);
  const [regularBalance, reserveBalance, regularBilled, reserveBilled, rows] = await Promise.all([
    fundBalance(db, ctx, buildingId, 'regular'),
    fundBalance(db, ctx, buildingId, 'reserve'),
    billedToOwners(db, ctx, buildingId, 'regular'),
    billedToOwners(db, ctx, buildingId, 'reserve'),
    db.select({ p: P, description: E.description }).from(P)
      .leftJoin(E, and(eq(E.id, P.refId), eq(E.tenantId, P.tenantId), inArray(P.refType, ['expense', 'expense_void'])))
      .where(and(eq(P.tenantId, ctx.tenantId), eq(P.buildingId, buildingId), eq(P.account, 'fund'), gte(P.bookedAt, since)))
      .orderBy(desc(P.bookedAt), desc(P.createdAt)).limit(FUND_TX_LIMIT + 1), // one extra row answers "is there more?"
  ]);

  return {
    building,
    regular: { balanceMinor: regularBalance, billedMinor: regularBilled },
    reserve: { balanceMinor: reserveBalance, billedMinor: reserveBilled },
    transactions: rows.slice(0, FUND_TX_LIMIT).map((r) => ({
      id: r.p.id, kind: r.p.kind, fund: r.p.fund, amountMinor: r.p.amountMinor, bookedAt: r.p.bookedAt,
      description: r.description ?? null,
    })),
    truncated: rows.length > FUND_TX_LIMIT,
  };
}

/**
 * Spec §11: the portal sees minutes and reports of buildings the contact owns a unit in, and nothing
 * else. A tenant-level document (`building_id is null`) is never visible here.
 */
const PORTAL_DOCUMENT_KINDS = ['minutes', 'report'] as const;

export async function portalDocuments(db: Db, portal: PortalContext, q: { contactId: string; buildingId: string }) {
  const { ctx, contactId } = resolveLink(portal, q.contactId);
  await assertOwnsUnitIn(db, ctx, contactId, q.buildingId);
  const rows = await db.select({
    id: DOC.id, buildingId: DOC.buildingId, kind: DOC.kind, title: DOC.title,
    fileName: DOC.fileName, mime: DOC.mime, sizeBytes: DOC.sizeBytes, createdAt: DOC.createdAt,
  }).from(DOC)
    .where(and(eq(DOC.tenantId, ctx.tenantId), eq(DOC.buildingId, q.buildingId), inArray(DOC.kind, [...PORTAL_DOCUMENT_KINDS])))
    .orderBy(desc(DOC.createdAt), desc(DOC.id));
  // `building_id` is the one the caller was cleared for, so it is never null here.
  return { rows: rows.map((r) => ({ ...r, buildingId: q.buildingId, kind: r.kind as (typeof PORTAL_DOCUMENT_KINDS)[number] })) };
}

/** The same three checks as the list, applied to one document, before its bytes are opened. */
export async function portalDocumentFile(db: Db, portal: PortalContext, contactIdParam: string, id: string) {
  const { ctx, contactId } = resolveLink(portal, contactIdParam);
  const [row] = await db.select().from(DOC).where(and(eq(DOC.tenantId, ctx.tenantId), eq(DOC.id, id))).limit(1);
  if (!row || row.buildingId === null || !PORTAL_DOCUMENT_KINDS.includes(row.kind as (typeof PORTAL_DOCUMENT_KINDS)[number])) throw notFound('Document');
  await assertOwnsUnitIn(db, ctx, contactId, row.buildingId);
  return row;
}
