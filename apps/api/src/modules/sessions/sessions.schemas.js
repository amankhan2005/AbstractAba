import { z } from 'zod';
import { SESSION_STATUS, TARGET_MEASUREMENT_TYPE } from '../../models/enums.js';

const uuidSchema = z.string().uuid();
const dateTime = z.string().trim().refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date/time');
const optText = (max) => z.string().trim().max(max).optional();
const num = z.coerce.number().finite();

// --- session ---------------------------------------------------------------

export const createSessionSchema = z
  .object({
    appointmentId: uuidSchema,
    // OPTIONAL (spec §8/§15): a session may be created before the child has an
    // ACTIVE treatment plan — an RBT must never be blocked from starting or
    // documenting a session because no plan exists yet. When present it is
    // validated (ACTIVE + same client) in the service; when absent the session
    // is created with treatmentPlanId:null and plan-bound data-point capture
    // rejects cleanly until a plan is bound. An empty string is coerced to
    // "absent" so a UI that sends '' does not trip UUID validation (the exact
    // POST /api/v1/sessions 422 this fixes).
    treatmentPlanId: z.preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      uuidSchema.optional(),
    ),
    startedAt: dateTime.optional(),
    endedAt: dateTime.optional(),
    narrative: optText(20000),
  })
  .strict();

export const updateSessionSchema = z
  .object({
    startedAt: dateTime.optional(),
    endedAt: dateTime.optional(),
    // `status` is deliberately ABSENT. Every state change goes through its own
    // endpoint — /clock-in, /clock-out, /submit, /return, /cancel, /freeze,
    // /amend — because each carries obligations a status field cannot express:
    // a submission must pass the completeness check, a return must carry a
    // comment, a cancellation a reason code. A PATCH that could set status let
    // a client put an incomplete session into the review queue, one approval
    // away from billing.
    narrative: optText(20000),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export const listSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
  clientId: uuidSchema.optional(),
  staffProfileId: uuidSchema.optional(),
  appointmentId: uuidSchema.optional(),
  status: z.enum(SESSION_STATUS).optional(),
});

const civilDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date');
export const sessionInsightsQuerySchema = z.object({
  from: civilDate.optional(),
  to: civilDate.optional(),
  clientId: uuidSchema.optional(),
  staffProfileId: uuidSchema.optional(),
  status: z.enum(SESSION_STATUS).optional(),
}).strict().refine((v) => !(v.from && v.to) || v.from <= v.to, { message: 'The start date must be on or before the end date.', path: ['to'] });

export const sessionIdParamsSchema = z.object({ sessionId: uuidSchema });

// --- data points -----------------------------------------------------------

export const createDataPointSchema = z
  .object({
    targetId: uuidSchema,
    measurementType: z.enum(TARGET_MEASUREMENT_TYPE),
    value: num.optional(),
    numerator: num.optional(),
    denominator: num.optional(),
  })
  .strict();

export const updateDataPointSchema = z
  .object({
    measurementType: z.enum(TARGET_MEASUREMENT_TYPE).optional(),
    value: num.optional(),
    numerator: num.optional(),
    denominator: num.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export const dataPointParamsSchema = z.object({ sessionId: uuidSchema, dataPointId: uuidSchema });

// --- Session lifecycle (blueprint Figure 6.2, §6.6, §9.4) -------------------

const locationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyMetres: z.number().nonnegative().optional(),
  capturedAt: z.string().datetime().optional(),
});

export const clockInSchema = z.object({
  // Location is OPTIONAL by design: §6.6 requires capture at the clock events,
  // and §9.4 specifies offline capture in a family home with no signal. A hard
  // requirement here would block care delivery to satisfy a record. Absence is
  // surfaced as an incomplete verification record instead, which is exactly
  // what BR-BL-5 asks for — the claim is held, the session is not.
  location: locationSchema.optional(),
  serviceType: z.string().min(1).max(64).optional(),
  at: z.string().datetime().optional(),
});

export const clockOutSchema = z.object({
  location: locationSchema.optional(),
  at: z.string().datetime().optional(),
});

export const captureSignatureSchema = z.object({
  role: z.enum(['GUARDIAN', 'TECHNICIAN']),
  signerName: z.string().min(1).max(200).optional(),
  signerGuardianId: z.string().uuid().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().min(1).max(500).optional(),
});

export const returnSessionSchema = z.object({
  // "Return with a comment that reaches the technician immediately" (§9.4).
  // A return with no comment tells the technician nothing, so it is refused.
  comment: z.string().min(1).max(2000),
});

export const cancelSessionSchema = z.object({
  reasonCode: z.enum(['CLIENT_CANCEL', 'PROVIDER_CANCEL', 'NO_SHOW', 'ILLNESS', 'WEATHER', 'HOLIDAY', 'AGENCY']),
  note: z.string().max(2000).optional(),
});

export const amendSessionSchema = z.object({
  reason: z.string().min(1).max(2000),
  changes: z.object({
    startedAt: z.string().datetime().optional(),
    endedAt: z.string().datetime().optional(),
  }).optional(),
});
