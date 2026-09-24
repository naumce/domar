import { schema } from '@domar/db';
import { z } from 'zod';

export const userRoleEnum = z.enum(schema.userRole.enumValues);
export const userOut = z.object({
  id: z.string(), email: z.string(), firstName: z.string(), lastName: z.string(), role: userRoleEnum, isActive: z.boolean(),
});
export const userCreate = z.object({
  email: z.string().email().max(200),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  role: userRoleEnum,
});
export const userPatch = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  role: userRoleEnum.optional(),
  isActive: z.boolean().optional(),
}).strict();
export const userCreated = z.object({ user: userOut, temporaryPassword: z.string() });
export const changePasswordBody = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(10).max(200) });

export type UserCreate = z.infer<typeof userCreate>;
export type UserPatch = z.infer<typeof userPatch>;
