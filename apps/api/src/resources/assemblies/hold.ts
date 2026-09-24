import { type Db, schema } from '@domar/db';
import { ownerWeight, tallyDecision } from '@domar/domain';
import { and, eq, inArray } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { documentStorageKey } from '../../documents/store.js';
import { AppError, badRequest } from '../../errors.js';
import { recordLegalEvent } from '../../legal-events.js';
import { formatAssemblyDate } from '../../pdf/assembly-invitation-html.js';
import { renderAssemblyMinutesHtml } from '../../pdf/assembly-minutes-html.js';
import { htmlToPdf } from '../../pdf/html-to-pdf.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import { createDocumentFromBuffer } from '../documents/repo.js';
import { assemblyOwners, claimAssembly, getAssembly, listDecisionRows, publicAssembly, tenantPack } from './repo.js';
import type { HoldBody } from './schema.js';
import type { AssemblyRuntime } from './service.js';

const A = schema.assemblies; const AD = schema.assemblyDecisions; const AT = schema.assemblyAttendance;
const AV = schema.assemblyVotes; const C = schema.contacts;

/**
 * Art. 37, the whole closing act in one transaction (plan addendum 13): the window shuts, every
 * decision is tallied against the basis the assembly was called with, the minutes are rendered and
 * filed as a `minutes` document, and `assembly_held` records the figures. If the PDF renderer is
 * unavailable the transaction rolls back and the assembly stays `invited` — an assembly that is
 * `held` with no minutes would be a record that lies.
 */
export async function holdAssembly(db: Db, ctx: TenantContext, id: string, input: HoldBody, rt: AssemblyRuntime) {
  return db.transaction(async (tx) => {
    const claimed = await claimAssembly(tx, ctx, id, ['invited']);
    const building = await getBuilding(tx, ctx, claimed.buildingId);
    const { tenant, pack } = await tenantPack(tx, ctx);
    // Plan addendum 15: the day the invitation announced, unless the manager says otherwise.
    const heldAt = input.heldAt ? new Date(input.heldAt) : claimed.scheduledAt;
    if (claimed.invitedAt && heldAt.getTime() < claimed.invitedAt.getTime()) {
      throw badRequest('held_before_invited', 'An assembly cannot have been held before it was called');
    }

    const owners = await assemblyOwners(tx, ctx, claimed.buildingId, claimed.quorumBasis);
    const ownerIds = new Set(owners.map((o) => o.contactId));
    const strangers = input.attendance.filter((r) => !ownerIds.has(r.contactId)).map((r) => r.contactId);
    if (strangers.length > 0) {
      throw badRequest('invalid_reference', 'The attendance sheet names somebody who owns no unit in this building', { contactIds: strangers });
    }

    const decisions = await listDecisionRows(tx, ctx, id);
    const votes = await tx.select().from(AV).where(and(eq(AV.tenantId, ctx.tenantId), eq(AV.assemblyId, id)));

    // Plan addendum 7: casting a vote is participating, so every voter is present whatever the sheet says.
    const voted = new Set(votes.filter((v) => ownerIds.has(v.contactId)).map((v) => v.contactId));
    const sheet = new Map(input.attendance.map((r) => [r.contactId, r]));
    const attendance = owners.map((o) => ({
      contactId: o.contactId,
      present: voted.has(o.contactId) || (sheet.get(o.contactId)?.present ?? false),
      proxyName: sheet.get(o.contactId)?.proxyName ?? null,
      weightBp: ownerWeight(claimed.quorumBasis, o),
    }));

    // An empty ballot gives the assembly-level quorum figures, identical for every decision.
    const quorum = tallyDecision(claimed.quorumBasis, owners, attendance, []);
    const tallies = decisions.map((decision) => ({
      decision,
      tally: tallyDecision(claimed.quorumBasis, owners, attendance,
        votes.filter((v) => v.decisionId === decision.id).map((v) => ({ contactId: v.contactId, choice: v.choice }))),
    }));

    await tx.insert(AT).values(attendance.map((r) => ({
      tenantId: ctx.tenantId, assemblyId: id, contactId: r.contactId, present: r.present, proxyName: r.proxyName, weightBp: r.weightBp,
    })));
    for (const { decision, tally } of tallies) {
      await tx.update(AD).set({
        forWeight: tally.for, againstWeight: tally.against, abstainWeight: tally.abstain,
        presentWeight: tally.present, basisTotal: tally.basisTotal, quorumReached: tally.quorumReached,
        result: tally.result, updatedAt: new Date(),
      }).where(and(eq(AD.tenantId, ctx.tenantId), eq(AD.id, decision.id)));
    }

    const contacts = await tx.select({ id: C.id, firstName: C.firstName, lastName: C.lastName }).from(C)
      .where(and(eq(C.tenantId, ctx.tenantId), inArray(C.id, owners.map((o) => o.contactId))));
    const nameOf = new Map(contacts.map((c) => [c.id, `${c.firstName} ${c.lastName}`.trim()]));
    const minutesHtml = renderAssemblyMinutesHtml({
      tenant, building, scheduledAt: claimed.scheduledAt, heldAt, location: claimed.location,
      agenda: claimed.agenda, quorumBasis: claimed.quorumBasis,
      quorum: { present: quorum.present, basisTotal: quorum.basisTotal, quorumReached: quorum.quorumReached },
      attendance: attendance.map((r) => ({ name: nameOf.get(r.contactId) ?? '', present: r.present, proxyName: r.proxyName, weightBp: r.weightBp })),
      decisions: tallies.map(({ decision, tally }) => ({
        title: decision.title, text: decision.text, for: tally.for, against: tally.against, abstain: tally.abstain, result: tally.result,
      })),
      labels: { assemblyLegal: pack.labels.assemblyLegal },
      timeZone: tenant.timezone, locale: 'mk',
    });

    let pdf: Buffer;
    try {
      pdf = await htmlToPdf(minutesHtml, rt.pdfBrowserChannel);
    } catch (err) {
      rt.log.warn({ err, assemblyId: id }, 'assembly minutes pdf render failed; the hold is rolled back');
      throw new AppError(503, 'pdf_unavailable', 'PDF rendering is not available on this server');
    }
    const document = await createDocumentFromBuffer(tx, ctx, rt.documents, {
      buildingId: claimed.buildingId, kind: 'minutes',
      title: `Записник од собир — ${formatAssemblyDate(heldAt, tenant.timezone)}`,
      fileName: `zapisnik-${id}.pdf`, mime: 'application/pdf', content: pdf,
    });

    try {
      await tx.update(A).set({ status: 'held', heldAt, minutesHtml, minutesDocumentId: document.id, updatedAt: new Date() })
        .where(and(eq(A.tenantId, ctx.tenantId), eq(A.id, id)));
      await recordLegalEvent(tx, ctx, {
        buildingId: claimed.buildingId, kind: 'assembly_held', refType: 'assembly', refId: id, occurredAt: heldAt,
        evidence: {
          assemblyId: id, heldAt: heldAt.toISOString(), quorumReached: quorum.quorumReached,
          present: quorum.present, basisTotal: quorum.basisTotal, quorumBasis: claimed.quorumBasis,
          decisions: tallies.map(({ decision, tally }) => ({ id: decision.id, result: tally.result })),
          minutesDocumentId: document.id,
        },
      });
      await writeAudit(tx, ctx, {
        action: 'assembly.hold', entityType: 'assembly', entityId: id, before: publicAssembly(claimed),
        after: {
          heldAt: heldAt.toISOString(), present: quorum.present, basisTotal: quorum.basisTotal,
          quorumReached: quorum.quorumReached, minutesDocumentId: document.id,
          decisions: tallies.map(({ decision, tally }) => ({ id: decision.id, result: tally.result })),
        },
      });
      return await getAssembly(tx, ctx, id);
    } catch (err) {
      // The document row goes back with the transaction, so its bytes must go too: `createDocument`
      // only cleans up after *its own* failure, and a file with no row is an orphan nothing reaches.
      // The key is the one `createDocument` derived from the very same three values.
      try {
        await rt.documents.remove(documentStorageKey(ctx.tenantId, document.id, document.mime, document.createdAt));
      } catch (removeErr) {
        rt.log.warn({ err: removeErr, documentId: document.id }, 'assembly hold rolled back but its minutes file could not be removed');
      }
      throw err;
    }
  });
}
