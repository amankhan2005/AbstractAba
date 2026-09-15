import { z } from 'zod';
import { SEARCHABLE_TYPES } from './search.engine.js';

/**
 * Search input validation. The client controls only the query term, which
 * entity types to include, per-type structured filters, pagination limit, and a
 * cursor — never the tenant. Unknown filter keys are rejected downstream by the
 * engine; here we bound the shapes and sizes.
 */

const typeEnum = z.enum(SEARCHABLE_TYPES);

// Global multi-entity search.
export const globalSearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200).optional(),
    // comma-separated list of entity types, or omitted for "all authorized"
    types: z
      .string()
      .trim()
      .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
      .pipe(z.array(typeEnum).max(SEARCHABLE_TYPES.length))
      .optional(),
    limit: z.coerce.number().int().min(1).max(25).default(10),
    // per-type filters are passed as status/documentType/clientId/etc. (flat);
    // they apply to whichever entities declare them and are ignored elsewhere.
    status: z.string().trim().max(60).optional(),
    documentType: z.string().trim().max(60).optional(),
    discipline: z.string().trim().max(60).optional(),
    clientId: z.string().uuid().optional(),
  })
  .strict()
  .refine((v) => v.q != null || v.status != null || v.clientId != null, {
    message: 'Provide a search term or at least one filter.',
  });

// Single-entity paged search.
export const entitySearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().trim().min(1).optional(),
    status: z.string().trim().max(60).optional(),
    documentType: z.string().trim().max(60).optional(),
    discipline: z.string().trim().max(60).optional(),
    clientId: z.string().uuid().optional(),
  })
  .strict();

export const entityTypeParamsSchema = z.object({ entityType: typeEnum });
