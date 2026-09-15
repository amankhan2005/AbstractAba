import { z } from 'zod';
import { APPOINTMENT_STATUS, AUTHORIZATION_STATUS, RECURRENCE_FREQUENCY, APPOINTMENT_SERIES_STATUS } from '../../models/enums.js';

const uuidSchema = z.string().uuid();
// A bookable authorization id is either a scheduling Authorization UUID or an
// ABA/FBA ServiceAuthorization surfaced with a `svc:` prefix (unified source).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const authorizationIdSchema = z.string().refine(
  (v) => UUID_RE.test(v.startsWith('svc:') ? v.slice(4) : v),
  'Invalid authorization id',
);
const dateTimeSchema = z.string().trim().refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date/time');

// --- recurring series (Phase 4.3) ------------------------------------------
// The client supplies the booking template + recurrence rule only. tenantId,
// status, seriesId, materialization state, and all authoritative fields are
// server-owned and never accepted here.
export const createSeriesSchema = z
  .object({
    clientId: uuidSchema,
    staffProfileId: uuidSchema,
    authorizationId: authorizationIdSchema,
    units: z.coerce.number().int().min(1).max(1000).optional(),
    startMinute: z.coerce.number().int().min(0).max(1439),
    endMinute: z.coerce.number().int().min(1).max(1440),
    frequency: z.enum(RECURRENCE_FREQUENCY),
    interval: z.coerce.number().int().min(1).max(52).default(1),
    byWeekday: z.array(z.coerce.number().int().min(0).max(6)).max(7).optional(),
    startDate: dateTimeSchema,
    untilDate: dateTimeSchema.optional(),
    count: z.coerce.number().int().min(1).max(366).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((v) => v.untilDate != null || v.count != null, { message: 'Provide an end date or an occurrence count.' })
  .refine((v) => v.endMinute > v.startMinute, { message: 'endMinute must be after startMinute.' });

export const listSeriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(APPOINTMENT_SERIES_STATUS).optional(),
  clientId: uuidSchema.optional(),
  staffProfileId: uuidSchema.optional(),
});

export const seriesIdParamsSchema = z.object({ seriesId: uuidSchema });
export const seriesOccurrenceParamsSchema = z.object({ seriesId: uuidSchema, appointmentId: uuidSchema });

// --- appointments ----------------------------------------------------------

// Calendar date ('YYYY-MM-DD') or full ISO — the new pipeline composes the
// start/end instants from date + time parts (see booking.js). 'HH:MM' clock.
const dateOnlyOrIso = z.string().trim().refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date');
const clockTimeSchema = z.string().trim().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Enter a valid time (HH:MM)');

// NEW simple booking contract (rebuild). The Book Appointment form sends
// separate care-team roles (bcbaId + rbtId), one or more authorizations
// (authorizationIds), calendar dates, clock times, and units. tenantId, status,
// createdBy and every authoritative field are server-owned and never accepted.
export const createAppointmentSchema = z
  .object({
    clientId: uuidSchema,
    // ONE clinician per appointment (spec §4/§17/§23): a booking names EITHER a
    // BCBA OR an RBT. Both are optional at the type level but the refine below
    // requires exactly one — never both, never neither. Two separate
    // appointments are used when a child needs both roles.
    bcbaId: uuidSchema.optional(),
    rbtId: uuidSchema.optional(),
    authorizationIds: z.array(authorizationIdSchema).min(1, 'Select at least one authorization').max(20),
    startDate: dateOnlyOrIso,
    endDate: dateOnlyOrIso,
    // Scheduling captures the DATE; the clock time is optional (spec §2). Actual
    // worked time is NEVER taken from the appointment window — it comes solely
    // from each clinician's own session clock-in/clock-out. When no time is
    // given the booking core anchors the day at 00:00 UTC and derives the end
    // from units.
    startTime: clockTimeSchema.optional(),
    endTime: clockTimeSchema.optional(),
    units: z.coerce.number({ invalid_type_error: 'Units must be a number.' }).int('Units must be a whole number.').min(1, 'Units must be greater than 0.').max(1000),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.bcbaId) || Boolean(v.rbtId), {
    message: 'Assign one clinician — either a BCBA or an RBT.',
    path: ['bcbaId'],
  })
  .refine((v) => !(v.bcbaId && v.rbtId), {
    message: 'An appointment is for one clinician only — choose a BCBA or an RBT, not both.',
    path: ['rbtId'],
  })
  .refine((v) => Date.parse(v.endDate) >= Date.parse(v.startDate), {
    message: 'End date must be on or after start date.',
    path: ['endDate'],
  });

// Reschedule / edit: times, units, notes, or status (e.g. mark COMPLETED / NO_SHOW).
export const updateAppointmentSchema = z
  .object({
    startAt: dateTimeSchema.optional(),
    endAt: dateTimeSchema.optional(),
    units: z.coerce.number().int().min(1).max(1000).optional(),
    serviceCode: z.string().trim().max(40).optional(),
    notes: z.string().trim().max(2000).optional(),
    status: z.enum(APPOINTMENT_STATUS).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export const listAppointmentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
  from: dateTimeSchema.optional(),
  to: dateTimeSchema.optional(),
  staffProfileId: uuidSchema.optional(),
  clientId: uuidSchema.optional(),
  status: z.enum(APPOINTMENT_STATUS).optional(),
});

export const appointmentIdParamsSchema = z.object({ appointmentId: uuidSchema });

// --- availability ----------------------------------------------------------

const availabilityWindowSchema = z
  .object({
    dayOfWeek: z.coerce.number().int().min(0).max(6),
    startMinute: z.coerce.number().int().min(0).max(1440),
    endMinute: z.coerce.number().int().min(0).max(1440),
    effectiveFrom: dateTimeSchema.optional(),
    effectiveTo: dateTimeSchema.optional(),
  })
  .strict()
  .refine((w) => w.startMinute < w.endMinute, { message: 'startMinute must be before endMinute' });

// Availability is replaced as a whole set for a staff member.
export const putAvailabilitySchema = z.object({ windows: z.array(availabilityWindowSchema).max(100) }).strict();

export const staffIdParamsSchema = z.object({ staffId: uuidSchema });

// --- authorizations --------------------------------------------------------

export const createAuthorizationSchema = z
  .object({
    clientId: uuidSchema,
    payerName: z.string().trim().max(200).optional(),
    authorizationNumber: z.string().trim().max(120).optional(),
    serviceCode: z.string().trim().max(40).optional(),
    startDate: dateTimeSchema,
    endDate: dateTimeSchema,
    authorizedUnits: z.coerce.number().int().min(0).max(1_000_000),
  })
  .strict();

export const updateAuthorizationSchema = z
  .object({
    payerName: z.string().trim().max(200).optional(),
    authorizationNumber: z.string().trim().max(120).optional(),
    serviceCode: z.string().trim().max(40).optional(),
    startDate: dateTimeSchema.optional(),
    endDate: dateTimeSchema.optional(),
    authorizedUnits: z.coerce.number().int().min(0).max(1_000_000).optional(),
    status: z.enum(AUTHORIZATION_STATUS).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export const listAuthorizationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
  clientId: uuidSchema.optional(),
  status: z.enum(AUTHORIZATION_STATUS).optional(),
});

export const authorizationIdParamsSchema = z.object({ authorizationId: uuidSchema });

/**
 * Appointment note request shapes. `serviceDate` is an organization-timezone
 * civil date ('YYYY-MM-DD'), never an instant — a note belongs to a day on the
 * clinic's calendar, so there is nothing here for a timezone to re-interpret.
 * It is optional; the service defaults to the appointment's first business date.
 */
export const appointmentNoteQuerySchema = z
  .object({ serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
  .strict();

export const saveAppointmentNoteSchema = z
  .object({
    serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    // An empty string clears the note; the field itself is required so a save
    // can never be an accidental no-op the user reads as success.
    note: z.string().max(20000),
    // OPTIONAL client the note relates to. Omit to leave it unchanged; null
    // clears it. The service validates it against the BCBA's assignments.
    clientId: z.string().min(1).max(64).nullable().optional(),
  })
  .strict();

// The overview is always the CURRENT business date, resolved on the server —
// the client cannot request another date or range.
export const appointmentNotesOverviewQuerySchema = z.object({}).strict();
