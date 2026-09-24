import { z } from 'zod';

export const assemblyStatusEnum = z.enum(['draft', 'invited', 'held', 'cancelled']);
export const quorumBasisEnum = z.enum(['share', 'count']);
export const assemblyChannelEnum = z.enum(['email', 'letter']);
export const assemblyInvitationStatusEnum = z.enum(['pending', 'sent', 'failed', 'printed', 'cancelled']);
export const voteChoiceEnum = z.enum(['for', 'against', 'abstain']);
export const voteViaEnum = z.enum(['portal', 'paper']);
export const decisionResultEnum = z.enum(['pending', 'passed', 'rejected', 'no_quorum']);

const dt = () => z.date().or(z.string());

/** An `id` sent back by the edit form is kept, so an agenda point survives a rename (addendum 1). */
export const agendaItemIn = z.object({ id: z.string().uuid().optional(), title: z.string().min(1).max(200), text: z.string().max(4000).optional() });
export const agendaItemOut = z.object({ id: z.string(), title: z.string(), text: z.string() });

export const decisionOut = z.object({
  id: z.string(), title: z.string(), text: z.string().nullable(), sortOrder: z.number().int(),
  forWeight: z.number().int(), againstWeight: z.number().int(), abstainWeight: z.number().int(),
  presentWeight: z.number().int(), basisTotal: z.number().int(), quorumReached: z.boolean(), result: decisionResultEnum,
});
export const invitationOut = z.object({
  id: z.string(), contactId: z.string(), contactName: z.string(), email: z.string().nullable(),
  channel: assemblyChannelEnum, status: assemblyInvitationStatusEnum, sentAt: dt().nullable(), error: z.string().nullable(),
});
export const attendanceOut = z.object({
  contactId: z.string(), contactName: z.string(), present: z.boolean(), proxyName: z.string().nullable(), weightBp: z.number().int(),
});
export const voteOut = z.object({ decisionId: z.string(), contactId: z.string(), choice: voteChoiceEnum, via: voteViaEnum, castAt: dt() });

export const assemblyRowOut = z.object({
  id: z.string(), buildingId: z.string(), scheduledAt: dt(), location: z.string(), agenda: z.array(agendaItemOut),
  status: assemblyStatusEnum, quorumBasis: quorumBasisEnum,
  invitedAt: dt().nullable(), heldAt: dt().nullable(), cancelledAt: dt().nullable(), cancelReason: z.string().nullable(),
  lateInvitation: z.boolean(), lateReason: z.string().nullable(), minutesDocumentId: z.string().nullable(),
  decisionCount: z.number().int(), invitationCount: z.number().int(), createdAt: dt(), updatedAt: dt(),
});
export const assemblyOut = assemblyRowOut.extend({
  decisions: z.array(decisionOut), invitations: z.array(invitationOut),
  attendance: z.array(attendanceOut), votes: z.array(voteOut),
});
export const assemblyListOut = z.object({ rows: z.array(assemblyRowOut) });

export const assemblyCreate = z.object({
  scheduledAt: z.string().datetime(),
  location: z.string().max(300).optional(),
  quorumBasis: quorumBasisEnum.optional(),
  agenda: z.array(agendaItemIn).max(50).optional(),
  decisions: z.array(z.object({ title: z.string().min(1).max(200), text: z.string().max(4000).nullable().optional() })).max(50).optional(),
});
export const assemblyPatch = z.object({
  scheduledAt: z.string().datetime().optional(),
  location: z.string().max(300).optional(),
  quorumBasis: quorumBasisEnum.optional(),
  agenda: z.array(agendaItemIn).max(50).optional(),
}).strict().refine((v) => Object.keys(v).length > 0, 'empty patch');

export const decisionCreate = z.object({
  title: z.string().min(1).max(200), text: z.string().max(4000).nullable().optional(), sortOrder: z.number().int().min(0).max(999).optional(),
});
export const decisionPatch = decisionCreate.partial().strict().refine((v) => Object.keys(v).length > 0, 'empty patch');

export const inviteBody = z.object({ override: z.object({ reason: z.string().min(3).max(500) }).optional() }).nullish();
export const cancelBody = z.object({ reason: z.string().min(3).max(500) });

export const assemblyDecisionParam = z.object({ id: z.string().uuid(), decisionId: z.string().uuid() });

export type AssemblyCreate = z.infer<typeof assemblyCreate>;
export type AssemblyPatch = z.infer<typeof assemblyPatch>;
export type DecisionCreate = z.infer<typeof decisionCreate>;
export type DecisionPatch = z.infer<typeof decisionPatch>;
export type AgendaItemIn = z.infer<typeof agendaItemIn>;

export const assemblyOwnersOut = z.object({
  rows: z.array(z.object({ contactId: z.string(), contactName: z.string(), email: z.string().nullable(), weightBp: z.number().int() })),
  basisTotal: z.number().int(),
  quorumBasis: quorumBasisEnum,
});
export const paperVoteBody = z.object({ contactId: z.string().uuid(), choice: voteChoiceEnum });
export const holdBody = z.object({
  /** Defaults to the assembly's `scheduledAt` (plan addendum 15). */
  heldAt: z.string().datetime().optional(),
  attendance: z.array(z.object({
    contactId: z.string().uuid(), present: z.boolean(), proxyName: z.string().max(200).nullable().optional(),
  })).max(500).default([]),
});
export type HoldBody = z.infer<typeof holdBody>;
