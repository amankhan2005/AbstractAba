import { z } from 'zod';

export const uploadEraSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  content: z.string().min(1).max(5_000_000), // 835 text payload (<= ~5MB)
});

export const resolveRecordSchema = z.object({
  claimId: z.string().min(1),
});
