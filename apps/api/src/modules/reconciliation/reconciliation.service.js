import {
  ReconciliationRecord, Claim, Invoice, EraClaimPayment,
} from '../../models/index.js';
import { withTenant } from '../../tenancy/tenantContext.js';
import { AppError } from '../../common/errors/AppError.js';
import { computeReconciliation } from './reconciliation.engine.js';
import { assertReconciliationTransition } from './reconciliation.state.js';
import { recordSafely } from '../audit/audit.service.js';

/**
 * Reconciliation business logic. Tenant-scoped. Reconciliation records are
 * derived from authoritative claims/invoices (never duplicating the source of
 * truth); amounts are recomputed server-side. The workflow status is managed
 * through a state machine and every mutation is recorded to the hash-chained
 * audit log via recordSafely (metadata only, never PHI or member identifiers).
 */
export class ReconciliationService {
  /** Build or refresh the reconciliation record for a claim from source data. */
  async refreshClaim(orgId, claimId, actorId) {
    return withTenant(orgId, async () => {
      const claim = await Claim.findById(claimId).lean();
      if (!claim) throw AppError.notFound('RECON-404', 'Claim not found');
      const calc = computeReconciliation({
        billedAmount: claim.totalCharge ?? 0,
        paidAmount: claim.paidAmount ?? 0,
        adjustmentAmount: claim.adjustmentAmount ?? 0,
      });
      let rec = await ReconciliationRecord.findOne({ source: 'CLAIM', claimId });
      if (!rec) rec = new ReconciliationRecord({ source: 'CLAIM', claimId, createdBy: actorId });
      // Preserve a manually-set terminal workflow status; otherwise sync to calc.
      if (!['RECONCILED', 'RESOLVED', 'REVIEWING'].includes(rec.status)) rec.status = calc.status;
      rec.billedAmount = calc.billedAmount;
      rec.paidAmount = calc.paidAmount;
      rec.adjustmentAmount = calc.adjustmentAmount;
      rec.remainingAmount = calc.remainingAmount;
      rec.discrepancyReason = calc.flags.length ? calc.flags.join(',') : null;
      rec.updatedBy = actorId;
      await rec.save();
      return rec.toObject();
    });
  }

  async refreshInvoice(orgId, invoiceId, actorId) {
    return withTenant(orgId, async () => {
      const inv = await Invoice.findById(invoiceId).lean();
      if (!inv) throw AppError.notFound('RECON-404', 'Invoice not found');
      const calc = computeReconciliation({
        billedAmount: inv.total ?? 0,
        paidAmount: inv.amountPaid ?? 0,
        adjustmentAmount: inv.creditsApplied ?? 0,
      });
      let rec = await ReconciliationRecord.findOne({ source: 'INVOICE', invoiceId });
      if (!rec) rec = new ReconciliationRecord({ source: 'INVOICE', invoiceId, createdBy: actorId });
      if (!['RECONCILED', 'RESOLVED', 'REVIEWING'].includes(rec.status)) rec.status = calc.status;
      rec.billedAmount = calc.billedAmount;
      rec.paidAmount = calc.paidAmount;
      rec.adjustmentAmount = calc.adjustmentAmount;
      rec.remainingAmount = calc.remainingAmount;
      rec.discrepancyReason = calc.flags.length ? calc.flags.join(',') : null;
      rec.updatedBy = actorId;
      await rec.save();
      return rec.toObject();
    });
  }

  async list(orgId, { status, source } = {}) {
    return withTenant(orgId, async () => {
      const q = {};
      if (status) q.status = status;
      if (source) q.source = source;
      return ReconciliationRecord.find(q).sort({ updatedAt: -1 }).lean();
    });
  }

  async get(orgId, id) {
    return withTenant(orgId, async () => {
      const rec = await ReconciliationRecord.findById(id).lean();
      if (!rec) throw AppError.notFound('RECON-404', 'Reconciliation record not found');
      return rec;
    });
  }

  async transition(orgId, id, target, actorId, { reason, notes } = {}) {
    return withTenant(orgId, async () => {
      const rec = await ReconciliationRecord.findById(id);
      if (!rec) throw AppError.notFound('RECON-404', 'Reconciliation record not found');
      const fromStatus = rec.status;
      assertReconciliationTransition(rec.status, target);
      rec.status = target;
      if (target === 'RECONCILED' || target === 'RESOLVED') {
        rec.lastReconciledAt = new Date();
        rec.reconciledBy = actorId;
      }
      if (reason) rec.discrepancyReason = reason;
      if (notes != null) rec.notes = notes;
      rec.updatedBy = actorId;
      await rec.save();
      recordSafely({
        tenantId: orgId, actorId, action: 'reconciliation.transitioned', entityType: 'reconciliation_record', entityId: rec._id,
        outcome: 'success', payload: { from: fromStatus, to: target, source: rec.source },
      });
      return rec.toObject();
    });
  }

  /** The unresolved queue: unmatched/ambiguous ERA records + discrepancy recs. */
  async queue(orgId) {
    return withTenant(orgId, async () => {
      const [eraUnresolved, discrepancies] = await Promise.all([
        EraClaimPayment.find({ matchStatus: { $in: ['UNMATCHED', 'AMBIGUOUS'] } }).lean(),
        ReconciliationRecord.find({ status: 'DISCREPANCY' }).lean(),
      ]);
      return {
        eraUnresolved: eraUnresolved.map((e) => ({
          _id: e._id, source: 'ERA', amount: e.paidAmount, reference: e.payerControlNumber ?? e.claimNumberRef,
          matchStatus: e.matchStatus, date: e.createdAt,
        })),
        discrepancies: discrepancies.map((d) => ({
          _id: d._id, source: d.source, amount: d.remainingAmount, reason: d.discrepancyReason, status: d.status,
          claimId: d.claimId, invoiceId: d.invoiceId, date: d.updatedAt,
        })),
      };
    });
  }

  async platformOverview() {
    const { withPlatform } = await import('../../tenancy/tenantContext.js');
    return withPlatform(async () => {
      const [reconciled, partial, unreconciled, discrepancy] = await Promise.all([
        ReconciliationRecord.countDocuments({ status: 'RECONCILED' }),
        ReconciliationRecord.countDocuments({ status: 'PARTIAL' }),
        ReconciliationRecord.countDocuments({ status: 'UNRECONCILED' }),
        ReconciliationRecord.countDocuments({ status: 'DISCREPANCY' }),
      ]);
      const [unmatchedEra, ambiguousEra] = await Promise.all([
        EraClaimPayment.countDocuments({ matchStatus: 'UNMATCHED' }),
        EraClaimPayment.countDocuments({ matchStatus: 'AMBIGUOUS' }),
      ]);
      return { reconciled, partial, unreconciled, discrepancy, unmatchedEra, ambiguousEra };
    });
  }
}
