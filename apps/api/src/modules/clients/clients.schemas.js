import { z } from 'zod';
import {
  CLIENT_STATUS,
  GUARDIAN_RELATIONSHIP,
  CONTACT_TYPE,
  INTAKE_STATUS, INTAKE_WORKFLOW_STATUS, CARE_TEAM_ROLE,
  SUBSCRIBER_RELATIONSHIP,
  SERVICE_AUTH_TYPE, SERVICE_AUTH_STATUS } from '../../models/enums.js';

const uuidSchema = z.string().uuid();
const nameSchema = z.string().trim().min(1).max(100);
const optName = z.string().trim().min(1).max(100).optional();
const optString = z.string().trim().max(300).optional();
const emailSchema = z.string().trim().toLowerCase().email().max(254);
const phoneSchema = z.string().trim().min(3).max(40);

const addressSchema = z
  .object({
    line1: z.string().trim().max(200).optional(),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().max(120).optional(),
    state: z.string().trim().max(120).optional(),
    postalCode: z.string().trim().max(20).optional(),
    country: z.string().trim().max(120).optional(),
  })
  .strict();

// ISO date (YYYY-MM-DD) or full datetime; kept as a string the service parses.
const dateSchema = z
  .string()
  .trim()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date');

// --- client ----------------------------------------------------------------

export const createClientSchema = z
  .object({
    firstName: nameSchema,
    lastName: nameSchema,
    middleName: optName,
    preferredName: optName,
    dateOfBirth: dateSchema.optional(),
    sexAtBirth: z.string().trim().max(40).optional(),
    pronouns: z.string().trim().max(40).optional(),
    status: z.enum(CLIENT_STATUS).optional(),
    approvedWeeklyHours: z.coerce.number().min(0).max(168).nullable().optional(),
    primaryLanguage: z.string().trim().max(80).optional(),
    email: emailSchema.optional(),
    phone: phoneSchema.optional(),
    address: addressSchema.optional(),
    ssn: z.string().trim().min(4).max(40).optional(),
  })
  .strict();

// Every field optional on update; at least one must be supplied.
export const updateClientSchema = createClientSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'Provide at least one field to update' },
);

export const listClientsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
  status: z.enum(CLIENT_STATUS).optional(),
  // Derived ACCOUNT status (Active / Hold / Discharged) — see deriveAccountStatus.
  accountStatus: z.enum(['ACTIVE', 'HOLD', 'DISCHARGED']).optional(),
  search: z.string().trim().min(1).max(100).optional(),
});

export const clientIdParamsSchema = z.object({ clientId: uuidSchema });

// --- FBA/ABA service authorizations (Phase 2) ------------------------------
const authNonNeg = z.coerce.number().min(0);
const isoDate = z.string().trim().min(4);
export const createServiceAuthorizationSchema = z
  .object({
    serviceType: z.enum(SERVICE_AUTH_TYPE),
    authorizationNumber: z.string().trim().max(120).optional(),
    billingCode: z.string().trim().max(60).optional(),
    startDate: isoDate.optional(),
    endDate: isoDate.optional(),
    units: authNonNeg.optional(),
    hours: authNonNeg.optional(),
    unitPrice: authNonNeg.optional(),
    comments: z.string().trim().max(2000).optional(),
  })
  .strict();
export const updateServiceAuthorizationSchema = z
  .object({
    authorizationNumber: z.string().trim().max(120).nullable().optional(),
    billingCode: z.string().trim().max(60).nullable().optional(),
    startDate: isoDate.nullable().optional(),
    endDate: isoDate.nullable().optional(),
    units: authNonNeg.nullable().optional(),
    hours: authNonNeg.nullable().optional(),
    unitPrice: authNonNeg.nullable().optional(),
    comments: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided.' });
export const transitionServiceAuthorizationSchema = z
  .object({ target: z.enum(SERVICE_AUTH_STATUS), reason: z.string().trim().max(500).optional() })
  .strict();
export const authorizationParamsSchema = z.object({ clientId: uuidSchema, authorizationId: uuidSchema });

// Care-team message (Phase 7). Recipient/sender are resolved server-side; the
// client may only supply a message, an optional subject, and an optional NARROWING
// list of care-team assignment ids.
export const parentEmailPreviewSchema = z
  .object({ templateId: z.string().trim().min(1), subject: z.string().trim().max(300).optional(), body: z.string().trim().max(8000).optional() })
  .strict();
export const parentEmailSendSchema = parentEmailPreviewSchema;

// Saved email templates — same field limits as a send.
const templateName = z.string().trim().min(1, 'Template name is required').max(120);
const templateSubject = z.string().trim().min(1, 'Subject is required').max(300);
const templateBody = z.string().trim().min(1, 'Email content is required').max(8000);
export const createEmailTemplateSchema = z.object({ name: templateName, subject: templateSubject, body: templateBody }).strict();
export const updateEmailTemplateSchema = z
  .object({ name: templateName.optional(), subject: templateSubject.optional(), body: templateBody.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });
export const emailTemplateIdParamsSchema = z.object({ templateId: uuidSchema });
export const messageCareTeamSchema = z
  .object({
    subject: z.string().trim().max(200).optional(),
    message: z.string().trim().min(1).max(4000),
    memberIds: z.array(uuidSchema).max(50).optional(),
  })
  .strict();

// Intake pipeline transition — the caller supplies only the target; the service
// validates it against INTAKE_WORKFLOW_TRANSITIONS for the child's current state.
export const intakeWorkflowTransitionSchema = z
  .object({ target: z.enum(INTAKE_WORKFLOW_STATUS), note: z.string().trim().max(500).optional() })
  .strict();

// --- guardian --------------------------------------------------------------

export const createGuardianSchema = z
  .object({
    firstName: nameSchema,
    lastName: nameSchema,
    relationship: z.enum(GUARDIAN_RELATIONSHIP).optional(),
    isPrimary: z.boolean().optional(),
    phone: phoneSchema.optional(),
    email: emailSchema.optional(),
    address: addressSchema.optional(),
    notes: optString,
  })
  .strict();

export const updateGuardianSchema = createGuardianSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'Provide at least one field to update' },
);

export const guardianParamsSchema = z.object({ clientId: uuidSchema, guardianId: uuidSchema });

// --- medical entries (conditions + history) -------------------------------
const medicalDateStr = z.string().trim().min(4);
export const createMedicalSchema = z
  .object({
    type: z.enum(['CONDITION', 'HISTORY']),
    label: nameSchema,
    onsetDate: medicalDateStr.optional(),
    status: z.enum(['ACTIVE', 'RESOLVED', 'CHRONIC', 'MONITORING']).optional(),
    provider: optString,
    notes: optString,
    attachmentDocumentIds: z.array(uuidSchema).max(20).optional(),
  })
  .strict();

export const updateMedicalSchema = createMedicalSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'Provide at least one field to update' },
);

export const listMedicalQuerySchema = z.object({ type: z.enum(['CONDITION', 'HISTORY']).optional() });
export const medicalParamsSchema = z.object({ clientId: uuidSchema, entryId: uuidSchema });

// --- care team (persistent staff assignment) ------------------------------
const hoursSchema = z.coerce.number().min(0).max(168);
const isoDateStr = z.string().trim().min(4);
// Care-team assignment is a MEMBERSHIP relationship only. Staff compensation is
// NOT part of it (spec Module 1/4): the authoritative pay rate lives on the
// staff PayRate model and payroll reads it there. hourlyPayRate / rateEffectiveDate
// are therefore NOT accepted on assign or update — a `.strict()` schema rejects
// them outright, so no request can re-introduce a second source of pay truth.
// The model still carries the legacy columns so historical rows are preserved.
export const assignCareTeamSchema = z
  .object({
    staffProfileId: uuidSchema,
    role: z.enum(CARE_TEAM_ROLE),
    isPrimary: z.boolean().optional(),
    weeklyAssignedHours: hoursSchema.optional(),
    effectiveStartDate: isoDateStr.optional(),
    effectiveEndDate: isoDateStr.optional(),
    notes: z.string().trim().max(300).optional(),
  })
  .strict();
export const updateAssignmentSchema = z
  .object({
    weeklyAssignedHours: hoursSchema.nullable().optional(),
    effectiveEndDate: isoDateStr.nullable().optional(),
    notes: z.string().trim().max(300).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided.' });
export const endAssignmentSchema = z.object({ effectiveEndDate: isoDateStr.optional() }).strict();
export const careTeamParamsSchema = z.object({ clientId: uuidSchema, assignmentId: uuidSchema });

// --- contact ---------------------------------------------------------------

export const createContactSchema = z
  .object({
    name: nameSchema,
    contactType: z.enum(CONTACT_TYPE).optional(),
    phone: phoneSchema.optional(),
    email: emailSchema.optional(),
    organizationName: optName,
    notes: optString,
  })
  .strict();

export const updateContactSchema = createContactSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'Provide at least one field to update' },
);

export const contactParamsSchema = z.object({ clientId: uuidSchema, contactId: uuidSchema });

// --- intake ----------------------------------------------------------------

export const upsertIntakeSchema = z
  .object({
    referralSource: z.string().trim().max(200).optional(),
    referralDate: dateSchema.optional(),
    presentingConcerns: z.string().trim().max(4000).optional(),
    insurance: z
      .object({
        payerName: z.string().trim().max(200).optional(),
        planName: z.string().trim().max(200).optional(),
        memberId: z.string().trim().max(80).optional(),
      })
      .strict()
      .optional(),
    consents: z
      .object({
        hipaaAcknowledged: z.boolean().optional(),
        treatmentConsent: z.boolean().optional(),
      })
      .strict()
      .optional(),
    status: z.enum(INTAKE_STATUS).optional(),
  })
  .strict();


// --- Insurance coverage (blueprint 6.2 / 6.9) -------------------------------
export const coverageIdParamsSchema = z.object({ clientId: uuidSchema, coverageId: uuidSchema });

// Plan Name, Benefit Order and Funding Source were REMOVED from the client
// insurance workflow (spec Fix 2 "Insurance form cleanup"). They are no longer
// accepted on create/update; because these schemas are `.strict()`, a stray
// planName/benefitOrder/fundingSource in a request body is rejected rather than
// silently written. The underlying DB columns are retained on the model for
// backward compatibility with historical records (they simply keep their model
// defaults on new rows) — they are just never presented or accepted here.
const coverageBase = {
  payerName: z.string().trim().min(1).max(200),
  catalogInsuranceId: z.string().trim().min(1).nullable().optional(),
  memberId: z.string().trim().min(1).max(64),
  // groupNumber / subscriberName accept null so an edit can CLEAR a previously
  // set value (the frontend sends `trimmed || null`). Empty string is coerced to
  // null so a cleared field is stored as null rather than '' (spec Bug #2).
  groupNumber: z.string().trim().max(64).nullable().optional().transform((v) => (v === '' ? null : v)),
  subscriberRelationship: z.enum(SUBSCRIBER_RELATIONSHIP).optional(),
  subscriberName: z.string().trim().max(200).nullable().optional().transform((v) => (v === '' ? null : v)),
  effectiveFrom: z.string().datetime().optional(),
  effectiveTo: z.string().datetime().optional(),
};

// `verificationStatus` is deliberately absent from both schemas. A client that
// could set it would walk straight through the scheduling gate. Status changes
// only ever happen through the verify endpoint, which records who checked.
export const createCoverageSchema = z.object(coverageBase).strict();

export const updateCoverageSchema = z
  .object(Object.fromEntries(Object.entries(coverageBase).map(([k, v]) => [k, v.optional()])))
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });

export const verifyCoverageSchema = z.object({
  status: z.enum(['PENDING', 'VERIFIED', 'NEEDS_CORRECTION', 'FAILED']),
  note: z.string().trim().max(1000).optional(),
  benefitNotes: z.string().trim().max(2000).optional(),
  reverificationDueAt: z.string().datetime().optional(),
}).strict();


// --- Guardian invitations (blueprint 2.6 / 6.2) -----------------------------
export const guardianInviteParamsSchema = z.object({ clientId: uuidSchema, guardianId: uuidSchema });
export const guardianInvitationParamsSchema = z.object({ clientId: uuidSchema, invitationId: uuidSchema });

// The guardian's own submission. An ALLOWLIST, not a passthrough: a family may
// correct how the clinic reaches them and nothing else. No clinical field, no
// insurance verification status, no child record field appears here.
export const guardianSubmissionSchema = z.object({
  phone: z.string().trim().max(40).optional(),
  email: emailSchema.optional(),
  addressLine1: z.string().trim().max(200).optional(),
  addressLine2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(20).optional(),
}).strict().refine((v) => Object.keys(v).length > 0, { message: 'Please fill in at least one detail.' });

export const guardianTokenParamsSchema = z.object({ token: z.string().min(20).max(200) });
