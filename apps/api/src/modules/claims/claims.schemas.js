import { z } from 'zod';

export const generateClaimSchema = z.object({
  clientId: z.string().min(1),
  authorizationId: z.string().min(1).optional(),
  sessionIds: z.array(z.string().min(1)).min(1),
  unitCharge: z.number().int().min(0).optional(),
  generationKey: z.string().optional(),
});

export const previewClaimSchema = z.object({
  clientId: z.string().min(1),
  authorizationId: z.string().min(1).optional(),
  sessionIds: z.array(z.string().min(1)).min(1),
  unitCharge: z.number().int().min(0).optional(),
});

export const transitionClaimSchema = z.object({
  target: z.enum(['SUBMITTED', 'ACCEPTED', 'REJECTED', 'DENIED', 'PAID', 'CLOSED']),
  reason: z.string().trim().max(1000).optional(),
});

// Child + period insurance-billing preview/export (spec §1/§2). Child + a
// date range; the server derives everything else. from/to are YYYY-MM-DD.
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
export const childBillingSchema = z.object({
  clientId: z.string().min(1),
  from: ymd,
  to: ymd,
});

// Company-wide billing preview/generate/export (Billing rebuild spec §2–§4).
// ONLY a date range — the server finds every relevant client. No clientId.
export const companyBillingSchema = z.object({
  from: ymd,
  to: ymd,
});
