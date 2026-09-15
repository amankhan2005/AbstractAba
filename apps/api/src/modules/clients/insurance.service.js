import { InsuranceCoverage, InsuranceCatalog, Organization, Guardian } from '../../models/index.js';
import { ClientsService } from './clients.service.js';
import { withTenant } from '../../tenancy/tenantContext.js';
import { AppError } from '../../common/errors/AppError.js';
import { coverageStatusFor } from './insuranceGate.js';
import { assertCatalogEligible } from './insuranceEligibility.js';

/**
 * ---------------------------------------------------------------------------
 * INSURANCE COVERAGE SERVICE — blueprint §6.2 / §6.9.
 *
 * The gate (`insuranceGate.js`) decides whether coverage opens the scheduling
 * door. This service is how coverage gets recorded and verified in the first
 * place — without it the gate was enforced but unreachable, which meant every
 * booking was refused with no way for a clinic to clear the refusal. Correct
 * behaviour, unusable product.
 *
 * §6.9 bounds version one precisely: "version one records verification;
 * version 1.5 automates the transaction." So `verify` RECORDS the outcome of a
 * check a person performed against the payer. It does not simulate an
 * eligibility transaction, because pretending to have run one would put a
 * fabricated confirmation in front of a clinic about to deliver care.
 *
 * VERIFICATION IS APPEND-ONLY. Every attempt lands in `verificationHistory`
 * and the current status is a projection of the latest. A coverage dispute six
 * months later is answered by what was checked, by whom, and when — which a
 * single overwritten status field cannot do.
 * ---------------------------------------------------------------------------
 */

/** Statuses a human verifier may record. */
const RECORDABLE = ['PENDING', 'VERIFIED', 'NEEDS_CORRECTION', 'FAILED'];

export class InsuranceService {
  constructor(deps = {}) {
    this.deps = deps;
  }

  /** Coverage records for one client, newest first. */
  async listForClient({ tenantId, clientId }) {
    return withTenant(tenantId, async () => {
      const rows = await InsuranceCoverage.find({ clientId, deletedAt: null })
        .sort({ benefitOrder: 1, createdAt: -1 })
        .lean();
      const mapped = rows.map(toCoverage);
      // Attach the Super-Admin-provided logo for records linked to a catalog
      // entry, so the UI shows the real logo without a second round-trip and
      // never invents one (spec Fix 2 "Insurance logo"). The catalog is global
      // reference data; a missing/removed entry simply yields no logo.
      const catalogIds = [...new Set(mapped.map((c) => c.catalogInsuranceId).filter(Boolean))];
      if (catalogIds.length > 0) {
        const entries = await InsuranceCatalog.find({ _id: { $in: catalogIds } })
          .select({ logoUrl: 1 }).lean();
        const logoById = new Map(entries.map((e) => [e._id, e.logoUrl ?? null]));
        for (const c of mapped) c.logoUrl = c.catalogInsuranceId ? (logoById.get(c.catalogInsuranceId) ?? null) : null;
      } else {
        for (const c of mapped) c.logoUrl = null;
      }
      return mapped;
    });
  }

  /**
   * The client's single eligibility answer, for the pipeline badge.
   * §6.2: "Nothing further can proceed until insurance is verified, and the
   * pipeline says so" — this is the half that says so.
   */
  async statusForClient({ tenantId, clientId }) {
    return withTenant(tenantId, () => coverageStatusFor(clientId));
  }

  async create({ tenantId, clientId, actorUserId, input }) {
    return withTenant(tenantId, async () => {
      // A client carries ONE standard insurance record (spec: single-insurance
      // workflow). Reject a second rather than silently creating a duplicate;
      // enforced on the server so the API can't be used to bypass the UI.
      const existing = await InsuranceCoverage.findOne({ clientId, deletedAt: null }).lean();
      if (existing) throw AppError.conflict('COVERAGE_EXISTS', 'This client already has an insurance record. Edit or remove it first.');
      // Parent prerequisite: insurance is recorded only once the client has a
      // VALID parent/guardian (the same rule that gates activation). Enforced on
      // the server; the intake screen's "Parent details required" mirrors it.
      const guardians = await Guardian.find({ clientId, deletedAt: null }).lean();
      if (!guardians.some((g) => ClientsService.isValidParent(g))) {
        throw new AppError('PARENT_DETAILS_REQUIRED', {
          status: 422,
          message: 'Please add the parent or guardian details before continuing.',
        });
      }
      // Global-catalog eligibility is enforced HERE, not just in the picker.
      // When a global insurance company is referenced, the company must operate
      // in one of its states and it must be active (spec 5.4 / §14); the stored
      // payer name is taken from the catalog, never from the request body, so a
      // hand-crafted call can't reference an insurer it isn't entitled to or
      // relabel one it is. "Other" (no catalogInsuranceId) keeps its free text.
      const catalogFields = await this._resolveCatalogReference(tenantId, input.catalogInsuranceId ?? null);
      // A successfully saved insurance record is VERIFIED (active) immediately —
      // there is no separate manual verification step before it can be used by
      // scheduling and insurance billing. The status is set HERE, on the server,
      // never taken from the request body, and the history records that it was
      // verified automatically on save.
      const now = new Date();
      const doc = await InsuranceCoverage.create({
        ...input,
        ...catalogFields,
        clientId,
        verificationStatus: 'VERIFIED',
        verifiedAt: now,
        verifiedBy: actorUserId,
        verificationHistory: [{
          status: 'VERIFIED',
          at: now,
          by: actorUserId,
          note: 'Verified automatically when the insurance was saved.',
        }],
        createdBy: actorUserId,
        updatedBy: actorUserId,
      });
      return toCoverage(doc.toObject());
    });
  }

  async update({ tenantId, clientId, coverageId, actorUserId, input }) {
    return withTenant(tenantId, async () => {
      const existing = await InsuranceCoverage.findOne({ _id: coverageId, clientId, deletedAt: null });
      if (!existing) throw notFound();

      // If this edit re-points the record at a (different) global insurer, the
      // same server-side eligibility check as create applies. Left alone, the
      // update path would be a way to reach an insurer create refuses.
      if (input.catalogInsuranceId !== undefined) {
        const catalogFields = await this._resolveCatalogReference(tenantId, input.catalogInsuranceId ?? null);
        Object.assign(input, catalogFields);
      }

      Object.assign(existing, input);
      existing.updatedBy = actorUserId;
      existing.version += 1;

      // Saving the insurance details makes the record VERIFIED (active) again —
      // including after correcting a record previously marked as failed or
      // needing correction. No separate verification step is required.
      if (existing.verificationStatus !== 'VERIFIED') {
        const now = new Date();
        existing.verificationStatus = 'VERIFIED';
        existing.verifiedAt = now;
        existing.verifiedBy = actorUserId;
        existing.verificationFailureReason = null;
        existing.verificationHistory.push({ status: 'VERIFIED', at: now, by: actorUserId, note: 'Verified automatically when the insurance was saved.' });
      }

      await existing.save();
      return toCoverage(existing.toObject());
    });
  }

  /**
   * Record the outcome of a verification performed with the payer.
   *
   * @param {'PENDING'|'VERIFIED'|'NEEDS_CORRECTION'|'FAILED'} status
   */
  async verify({ tenantId, clientId, coverageId, actorUserId, status, note = null, benefitNotes = null, reverificationDueAt = null }) {
    if (!RECORDABLE.includes(status)) {
      throw AppError.validation('Please choose a verification result.');
    }
    return withTenant(tenantId, async () => {
      const cov = await InsuranceCoverage.findOne({ _id: coverageId, clientId, deletedAt: null });
      if (!cov) throw notFound();

      const now = new Date();
      cov.verificationStatus = status;
      cov.updatedBy = actorUserId;
      cov.version += 1;

      if (status === 'VERIFIED') {
        cov.verifiedAt = now;
        cov.verifiedBy = actorUserId;
        cov.verificationFailureReason = null;
        if (benefitNotes !== null) cov.benefitNotes = benefitNotes;
        if (reverificationDueAt) cov.reverificationDueAt = new Date(reverificationDueAt);
      } else {
        // A failed or pending check must clear the confirmation, or a
        // previously-verified record keeps opening the gate after the payer
        // has said no.
        cov.verifiedAt = null;
        cov.verifiedBy = null;
        if (status === 'FAILED' || status === 'NEEDS_CORRECTION') {
          cov.verificationFailureReason = note;
        }
      }

      cov.verificationHistory.push({ status, at: now, by: actorUserId, note });
      await cov.save();
      return toCoverage(cov.toObject());
    });
  }

  /** Soft delete — BR-CL-1's spirit: coverage history is never destroyed. */
  async remove({ tenantId, clientId, coverageId, actorUserId }) {
    return withTenant(tenantId, async () => {
      const cov = await InsuranceCoverage.findOne({ _id: coverageId, clientId, deletedAt: null });
      if (!cov) throw notFound();
      cov.deletedAt = new Date();
      cov.updatedBy = actorUserId;
      await cov.save();
      return { id: cov._id, removed: true };
    });
  }

  /**
   * Resolve a coverage record's insurer reference and enforce the global-catalog
   * rule (spec 5.4 / §14).
   *
   * catalogInsuranceId === null  → "Other": a tenant-specific free-text insurer.
   *   No global record is touched; the caller's payerName is kept as-is.
   * catalogInsuranceId is a string → a GLOBAL insurance company. It must exist,
   *   be active, and share at least one state with the company's operating
   *   states; the stored payerName is taken from the catalog, never the body.
   *
   * Company operating states are resolved on the SERVER from the authenticated
   * tenant's organization — never trusted from the request.
   *
   * @returns {object} fields to merge into the coverage document
   *   ({} for "Other", or { payerName, catalogInsuranceId } for a global insurer)
   */
  async _resolveCatalogReference(tenantId, catalogInsuranceId) {
    if (!catalogInsuranceId) return {}; // "Other" — free text, tenant-scoped.
    // The catalog is platform-global (no tenant plugin); read it directly.
    const entry = await InsuranceCatalog.findOne({ _id: catalogInsuranceId, deletedAt: null }).lean();
    const companyStates = await this._companyStates(tenantId);
    const normalized = entry
      ? { id: entry._id, name: entry.name, states: entry.states ?? [], active: entry.active !== false, deletedAt: entry.deletedAt ?? null }
      : null;
    return assertCatalogEligible(normalized, companyStates);
  }

  /** The authenticated company's operating states, server-resolved. */
  async _companyStates(tenantId) {
    const org = await Organization.findOne({ _id: tenantId }).select({ serviceStates: 1, stateCode: 1 }).lean();
    if (!org) return [];
    if (Array.isArray(org.serviceStates) && org.serviceStates.length > 0) {
      return org.serviceStates.map((s) => String(s).toUpperCase());
    }
    return org.stateCode ? [String(org.stateCode).toUpperCase()] : [];
  }
}

/** 404, not 403: a coverage record for a client outside your scope is invisible. */
function notFound() {
  return AppError.notFound('INSURANCE-404', 'We couldn\u2019t find that insurance record.');
}

/**
 * Response shape. Never returns undefined for a list field — React Query
 * rejects undefined, and an absent history should read as "no checks yet"
 * rather than as a broken query.
 */
export function toCoverage(doc) {
  return {
    id: doc._id,
    clientId: doc.clientId,
    payerName: doc.payerName,
    catalogInsuranceId: doc.catalogInsuranceId ?? null,
    planName: doc.planName ?? null,
    memberId: doc.memberId,
    groupNumber: doc.groupNumber ?? null,
    benefitOrder: doc.benefitOrder,
    fundingSource: doc.fundingSource,
    subscriberRelationship: doc.subscriberRelationship,
    subscriberName: doc.subscriberName ?? null,
    effectiveFrom: doc.effectiveFrom ?? null,
    effectiveTo: doc.effectiveTo ?? null,
    verificationStatus: doc.verificationStatus,
    verifiedAt: doc.verifiedAt ?? null,
    verifiedBy: doc.verifiedBy ?? null,
    benefitNotes: doc.benefitNotes ?? null,
    verificationFailureReason: doc.verificationFailureReason ?? null,
    reverificationDueAt: doc.reverificationDueAt ?? null,
    verificationHistory: doc.verificationHistory ?? [],
    version: doc.version ?? 0,
  };
}

export const insuranceService = new InsuranceService();
