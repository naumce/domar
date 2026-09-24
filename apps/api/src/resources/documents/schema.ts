import { z } from 'zod';

export const documentKindEnum = z.enum(['contract', 'minutes', 'report', 'invoice_supplier', 'photo', 'other']);

/** `storageKey` is deliberately absent: the storage layout never leaves the server. */
export const documentOut = z.object({
  id: z.string(), buildingId: z.string().nullable(), kind: documentKindEnum, title: z.string(),
  fileName: z.string(), mime: z.string(), sizeBytes: z.number().int(), sha256: z.string(),
  uploadedBy: z.string().nullable(), createdAt: z.date().or(z.string()),
});
export const documentListOut = z.object({ rows: z.array(documentOut) });
export const documentListQuery = z.object({ kind: documentKindEnum.optional() });
export type DocumentKind = z.infer<typeof documentKindEnum>;
