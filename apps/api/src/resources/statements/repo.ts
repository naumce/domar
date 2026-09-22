import { createHash } from 'node:crypto';
import { type Db, schema } from '@domar/db';
import { type CountryCode, detectStatementParser, getCountryPack, type MatchCandidate, matchStatementLines, type ParsedStatementLine } from '@domar/domain';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import { recordPayment, voidPayment } from '../payments/service.js';
import type { ImportBody } from './schema.js';

const BS = schema.bankStatements; const SL = schema.statementLines; const INV = schema.invoices; const C = schema.contacts; const PAY = schema.payments;
const MAX_BYTES = 2 * 1024 * 1024; const MAX_LINES = 5000;
const OPEN_STATUSES = ['published', 'partially_paid'] as const;
const CLAIMABLE = ['unmatched', 'suggested'] as const;
const REOPENABLE = ['matched', 'ignored'] as const;

// "invoices"."id"/"tenant_id" are hard-coded rather than interpolated: drizzle qualifies columns
// inside raw sql by the surrounding select, and an unqualified `id` would bind to the subquery's row.
const paidMinorSql = sql<string>`(select coalesce(sum(p.amount_minor), 0) from ${PAY} p where p.tenant_id = "invoices"."tenant_id" and p.invoice_id = "invoices"."id" and p.status = 'completed')`;

const fingerprint = (l: ParsedStatementLine) => createHash('sha256').update(`${l.bookedAt}|${l.amountMinor}|${l.reference}|${l.counterparty}`).digest('hex');
/** Bank statements carry a date, not a time; noon UTC keeps the day stable in either direction of the local offset. */
const noon = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

const lineSelect = {
  l: SL,
  invoice: { id: INV.id, number: INV.number, totalMinor: INV.totalMinor, lastName: C.lastName },
  paidMinor: paidMinorSql,
  payment: { id: PAY.id, amountMinor: PAY.amountMinor, status: PAY.status },
};
// Left-joined columns come back nullable, so the joined halves are narrowed on their id below.
type LineRow = {
  l: typeof SL.$inferSelect;
  invoice: { id: string | null; number: string | null; totalMinor: number | null; lastName: string | null } | null;
  paidMinor: string;
  payment: { id: string | null; amountMinor: number | null; status: typeof PAY.$inferSelect.status | null } | null;
};

function lineQuery(db: Db, ctx: TenantContext) {
  return db.select(lineSelect).from(SL)
    .leftJoin(INV, and(eq(INV.id, SL.suggestedInvoiceId), eq(INV.tenantId, ctx.tenantId)))
    .leftJoin(C, eq(C.id, INV.contactId))
    .leftJoin(PAY, and(eq(PAY.id, SL.paymentId), eq(PAY.tenantId, ctx.tenantId)));
}

function toLineOut(r: LineRow) {
  const inv = r.invoice; const pay = r.payment;
  return {
    ...r.l,
    suggestedInvoice: inv?.id ? { id: inv.id, number: inv.number, contactLastName: inv.lastName ?? '', outstandingMinor: Math.max(0, (inv.totalMinor ?? 0) - Number(r.paidMinor)) } : null,
    payment: pay?.id ? { id: pay.id, amountMinor: pay.amountMinor ?? 0, status: pay.status ?? 'completed' } : null,
  };
}

async function getLine(db: Db, ctx: TenantContext, id: string) {
  const [r] = await lineQuery(db, ctx).where(and(eq(SL.tenantId, ctx.tenantId), eq(SL.id, id))).limit(1);
  if (!r) throw notFound('Statement line');
  return toLineOut(r);
}

/** The building's open invoices as matching candidates, with their live outstanding amount. */
async function openInvoices(db: Db, ctx: TenantContext, buildingId: string): Promise<MatchCandidate[]> {
  const rows = await db.select({ id: INV.id, number: INV.number, totalMinor: INV.totalMinor, lastName: C.lastName, paidMinor: paidMinorSql })
    .from(INV).innerJoin(C, eq(C.id, INV.contactId))
    .where(and(eq(INV.tenantId, ctx.tenantId), eq(INV.buildingId, buildingId), inArray(INV.status, [...OPEN_STATUSES])));
  return rows.map((r) => ({ invoiceId: r.id, number: r.number ?? '', contactLastName: r.lastName, outstandingMinor: Math.max(0, r.totalMinor - Number(r.paidMinor)) }));
}

export async function listStatements(db: Db, ctx: TenantContext, buildingId: string) {
  await getBuilding(db, ctx, buildingId);
  const rows = await db.select().from(BS).where(and(eq(BS.tenantId, ctx.tenantId), eq(BS.buildingId, buildingId))).orderBy(desc(BS.importedAt), desc(BS.id));
  return { rows };
}

export async function getStatement(db: Db, ctx: TenantContext, id: string) {
  const statement = await db.query.bankStatements.findFirst({ where: and(eq(BS.tenantId, ctx.tenantId), eq(BS.id, id)) });
  if (!statement) throw notFound('Statement');
  const rows = await lineQuery(db, ctx).where(and(eq(SL.tenantId, ctx.tenantId), eq(SL.statementId, id))).orderBy(asc(SL.lineNo));
  return { ...statement, lines: rows.map(toLineOut) };
}

export async function importStatement(db: Db, ctx: TenantContext, buildingId: string, input: ImportBody) {
  if (Buffer.byteLength(input.content, 'utf8') > MAX_BYTES) throw badRequest('too_large', 'Statement file exceeds 2 MB');
  return db.transaction(async (tx) => {
    await getBuilding(tx, ctx, buildingId);
    const tenant = await tx.query.tenants.findFirst({ where: eq(schema.tenants.id, ctx.tenantId), columns: { countryCode: true } });
    const pack = getCountryPack(tenant!.countryCode as CountryCode);
    const parser = detectStatementParser(input.content, pack);
    if (!parser) throw badRequest('unknown_format', 'Statement format not recognised (MT940 or CSV with date/amount columns)');
    const parsed = parser.parse(input.content, pack.parseAmountToMinor);
    if (parsed.lines.length > MAX_LINES) throw badRequest('too_many_lines', `Statement has more than ${MAX_LINES} lines`);
    const [statement] = await tx.insert(BS).values({
      tenantId: ctx.tenantId, buildingId, filename: input.filename, format: parsed.format, accountNumber: parsed.accountNumber, createdBy: ctx.userId,
    }).returning();

    // A line already imported for this building (same date, amount, reference and counterparty) is
    // skipped; the seen set also covers repeats inside the file itself, which the unique index rejects.
    const seen = new Set((await tx.select({ fp: SL.fingerprint }).from(SL).where(and(eq(SL.tenantId, ctx.tenantId), eq(SL.buildingId, buildingId)))).map((r) => r.fp));
    const fresh: { line: ParsedStatementLine; fp: string }[] = [];
    for (const line of parsed.lines) {
      const fp = fingerprint(line);
      if (seen.has(fp)) continue;
      seen.add(fp);
      fresh.push({ line, fp });
    }
    const inserted = fresh.length
      ? await tx.insert(SL).values(fresh.map(({ line, fp }, i) => ({
        tenantId: ctx.tenantId, statementId: statement!.id, buildingId, lineNo: i + 1, bookedAt: noon(line.bookedAt), amountMinor: line.amountMinor,
        counterparty: line.counterparty || null, reference: line.reference || null, raw: line.raw, fingerprint: fp,
      }))).onConflictDoNothing({ target: [SL.buildingId, SL.fingerprint] }).returning()
      : [];
    // The unique index has the last word: a concurrent import of the same file can land lines
    // between the pre-check and this insert, and those come back as skipped rather than as a 23505.
    const skipped = parsed.lines.length - inserted.length;

    // Match on what was actually inserted, so the result indices line up with `inserted`.
    const byFingerprint = new Map(fresh.map(({ line, fp }) => [fp, line]));
    const candidates = await openInvoices(tx, ctx, buildingId);
    let matched = 0;
    for (const m of matchStatementLines(inserted.map((r) => byFingerprint.get(r.fingerprint)!), candidates)) {
      const line = inserted[m.index]!;
      await tx.update(SL).set({ matchStatus: 'suggested', confidence: m.confidence, suggestedInvoiceId: m.invoiceId }).where(and(eq(SL.tenantId, ctx.tenantId), eq(SL.id, line.id)));
      if (m.confidence !== 'exact' || input.autoConfirm === false) continue;
      const { payment } = await recordPayment(tx, ctx, {
        invoiceId: m.invoiceId, amountMinor: line.amountMinor, method: 'bank_transfer', paidAt: line.bookedAt, reference: line.reference, statementLineId: line.id,
      });
      await tx.update(SL).set({ matchStatus: 'matched', paymentId: payment.id }).where(and(eq(SL.tenantId, ctx.tenantId), eq(SL.id, line.id)));
      matched++;
    }

    await tx.update(BS).set({ lineCount: inserted.length, matchedCount: matched, skippedCount: skipped }).where(and(eq(BS.tenantId, ctx.tenantId), eq(BS.id, statement!.id)));
    await writeAudit(tx, ctx, { action: 'statement.import', entityType: 'bank_statement', entityId: statement!.id, after: { filename: input.filename, format: parsed.format, lines: inserted.length, matched, skipped, warnings: parsed.warnings } });
    return { ...(await getStatement(tx, ctx, statement!.id)), warnings: parsed.warnings };
  });
}

/** Claims an open line for `next`; 404s when it is not this tenant's and 409s when it is already settled. */
async function claimLine(tx: Db, ctx: TenantContext, id: string, next: typeof SL.$inferSelect.matchStatus) {
  const [claimed] = await tx.update(SL).set({ matchStatus: next })
    .where(and(eq(SL.tenantId, ctx.tenantId), eq(SL.id, id), inArray(SL.matchStatus, [...CLAIMABLE]))).returning();
  if (claimed) return claimed;
  const exists = await tx.query.statementLines.findFirst({ where: and(eq(SL.tenantId, ctx.tenantId), eq(SL.id, id)), columns: { id: true } });
  if (!exists) throw notFound('Statement line');
  throw conflict('line_not_open', 'Statement line is already matched or ignored');
}

export async function confirmLine(db: Db, ctx: TenantContext, id: string, invoiceId: string) {
  return db.transaction(async (tx) => {
    const line = await tx.query.statementLines.findFirst({ where: and(eq(SL.tenantId, ctx.tenantId), eq(SL.id, id)) });
    if (!line) throw notFound('Statement line');
    // A settled line is rejected before the invoice checks, so re-confirming reads as a conflict
    // rather than as a complaint about the (by then fully paid) invoice.
    if (!CLAIMABLE.includes(line.matchStatus as (typeof CLAIMABLE)[number])) throw conflict('line_not_open', 'Statement line is already matched or ignored');
    if (line.amountMinor <= 0) throw badRequest('not_a_credit', 'Only incoming (credit) lines can be matched to an invoice');
    const invoice = await tx.query.invoices.findFirst({ where: and(eq(INV.tenantId, ctx.tenantId), eq(INV.id, invoiceId)), columns: { id: true, status: true, buildingId: true } });
    if (!invoice || invoice.buildingId !== line.buildingId || !OPEN_STATUSES.includes(invoice.status as (typeof OPEN_STATUSES)[number])) {
      throw badRequest('invalid_reference', 'invoiceId is not an open invoice of this building');
    }
    const claimed = await claimLine(tx, ctx, id, 'matched');
    const { payment } = await recordPayment(tx, ctx, {
      invoiceId, amountMinor: claimed.amountMinor, method: 'bank_transfer', paidAt: claimed.bookedAt, reference: claimed.reference, statementLineId: claimed.id,
    });
    await tx.update(SL).set({ paymentId: payment.id, confidence: 'manual' }).where(and(eq(SL.tenantId, ctx.tenantId), eq(SL.id, id)));
    await writeAudit(tx, ctx, { action: 'statement_line.confirm', entityType: 'statement_line', entityId: id, before: line, after: { invoiceId, paymentId: payment.id } });
    return getLine(tx, ctx, id);
  });
}

export async function ignoreLine(db: Db, ctx: TenantContext, id: string) {
  return db.transaction(async (tx) => {
    const claimed = await claimLine(tx, ctx, id, 'ignored');
    await writeAudit(tx, ctx, { action: 'statement_line.ignore', entityType: 'statement_line', entityId: id, after: claimed });
    return getLine(tx, ctx, id);
  });
}

export async function unmatchLine(db: Db, ctx: TenantContext, id: string) {
  return db.transaction(async (tx) => {
    // Claim the line first, so a concurrent unmatch loses here instead of voiding the payment twice.
    // `payment_id` is left to voidPayment: clearing it here would hide the id RETURNING must hand back.
    const [claimed] = await tx.update(SL).set({ matchStatus: 'unmatched', confidence: null })
      .where(and(eq(SL.tenantId, ctx.tenantId), eq(SL.id, id), inArray(SL.matchStatus, [...REOPENABLE]))).returning();
    if (!claimed) {
      const exists = await tx.query.statementLines.findFirst({ where: and(eq(SL.tenantId, ctx.tenantId), eq(SL.id, id)), columns: { id: true } });
      if (!exists) throw notFound('Statement line');
      throw conflict('line_not_matched', 'Only matched or ignored lines can be reopened');
    }
    if (claimed.paymentId) await voidPayment(tx, ctx, claimed.paymentId, 'unmatched');
    await writeAudit(tx, ctx, { action: 'statement_line.unmatch', entityType: 'statement_line', entityId: id, before: claimed });
    return getLine(tx, ctx, id);
  });
}
