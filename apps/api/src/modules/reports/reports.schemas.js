import { z } from 'zod';
export const rangeSchema = z.object({
  preset: z.enum(['today', 'this_week', 'this_month', 'last_month', 'this_quarter', 'custom']).optional(),
  start: z.string().optional(),
  end: z.string().optional(),
});
