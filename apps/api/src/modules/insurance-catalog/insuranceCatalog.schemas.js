import { z } from 'zod';
import { US_STATE_CODES } from '../../models/enums.js';

const stateArray = z.array(z.enum(US_STATE_CODES)).max(51);
const logoUrl = z.string().trim().url().max(2000);

export const createCatalogSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    states: stateArray.optional(),
    logoUrl: logoUrl.optional(),
    active: z.boolean().optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict();

export const updateCatalogSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    states: stateArray.optional(),
    logoUrl: logoUrl.nullable().optional(),
    active: z.boolean().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update.' });

export const catalogIdParamsSchema = z.object({ id: z.string().min(1) }).strict();

// A data URL or bare base64 payload. The BYTES are what the uploader validates
// (magic number + size); this only caps the transport. 6 MB leaves headroom
// over the 2 MB image limit for base64's ~33% expansion.
export const catalogLogoUploadSchema = z.object({ file: z.string().min(1).max(6_000_000) }).strict();

export const listCatalogQuerySchema = z
  .object({
    active: z.enum(['true', 'false']).optional(),
    state: z.enum(US_STATE_CODES).optional(),
  })
  .strict();
