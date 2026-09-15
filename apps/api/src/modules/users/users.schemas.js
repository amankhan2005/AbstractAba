import { z } from 'zod';

/** Membership status vocabulary (also declared on the model enum). */
export const MEMBERSHIP_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'REMOVED'];

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const uuidSchema = z.string().uuid();
const fullNameSchema = z.string().trim().min(2, 'Enter a full name').max(200);
const roleKeySchema = z
  .string().trim().toLowerCase().min(2).max(50)
  .regex(/^[a-z0-9]([a-z0-9_]*[a-z0-9])?$/, 'A role key uses lowercase letters, numbers and underscores');
const roleKeysSchema = z.array(roleKeySchema).min(1, 'Assign at least one role').max(20)
  .transform((keys) => [...new Set(keys)]);

export const inviteMemberSchema = z.object({ email: emailSchema, fullName: fullNameSchema, roleKeys: roleKeysSchema });
export const inviteOwnerSchema = z.object({ email: emailSchema, fullName: fullNameSchema });
export const assignRolesSchema = z.object({ roleKeys: roleKeysSchema });
export const updateMembershipStatusSchema = z.object({ status: z.enum(MEMBERSHIP_STATUSES) });
export const listMembersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
  status: z.enum(MEMBERSHIP_STATUSES).optional(),
  search: z.string().trim().min(1).max(100).optional(),
});
export const membershipIdParamsSchema = z.object({ membershipId: uuidSchema });
export const organizationIdParamsSchema = z.object({ id: uuidSchema });
export const invitationIdParamsSchema = z.object({ invitationId: uuidSchema });
export const ownerInvitationParamsSchema = z.object({ id: uuidSchema, invitationId: uuidSchema });
export const membershipRoleParamsSchema = z.object({ membershipId: uuidSchema, roleKey: roleKeySchema });
export const invitationTokenParamsSchema = z.object({
  token: z.string().trim().min(20, 'That invitation link is not valid').max(200)
    .regex(/^[A-Za-z0-9_-]+$/, 'That invitation link is not valid'),
});
export const acceptInvitationSchema = z.object({
  password: z.string().min(1, 'Choose a password').max(200),
  fullName: fullNameSchema.optional(),
});
