import { schema } from '@domar/db';
import { z } from 'zod';
import { pageQuery } from '../common.js';
import { fundEnum } from '../reserve-fund/schema.js';

export const maintenanceStatusEnum = z.enum(schema.maintenanceStatus.enumValues);
export const maintenancePriorityEnum = z.enum(schema.maintenancePriority.enumValues);
export const maintenanceCategoryEnum = z.enum(schema.maintenanceCategory.enumValues);
export const maintenanceEventKindEnum = z.enum(schema.maintenanceEventKind.enumValues);
export const maintenanceVisibilityEnum = z.enum(schema.maintenanceVisibility.enumValues);

/** `assigned` is missing on purpose: it is reached only through POST …/assign (plan addendum 3). */
export const maintenanceStatusTargetEnum = z.enum(['triaged', 'rejected', 'in_progress', 'done']);

export const maintenanceCreate = z.object({
  unitId: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).default(''),
  category: maintenanceCategoryEnum,
  priority: maintenancePriorityEnum.default('normal'),
});

export const maintenancePatch = z.object({
  unitId: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  category: maintenanceCategoryEnum.optional(),
  priority: maintenancePriorityEnum.optional(),
}).strict().refine((v) => Object.keys(v).length > 0, 'empty patch');

/** What a close books. `costMinor` is minor units and positive; `createExpense` signs the posting. */
export const maintenanceCost = z.object({
  fund: fundEnum,
  costMinor: z.number().int().min(1).max(1_000_000_000_000),
  supplierId: z.string().uuid().nullable().optional(),
  documentId: z.string().uuid().nullable().optional(),
});
export const maintenancePhotoParam = z.object({ id: z.string().uuid(), documentId: z.string().uuid() });

/**
 * A close either books money or explicitly books none: its *absence* is what
 * `cost_decision_required` refuses — `{}` and `{ cost: null }` differ.
 */
export const maintenanceStatusBody = z.object({
  status: maintenanceStatusTargetEnum,
  note: z.string().max(2000).optional(),
  visibility: maintenanceVisibilityEnum.optional(),
  cost: maintenanceCost.nullable().optional(),
});

export const maintenanceAssignBody = z.object({
  assigneeUserId: z.string().uuid(),
  supplierId: z.string().uuid().nullable().optional(),
  note: z.string().max(2000).optional(),
});

export const maintenanceEventBody = z.object({
  note: z.string().min(1).max(2000),
  visibility: maintenanceVisibilityEnum.default('internal'),
});

export const maintenancePhotoOut = z.object({
  documentId: z.string(), title: z.string(), fileName: z.string(), mime: z.string(),
  sizeBytes: z.number().int(), uploadedByName: z.string(), createdAt: z.date().or(z.string()),
});

export const maintenanceEventOut = z.object({
  id: z.string(), kind: maintenanceEventKindEnum,
  fromStatus: maintenanceStatusEnum.nullable(), toStatus: maintenanceStatusEnum.nullable(),
  note: z.string(), visibility: maintenanceVisibilityEnum,
  authorName: z.string(), authorKind: z.enum(['manager', 'owner', 'system']),
  createdAt: z.date().or(z.string()),
});

export const maintenanceRowOut = z.object({
  id: z.string(), buildingId: z.string(), unitId: z.string().nullable(), unitLabel: z.string().nullable(),
  title: z.string(), category: maintenanceCategoryEnum, priority: maintenancePriorityEnum, status: maintenanceStatusEnum,
  reporterName: z.string(), reporterKind: z.enum(['manager', 'owner']),
  assigneeUserId: z.string().nullable(), assigneeName: z.string().nullable(),
  supplierId: z.string().nullable(), supplierName: z.string().nullable(),
  fund: fundEnum.nullable(), costMinor: z.number().int().nullable(), expenseId: z.string().nullable(),
  photoCount: z.number().int(),
  closedAt: z.date().or(z.string()).nullable(), createdAt: z.date().or(z.string()), updatedAt: z.date().or(z.string()),
});

export const maintenanceOut = maintenanceRowOut.extend({
  description: z.string(),
  photos: z.array(maintenancePhotoOut),
  events: z.array(maintenanceEventOut),
});
export const maintenanceListOut = z.object({ rows: z.array(maintenanceRowOut), total: z.number() });
/** The board pages and filters like every other list endpoint; `assigneeUserId` is the "whose queue" filter. */
export const maintenanceListQuery = pageQuery.extend({
  status: maintenanceStatusEnum.optional(),
  category: maintenanceCategoryEnum.optional(),
  priority: maintenancePriorityEnum.optional(),
  assigneeUserId: z.string().uuid().optional(),
});

export type MaintenanceListQuery = z.infer<typeof maintenanceListQuery>;
export type MaintenanceCreateInput = z.infer<typeof maintenanceCreate>;
export type MaintenancePatchInput = z.infer<typeof maintenancePatch>;
export type MaintenanceStatusInput = z.infer<typeof maintenanceStatusBody>;
export type MaintenanceAssignInput = z.infer<typeof maintenanceAssignBody>;
export type MaintenanceEventInput = z.infer<typeof maintenanceEventBody>;
