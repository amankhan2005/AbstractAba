import { z } from 'zod';
import { SUPERVISION_METHOD } from '../../models/enums.js';

const uuid = z.string().uuid();
const dateSchema = z.string().trim().refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date');
const optText = (max) => z.string().trim().max(max).optional();
const minutes = z.coerce.number().int().positive();

// Note: tenantId, status, signedBy, signedAt, createdBy, version and all other
// server-authoritative fields are intentionally NOT accepted from the client.
export const createObservationSchema = z
  .object({
    supervisorStaffId: uuid,
    superviseeStaffId: uuid,
    clientId: uuid.optional(),
    sessionId: uuid.optional(),
    observedAt: dateSchema,
    durationMinutes: minutes,
    method: z.enum(SUPERVISION_METHOD).optional(),
    summary: optText(4000),
    findings: optText(8000),
  })
  .strict();

export const updateObservationSchema = z
  .object({
    clientId: uuid.optional(),
    sessionId: uuid.optional(),
    observedAt: dateSchema.optional(),
    durationMinutes: minutes.optional(),
    method: z.enum(SUPERVISION_METHOD).optional(),
    summary: optText(4000),
    findings: optText(8000),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export const supersedeObservationSchema = z
  .object({
    observedAt: dateSchema.optional(),
    durationMinutes: minutes.optional(),
    method: z.enum(SUPERVISION_METHOD).optional(),
    summary: optText(4000),
    findings: optText(8000),
    clientId: uuid.optional(),
    sessionId: uuid.optional(),
  })
  .strict();

export const observationIdParamsSchema = z.object({ observationId: uuid }).strict();

export const listObservationsQuerySchema = z
  .object({
    supervisorStaffId: uuid.optional(),
    superviseeStaffId: uuid.optional(),
    status: z.enum(['DRAFT', 'SUBMITTED', 'SIGNED', 'SUPERSEDED']).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();

export const recordHoursSchema = z
  .object({
    supervisorStaffId: uuid,
    superviseeStaffId: uuid,
    date: dateSchema,
    minutes,
    note: optText(2000),
  })
  .strict();

export const hoursSummaryQuerySchema = z
  .object({
    supervisorStaffId: uuid.optional(),
    superviseeStaffId: uuid.optional(),
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
  })
  .strict();
