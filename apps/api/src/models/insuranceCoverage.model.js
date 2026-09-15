import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { INSURANCE_VERIFICATION_STATUS, BENEFIT_ORDER, SUBSCRIBER_RELATIONSHIP, FUNDING_SOURCE } from './enums.js';

/**
 * ---------------------------------------------------------------------------
 * INSURANCE COVERAGE — blueprint §6.2 (Clients · Insurance) and the data-model
 * entity "Insurance: Coverage: payer, plan, subscriber, member identifier,
 * effective dates, order of benefits, verification records. Supports primary
 * and secondary coverage."
 *
 * WHY THIS EXISTS. There was no coverage model at all. §6.2's example is
 * explicit about the consequence: "Nothing further can proceed until insurance
 * is verified, and the pipeline says so." Without a verification record there
 * was nothing for that gate to read, so a client could be scheduled and
 * delivered against with no confirmed coverage — the exact failure that
 * produces unbillable delivered care.
 *
 * SCOPE OF VERSION ONE. §6.9 is precise about how far to go: "version one
 * records verification; version 1.5 automates the transaction." This model
 * therefore RECORDS a verification performed by a person against the payer. It
 * deliberately does NOT pretend to run an eligibility transaction — inventing
 * an automated verification the blueprint defers would be inventing a
 * capability the clinic does not have.
 *
 * DATA MINIMISATION. The member identifier is the minimum needed to bill and is
 * stored; no card image, no full subscriber SSN, no plan document is held here.
 * §11.2's principle is to hold what the work requires and no more.
 * ---------------------------------------------------------------------------
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    clientId: { type: String, required: true, index: true },

    // --- Coverage identity (§6.2 "payer, plan, subscriber, member id") ------
    payerName: { type: String, required: true, trim: true, maxlength: 200 },
    // When the payer was chosen from the platform insurance catalog this holds
    // that catalog entry's id; free-text "Other Insurance" leaves it null (spec
    // Module 5.5). payerName is still stored either way so billing/display never
    // depend on a catalog lookup.
    catalogInsuranceId: { type: String, default: null },
    planName: { type: String, default: null, trim: true, maxlength: 200 },
    memberId: { type: String, required: true, trim: true, maxlength: 64 },
    groupNumber: { type: String, default: null, trim: true, maxlength: 64 },

    // Order of benefits. Coordination of benefits is a listed §6.2 capability,
    // and it is the reason this is an order rather than a boolean "is primary".
    benefitOrder: { type: String, enum: BENEFIT_ORDER, default: 'PRIMARY', index: true },

    // Funding source drives a different rule set per §6.2 ("Medicaid ·
    // commercial · school district · regional centre · single-case agreement ·
    // private pay — each with its own rule set").
    fundingSource: { type: String, enum: FUNDING_SOURCE, default: 'COMMERCIAL' },

    // --- Subscriber -------------------------------------------------------
    subscriberRelationship: { type: String, enum: SUBSCRIBER_RELATIONSHIP, default: 'SELF' },
    subscriberName: { type: String, default: null, trim: true, maxlength: 200 },

    // --- Effective dating -------------------------------------------------
    // Coverage that has lapsed must not satisfy the gate, so the dates are
    // part of the eligibility answer rather than decoration.
    effectiveFrom: { type: Date, default: null },
    effectiveTo: { type: Date, default: null },

    // --- Verification record (§6.9 "Coverage verification records with dates,
    // benefit detail, and re-verification prompts") -------------------------
    verificationStatus: {
      type: String,
      enum: INSURANCE_VERIFICATION_STATUS,
      default: 'UNVERIFIED',
      index: true,
    },
    verifiedAt: { type: Date, default: null },
    verifiedBy: { type: String, default: null },   // userId of the verifier
    // What the payer actually said — benefit detail per §6.9.
    benefitNotes: { type: String, default: null, maxlength: 2000 },
    // Why a verification failed or needs correction, so the queue is actionable.
    verificationFailureReason: { type: String, default: null, maxlength: 1000 },
    // Re-verification prompt (§6.9). Coverage is re-checked periodically;
    // holding the due date here lets the pipeline surface it without a job
    // recomputing eligibility from scratch.
    reverificationDueAt: { type: Date, default: null },

    // --- History ----------------------------------------------------------
    // Every verification attempt is appended, never overwritten. A coverage
    // dispute months later is answered by what was checked and when, which a
    // single mutable status field cannot do.
    verificationHistory: [{
      _id: false,
      status: { type: String, enum: INSURANCE_VERIFICATION_STATUS, required: true },
      at: { type: Date, required: true },
      by: { type: String, default: null },
      note: { type: String, default: null, maxlength: 1000 },
    }],

    deletedAt: { type: Date, default: null },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
    version: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false },
);

schema.plugin(tenantPlugin);
schema.index({ tenantId: 1, clientId: 1, benefitOrder: 1 });
schema.index({ tenantId: 1, verificationStatus: 1 });
// Re-verification queue: due coverage, soonest first.
schema.index({ tenantId: 1, reverificationDueAt: 1 });

export const InsuranceCoverage = mongoose.model('InsuranceCoverage', schema);
