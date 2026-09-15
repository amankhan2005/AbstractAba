import { z } from 'zod';
export const refreshSchema = z.object({
  claimId: z.string().min(1).optional(),
  invoiceId: z.string().min(1).optional(),
}).refine((v) => v.claimId || v.invoiceId, { message: 'claimId or invoiceId is required' });

export const reconTransitionSchema = z.object({
  target: z.enum(['REVIEWING', 'PARTIAL', 'RECONCILED', 'DISCREPANCY', 'RESOLVED']),
  reason: z.string().trim().max(1000).optional(),
  notes: z.string().trim().max(2000).optional(),
});
