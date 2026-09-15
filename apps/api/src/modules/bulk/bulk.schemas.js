import { z } from 'zod';
import { IMPORTERS } from './import.engine.js';

const entityEnum = z.enum(Object.keys(IMPORTERS));

/**
 * Import upload: base64-encoded CSV + the target entity. Tenant, actor, and all
 * authoritative fields are server-owned and never accepted here. The server
 * enforces the real byte cap after decoding.
 */
export const importUploadSchema = z
  .object({
    base64: z.string().min(1),
    fileName: z.string().trim().max(255).optional(),
  })
  .strict();

export const importEntityParamsSchema = z.object({ entity: entityEnum });

export const exportIdParamsSchema = z.object({ exportId: z.string().uuid() });
