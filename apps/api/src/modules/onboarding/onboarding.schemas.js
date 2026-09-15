import { z } from 'zod';

const uuidSchema = z.string().uuid();
export const agreementTypeSchema = z.enum(['BUSINESS_ASSOCIATE', 'TERMS_OF_SERVICE', 'DATA_PROCESSING']);

export const recordAgreementSchema = z.object({
  type: agreementTypeSchema,
  version: z.string().trim().min(1).max(50),
  executedByName: z.string().trim().min(2).max(200),
  executedByTitle: z.string().trim().min(2).max(200),
  executedAt: z.coerce.date(),
  documentRef: z.string().trim().min(1).max(500).nullable().default(null),
});
export const agreementIdParamsSchema = z.object({ id: uuidSchema, agreementId: uuidSchema });
export const organizationIdParamsSchema = z.object({ id: uuidSchema });
export const beginOffboardingSchema = z.object({ reason: z.string().trim().min(5, 'Give a reason of at least 5 characters').max(500) });
export const completeExportSchema = z.object({ exportId: uuidSchema, artifactRef: z.string().trim().min(1).max(500) });
export const approveDestructionSchema = z.object({ requestedByUserId: uuidSchema });
