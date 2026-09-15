import { z } from 'zod';

const id = z.string().min(1);
const dateTime = z.string().trim().refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date/time');

export const panelQuerySchema = z
  .object({
    from: dateTime.optional(),
    to: dateTime.optional(),
  })
  .strict();

export const appointmentParamsSchema = z.object({ appointmentId: id }).strict();

/**
 * MANUAL SESSION ENTRY (Phase 3). A clinician records a COMPLETED session that
 * happened without the live timer. Child + date + start/end + optional Session
 * Note (documentation) + optional memo. Times are 15-minute increments (HH:mm)
 * in the organization timezone; end-after-start and same-day are enforced in the
 * service (authoritative). The clinician identity is derived from the token —
 * never from the body.
 */
// Shape only: a 24-hour HH:mm clock time. The 15-minute rule, end-after-start,
// real calendar date and authorization rules are enforced in the service so
// the caller gets a specific message (the validation middleware reports a
// generic one). `.strict()` rejects any extra key — a caller can never supply a
// staffProfileId, tenantId, role or duration.
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 17:30.');
export const manualSessionSchema = z.object({
  clientId: id,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date.'),
  startTime: hhmm,
  endTime: hhmm,
  // The authorization(s) the session was performed under (required; validated
  // server-side against tenant, client, status and date).
  authorizationIds: z.array(id).max(10).optional(),
  documentation: z.object({
    what: z.string().trim().max(20000).optional(),
    how: z.string().trim().max(20000).optional(),
    childResponse: z.string().trim().max(20000).optional(),
  }).strict().optional(),
  memo: z.string().trim().max(20000).optional(),
}).strict();

/**
 * In-session documentation save (spec §1/§4/§6). Any subset of the three
 * fields; at least one must be present. Each is free clinical text. An empty
 * string is allowed and clears that field. This never carries clock, status,
 * authorization or plan data — those are separate concerns (§6/§12).
 */
export const saveDocumentationSchema = z
  .object({
    what: z.string().trim().max(20000).optional(),
    how: z.string().trim().max(20000).optional(),
    childResponse: z.string().trim().max(20000).optional(),
    // Session Memo — the RBT's in-session input, and also available to the
    // BCBA alongside the three documentation fields. Which roles may send
    // WHICH of these keys is decided on the server in saveDocumentation, not
    // here: the schema describes the shape, the service enforces the policy.
    memo: z.string().trim().max(20000).optional(),
  })
  .strict()
  .refine((v) => ['what', 'how', 'childResponse', 'memo'].some((k) => v[k] !== undefined), {
    message: 'Provide something to save.',
  });

export const completeSessionSchema = z
  .object({
    // Legacy single-authorization form (still accepted): one authorization + an
    // optional session memo. Restricted server-side to the appointment's own
    // authorizations (§11) regardless of what is sent.
    authorizationId: id.optional(),
    memo: z.string().trim().max(20000).optional(),
    // MULTI-AUTHORIZATION form (spec §22/§23): one or more selected
    // authorizations, EACH with its own optional memo. When present this takes
    // precedence over the single fields. Each id is validated against the
    // appointment's eligible set server-side.
    authorizations: z
      .array(z.object({
        authorizationId: id,
        memo: z.string().trim().max(20000).optional(),
      }).strict())
      .min(1)
      .max(50)
      .optional(),
  })
  .strict()
  .refine((v) => Boolean(v.authorizationId) || (Array.isArray(v.authorizations) && v.authorizations.length > 0), {
    message: 'Select at least one authorization to complete the session.',
    path: ['authorizations'],
  });

export const timeRecordsQuerySchema = z
  .object({
    staffProfileId: id.optional(),
    from: dateTime.optional(),
    to: dateTime.optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

/**
 * "My Hours" period filter (spec Change 4). The set is fixed server-side; an
 * unknown value is rejected. No staffProfileId is accepted here — the caller's
 * own id is resolved from the token, never the query, so a BCBA cannot request
 * another clinician's hours.
 */
export const myHoursQuerySchema = z
  .object({
    period: z.enum(['week', 'biweek', 'month', '3months', '6months', 'year']).optional().default('week'),
  })
  .strict();
