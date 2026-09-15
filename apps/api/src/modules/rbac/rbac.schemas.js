import { z } from 'zod';

/** A role key is a stable slug (`owner`, `bcba`); shape-validated only. */
export const roleKeyParamsSchema = z.object({
  roleKey: z
    .string().trim().toLowerCase().min(2).max(50)
    .regex(/^[a-z0-9]([a-z0-9_]*[a-z0-9])?$/, 'A role key uses lowercase letters, numbers and underscores'),
});
