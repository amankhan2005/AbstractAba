import { z } from 'zod';
import { DOCUMENT_TYPE, DOCUMENT_STATUS } from '../../models/enums.js';

const uuidSchema = z.string().uuid();
const dateSchema = z.string().trim().refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date');
const text = (max) => z.string().trim().min(1).max(max);
const optText = (max) => z.string().trim().max(max).optional();

// The artifact bytes are NEVER described by the client. storageRef / contentType
// / sizeBytes / checksum are derived server-side from the uploaded bytes via the
// dedicated attach-file endpoint (see document.validation.js), closing the
// forgery/IDOR gap where a client could claim an arbitrary ref/size/type.

export const createDocumentSchema = z
  .object({
    clientId: uuidSchema,
    documentType: z.enum(DOCUMENT_TYPE).optional(),
    title: text(300),
    description: optText(4000),
    documentDate: dateSchema.optional(),
    expiresAt: dateSchema.optional(),
  })
  .strict();

export const updateDocumentSchema = z
  .object({
    documentType: z.enum(DOCUMENT_TYPE).optional(),
    title: text(300).optional(),
    description: optText(4000),
    documentDate: dateSchema.optional(),
    expiresAt: dateSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

// Upload payload for the attach-file endpoint: base64 bytes + claimed content
// type only. The server validates the type against the allowlist, measures the
// real size, and computes the checksum — the client's claims are not trusted.
export const attachFileSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255).optional(),
    contentType: z.string().trim().min(1).max(255),
    base64: z.string().min(1),
  })
  .strict();

export const listDocumentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
  clientId: uuidSchema.optional(),
  documentType: z.enum(DOCUMENT_TYPE).optional(),
  status: z.enum(DOCUMENT_STATUS).optional(),
});

export const documentIdParamsSchema = z.object({ documentId: uuidSchema });

// Superseding a finalized document files a new draft; the body carries the new
// version's fields (the client is inherited from the superseded document).
export const supersedeDocumentSchema = z
  .object({
    documentType: z.enum(DOCUMENT_TYPE).optional(),
    title: text(300),
    description: optText(4000),
    documentDate: dateSchema.optional(),
    expiresAt: dateSchema.optional(),
  })
  .strict();
