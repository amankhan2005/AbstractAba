/** Enumerations translated from the Prisma schema. Kept as frozen arrays so
 *  Mongoose `enum` validation and application code share one source. */
export const ORGANIZATION_STATE = ['PROVISIONING', 'PENDING_AGREEMENT', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'DESTROYED'];
export const MEMBERSHIP_STATUS = ['INVITED', 'ACTIVE', 'SUSPENDED', 'REMOVED'];
export const USER_STATUS = ['ACTIVE', 'LOCKED', 'DISABLED'];
export const SESSION_REVOCATION_REASON = ['SIGNED_OUT', 'ROTATED', 'REUSE_DETECTED', 'PASSWORD_CHANGED', 'ADMIN_REVOKED', 'EXPIRED'];
export const AGREEMENT_TYPE = ['BUSINESS_ASSOCIATE', 'TERMS_OF_SERVICE', 'DATA_PROCESSING'];
export const PROVISIONING_STEP_STATE = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'];
export const EXPORT_STATE = ['REQUESTED', 'BUILDING', 'AVAILABLE', 'DOWNLOADED', 'EXPIRED', 'FAILED'];
export const MFA_FACTOR_TYPE = ['TOTP', 'RECOVERY_CODE'];

// --- Clinical spine · Clients (Phase 2 · Module 1) -------------------------
export const CLIENT_STATUS = ['REFERRED', 'INTAKE', 'ACTIVE', 'ON_HOLD', 'DISCHARGED', 'ARCHIVED'];
// --- Clinical spine · Insurance & coverage (blueprint 6.2 / 6.9) -----------
/**
 * Coverage verification lifecycle. Blueprint 6.9: "version one records
 * verification; version 1.5 automates the transaction" — so these are the
 * states a HUMAN verification moves through, not an automated eligibility
 * transaction's response codes.
 *
 * NEEDS_CORRECTION is distinct from FAILED on purpose: a mistyped member id is
 * a clerical problem the front desk fixes in a minute, while a terminated
 * policy is a clinical-operations problem that stops care. Collapsing them into
 * one "not verified" state would put both in the same queue with the same
 * urgency, which is how the fixable one gets lost.
 */
export const INSURANCE_VERIFICATION_STATUS = [
  'UNVERIFIED',        // recorded, not yet checked with the payer
  'PENDING',           // check in progress
  'VERIFIED',          // coverage confirmed active for the service
  'NEEDS_CORRECTION',  // payer could not match the details as entered
  'FAILED',            // payer confirmed no active coverage
  'EXPIRED',           // previously verified, now past its re-verification date
];

/** Order of benefits — coordination of benefits is a 6.2 capability. */
export const BENEFIT_ORDER = ['PRIMARY', 'SECONDARY', 'TERTIARY'];

/** Who the subscriber is relative to the child. */
export const SUBSCRIBER_RELATIONSHIP = ['SELF', 'PARENT', 'SPOUSE', 'GUARDIAN', 'OTHER'];

/** Funding sources, each with its own rule set (blueprint 6.2). */
export const FUNDING_SOURCE = [
  'MEDICAID', 'COMMERCIAL', 'SCHOOL_DISTRICT', 'REGIONAL_CENTRE',
  'SINGLE_CASE_AGREEMENT', 'PRIVATE_PAY',
];

/** The one state that satisfies the scheduling gate. */
export const COVERAGE_SATISFIED = 'VERIFIED';

export const GUARDIAN_RELATIONSHIP = ['PARENT', 'LEGAL_GUARDIAN', 'FOSTER_PARENT', 'RELATIVE', 'SELF', 'OTHER'];
export const CONTACT_TYPE = ['EMERGENCY', 'PHYSICIAN', 'CASE_MANAGER', 'OTHER'];
export const INTAKE_STATUS = ['DRAFT', 'COMPLETE'];

// Operational intake pipeline (BR-INTAKE-1): a child's onboarding paperwork
// progresses through these states. Transitions are guarded in the service so an
// invalid jump (e.g. NOT_SENT -> COMPLETE) is rejected rather than silently set.
export const INTAKE_WORKFLOW_STATUS = ['NOT_SENT', 'SENT', 'HAND_DELIVERED', 'RECEIVED', 'MISSING_DOCUMENTS', 'COMPLETE'];
export const INTAKE_WORKFLOW_TRANSITIONS = {
  NOT_SENT: ['SENT'],
  SENT: ['HAND_DELIVERED', 'RECEIVED', 'MISSING_DOCUMENTS'],
  HAND_DELIVERED: ['RECEIVED', 'MISSING_DOCUMENTS'],
  RECEIVED: ['MISSING_DOCUMENTS', 'COMPLETE'],
  MISSING_DOCUMENTS: ['RECEIVED', 'COMPLETE'],
  COMPLETE: ['MISSING_DOCUMENTS'],
};

// --- Clinical spine · Staff & credentials (Phase 2 · Module 2) -------------
export const STAFF_STATUS = ['ACTIVE', 'INACTIVE'];
// Care-team roles a client/child can have persistently assigned (company-scoped).
export const CARE_TEAM_ROLE = ['MANAGER', 'BCBA', 'RBT', 'THERAPIST'];
// Phase 3: a care-team assignment is ACTIVE until it is explicitly ended.
export const ASSIGNMENT_STATUS = ['ACTIVE', 'ENDED'];
export const CREDENTIAL_STATUS = ['ACTIVE', 'EXPIRED', 'REVOKED'];

// --- Clinical spine · Scheduling & calendar (Phase 2 · Module 3) -----------
export const APPOINTMENT_STATUS = ['SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'];

// --- Phase 4.3 · Recurring appointments ------------------------------------
// A series defines a recurrence rule that materializes concrete appointments.
// Frequency + interval + optional weekdays; bounded by an end date or a count.
export const RECURRENCE_FREQUENCY = ['DAILY', 'WEEKLY'];
export const APPOINTMENT_SERIES_STATUS = ['ACTIVE', 'CANCELLED'];
export const AUTHORIZATION_STATUS = ['ACTIVE', 'EXHAUSTED', 'EXPIRED', 'REVOKED'];

// FBA/ABA administrative authorization workflow (Phase 2). This is DISTINCT from
// the insurance unit-authorization above: it tracks whether the assessment (FBA)
// and treatment (ABA) service lines have been sent to and approved by the payer.
// FBA and ABA are independent records (one each per child) with their own status.
export const SERVICE_AUTH_TYPE = ['FBA', 'ABA'];
export const SERVICE_AUTH_STATUS = ['NOT_SENT', 'SENT', 'APPROVED', 'DENIED'];
export const SERVICE_AUTH_TRANSITIONS = {
  NOT_SENT: ['SENT'],
  SENT: ['APPROVED', 'DENIED'],
  APPROVED: [],
  DENIED: ['SENT'],
};

// --- Clinical spine · Plans, goals, programs & targets (Phase 2 · Module 4)
export const TREATMENT_PLAN_STATUS = ['DRAFT', 'ACTIVE', 'ARCHIVED'];
export const GOAL_TERM = ['LONG_TERM', 'SHORT_TERM'];
export const GOAL_STATUS = ['NOT_STARTED', 'IN_PROGRESS', 'MET', 'DISCONTINUED', 'ARCHIVED'];
export const TARGET_MEASUREMENT_TYPE = ['FREQUENCY', 'DURATION', 'PERCENT_CORRECT', 'RATE', 'TRIALS_TO_CRITERION', 'INTERVAL'];
export const TARGET_STATUS = ['ACTIVE', 'INACTIVE'];

// --- Clinical spine · Session capture & freeze (Phase 2 · Module 5) ---------
/**
 * Session lifecycle — blueprint Figure 6.2.
 *
 *   Scheduled → In progress → Captured → Submitted → Approved → Amended
 *   with Cancelled and Returned as branches.
 *
 * NAMING. The blueprint's "Approved" is this codebase's FROZEN, and its
 * pre-submission working record is DRAFT. Both original names are RETAINED
 * rather than renamed: FROZEN is written into payroll's session import, the
 * billing derivation, the audit catalogue and ~470 existing tests, and a rename
 * would be a wide, risky, purely cosmetic migration. APPROVED is exported below
 * as an alias so new code can use the blueprint's vocabulary, and DRAFT covers
 * both "Scheduled" and "Captured" — the distinction the blueprint draws there is
 * about what the capture screen shows, not about what may be done to the record.
 *
 * The states that genuinely did not exist, and whose absence broke the
 * documented workflow, are IN_PROGRESS (clocked in), RETURNED (BCBA sent it
 * back), CANCELLED and AMENDED.
 */
export const SESSION_STATUS = [
  'DRAFT',        // blueprint: Scheduled / Captured — mutable working record
  'IN_PROGRESS',  // blueprint: In progress — clocked in
  'SUBMITTED',    // awaiting BCBA review
  'RETURNED',     // returned to the technician with a comment
  'FROZEN',       // blueprint: Approved — immutable; the hinge (9.4 step 6)
  'AMENDED',      // superseded by an attributed amendment
  'CANCELLED',    // session did not occur
];

/** The blueprint's vocabulary for the frozen/approved state. */
export const SESSION_APPROVED = 'FROZEN';

// --- Clinical spine · Clinical documents (Phase 2 · Module 6) ---------------
export const DOCUMENT_TYPE = ['ASSESSMENT', 'CONSENT', 'TREATMENT_REPORT', 'AUTHORIZATION_LETTER', 'EVALUATION', 'PROGRESS_NOTE', 'CORRESPONDENCE', 'OTHER'];
export const DOCUMENT_STATUS = ['DRAFT', 'FINALIZED', 'ARCHIVED'];

// --- Phase 3.1 · Subscription billing & payments ---------------------------
export const BILLING_INTERVAL = ['MONTHLY', 'YEARLY'];
export const SUBSCRIPTION_STATUS = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELED'];
export const INVOICE_STATUS = ['DRAFT', 'OPEN', 'PAID', 'VOID', 'UNCOLLECTIBLE'];
export const PAYMENT_STATUS = ['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED'];
export const PAYMENT_METHOD = ['BANK_TRANSFER', 'CHECK', 'CASH', 'OTHER'];
export const CREDIT_NOTE_STATUS = ['ISSUED', 'APPLIED', 'VOID'];

// --- Phase 3.2 · Timesheets & payroll --------------------------------------
export const PAY_RATE_TYPE = ['HOURLY', 'PER_SESSION', 'SALARY'];
export const TIMESHEET_STATUS = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'];
export const TIME_ENTRY_SOURCE = ['SESSION', 'MANUAL'];
export const PAYROLL_RUN_STATUS = ['DRAFT', 'APPROVED', 'FINALIZED'];

// --- Phase 3.3 · Claims & ERA / remittance ---------------------------------
export const CLAIM_STATUS = ['DRAFT', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'DENIED', 'RESUBMITTED', 'PAID', 'CLOSED'];
export const CLAIM_RECONCILIATION_STATUS = ['UNRECONCILED', 'PARTIALLY_PAID', 'RECONCILED'];
export const ERA_FILE_STATUS = ['RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED'];
export const ERA_MATCH_STATUS = ['MATCHED', 'UNMATCHED', 'AMBIGUOUS', 'INVALID', 'RESOLVED'];
export const ADJUSTMENT_GROUP = ['CO', 'PR', 'OA', 'PI', 'CR']; // CARC group codes (contractual, patient responsibility, other, payer initiated, correction)

// --- Phase 3.4 · Reconciliation & financial reporting ----------------------
export const RECONCILIATION_STATUS = ['UNRECONCILED', 'REVIEWING', 'PARTIAL', 'RECONCILED', 'DISCREPANCY', 'RESOLVED'];
export const RECONCILIATION_SOURCE = ['CLAIM', 'INVOICE'];

// --- Phase 4.2 · Supervision workflow --------------------------------------
// Observation lifecycle: a supervisor drafts an observation, submits it, then
// signs it off (server-authoritative). SIGNED is immutable except via an
// explicit correction that supersedes it with a new DRAFT (documents pattern).
export const SUPERVISION_OBSERVATION_STATUS = ['DRAFT', 'SUBMITTED', 'SIGNED', 'SUPERSEDED'];
// Supervision method/setting, mirroring common ABA supervision modalities.
export const SUPERVISION_METHOD = ['IN_PERSON', 'REMOTE', 'HYBRID'];

// --- US states (Module 5: state-specific insurance catalog + company states) --
// The 50 states plus DC. Used by the platform insurance catalog (an entry is
// available in one or more states) and by a company's serviceStates.
//
// SINGLE SOURCE. The list itself lives in @aba1on1/schemas so the API, the
// tenant web app, and the platform console all validate and display against one
// canonical set (Module 5.2) — no file hardcodes its own copy. This module just
// re-exports it so every existing `import { US_STATE_CODES } from './enums.js'`
// keeps working unchanged.
export {
  US_STATES,
  US_STATE_CODES,
  US_STATE_NAME_BY_CODE,
  usStateName,
  isUsStateCode,
} from '@aba1on1/schemas';
