import crypto from 'node:crypto';
import {
  EraFile, EraClaimPayment, PaymentAdjustment, Claim, ClaimStatusEvent,
} from '../../models/index.js';
import { withTenant } from '../../tenancy/tenantContext.js';
import { AppError } from '../../common/errors/AppError.js';
import { parse835, EraParseError } from './era.parser.js';
import { matchEraRecord, reconciliationStatus } from './era.matching.js';
import { recordSafely } from '../audit/audit.service.js';

export const ERA_PROCESS_JOB = 'era.process';

/**
 * ERA / remittance business logic. Tenant-scoped. Upload stores the file and
 * enqueues asynchronous processing on the shared worker (which runs the handler
 * inside withTenant). Processing is idempotent: a file already PROCESSED is not
 * reprocessed, and a payment is posted to a claim at most once per ERA record.
 * Payments remain MANUAL billing — ERA posting creates accounting records only,
 * never contacting any processor.
 */
export class EraService {
  constructor({ jobQueue } = {}) {
    this.jobQueue = jobQueue;
  }

  async uploadFile(orgId, { fileName, content }, actorId) {
    return withTenant(orgId, async () => {
      if (!content || typeof content !== 'string') throw AppError.validation('ERA file content is required.');
      const checksum = crypto.createHash('sha256').update(content).digest('hex');
      const existing = await EraFile.findOne({ checksum });
      if (existing) return existing.toObject(); // idempotent upload (same content)
      const file = await EraFile.create({
        fileName, sizeBytes: Buffer.byteLength(content, 'utf8'), checksum,
        rawContent: content, status: 'RECEIVED', createdBy: actorId,
      });
      if (this.jobQueue) {
        await this.jobQueue.enqueue({
          type: ERA_PROCESS_JOB, tenantId: orgId, actorId,
          payload: { eraFileId: file._id },
          idempotencyKey: `era.process:${file._id}`,
        });
      }
      recordSafely({
        tenantId: orgId, actorId, action: 'era.uploaded', entityType: 'era_file', entityId: file._id,
        outcome: 'success', payload: { fileName: file.fileName, checksum: file.checksum },
      });
      return file.toObject();
    });
  }

  async listFiles(orgId, { status } = {}) {
    return withTenant(orgId, async () =>
      EraFile.find(status ? { status } : {}).sort({ createdAt: -1 }).select('-rawContent').lean());
  }

  async getFile(orgId, id) {
    return withTenant(orgId, async () => {
      const file = await EraFile.findById(id).select('-rawContent').lean();
      if (!file) throw AppError.notFound('ERA-404', 'ERA file not found');
      const records = await EraClaimPayment.find({ eraFileId: id }).lean();
      return { ...file, records };
    });
  }

  async listRecords(orgId, { eraFileId, matchStatus } = {}) {
    return withTenant(orgId, async () => {
      const q = {};
      if (eraFileId) q.eraFileId = eraFileId;
      if (matchStatus) q.matchStatus = matchStatus;
      return EraClaimPayment.find(q).sort({ createdAt: -1 }).lean();
    });
  }

  /**
   * Process an ERA file: parse, create per-claim payment records, match, and
   * post payments/adjustments for unambiguous matches. Idempotent and
   * retry-safe. Runs inside the worker's withTenant context.
   */
  async processFile(orgId, eraFileId, actorId) {
    return withTenant(orgId, async () => {
      const file = await EraFile.findById(eraFileId);
      if (!file) throw AppError.notFound('ERA-404', 'ERA file not found');
      if (file.status === 'PROCESSED') return { alreadyProcessed: true };

      file.status = 'PROCESSING';
      await file.save();

      let parsed;
      try {
        parsed = parse835(file.rawContent);
      } catch (err) {
        file.status = 'FAILED';
        file.failureReason = err instanceof EraParseError ? err.message : 'Parse error';
        await file.save();
        return { failed: true, reason: file.failureReason };
      }

      const candidates = await Claim.find({}).select('_id claimNumber payerControlNumber totalCharge paidAmount adjustmentAmount status').lean();
      let matched = 0; let unmatched = 0; let ambiguous = 0;

      for (const rec of parsed.claims) {
        // Dedupe: skip if this file already produced a record for this control#/claim ref.
        const existing = await EraClaimPayment.findOne({
          eraFileId, payerControlNumber: rec.payerControlNumber ?? null, claimNumberRef: rec.claimNumberRef ?? null,
        });
        if (existing) continue;

        const outcome = matchEraRecord(rec, candidates);
        const payment = await EraClaimPayment.create({
          eraFileId,
          payerControlNumber: rec.payerControlNumber ?? null,
          claimNumberRef: rec.claimNumberRef ?? null,
          chargeAmount: rec.chargeAmount, paidAmount: rec.paidAmount,
          patientResponsibility: rec.patientResponsibility,
          claimStatusCode: rec.claimStatusCode ?? null,
          matchStatus: outcome.status,
          matchedClaimId: outcome.claimId,
          candidateClaimIds: outcome.candidateIds,
          createdBy: actorId,
        });
        // Adjustments (CAS) captured regardless of match, linked to the record.
        for (const adj of rec.adjustments ?? []) {
          await PaymentAdjustment.create({
            claimId: outcome.claimId ?? null, eraClaimPaymentId: payment._id,
            groupCode: adj.groupCode, reasonCode: adj.reasonCode, amount: adj.amount, createdBy: actorId,
          });
        }
        if (outcome.status === 'MATCHED') { matched += 1; await this.#postPayment(payment, actorId); }
        else if (outcome.status === 'AMBIGUOUS') ambiguous += 1;
        else unmatched += 1;
      }

      file.status = 'PROCESSED';
      file.processedAt = new Date();
      file.claimsParsed = parsed.claims.length;
      file.matched = matched; file.unmatched = unmatched; file.ambiguous = ambiguous;
      file.totalPaidAmount = parsed.totalPaidAmount;
      await file.save();
      recordSafely({
        tenantId: orgId, actorId, action: 'era.processed', entityType: 'era_file', entityId: file._id,
        outcome: 'success', payload: { claimsParsed: parsed.claims.length, matched, unmatched, ambiguous },
      });
      return { processed: true, matched, unmatched, ambiguous, claimsParsed: parsed.claims.length };
    });
  }

  // Post a matched ERA payment to its claim (idempotent). Manual accounting only.
  async #postPayment(payment, actorId) {
    if (payment.postedPaymentId) return; // already posted
    const claim = await Claim.findById(payment.matchedClaimId);
    if (!claim) return;
    const adjustments = await PaymentAdjustment.find({ eraClaimPaymentId: payment._id }).lean();
    const adjustmentTotal = adjustments.reduce((s, a) => s + Math.abs(a.amount), 0);

    claim.paidAmount = Math.max(0, (claim.paidAmount ?? 0) + payment.paidAmount);
    claim.adjustmentAmount = Math.max(0, (claim.adjustmentAmount ?? 0) + adjustmentTotal);
    claim.payerControlNumber = claim.payerControlNumber ?? payment.payerControlNumber;
    claim.reconciliationStatus = reconciliationStatus({
      billed: claim.totalCharge, paid: claim.paidAmount, adjustment: claim.adjustmentAmount,
    });
    // Advance claim status when fully covered and currently ACCEPTED/SUBMITTED.
    if (claim.reconciliationStatus === 'RECONCILED' && ['ACCEPTED', 'SUBMITTED'].includes(claim.status)) {
      const from = claim.status;
      claim.status = from === 'SUBMITTED' ? 'ACCEPTED' : 'PAID';
      await ClaimStatusEvent.create({ claimId: claim._id, fromStatus: from, toStatus: claim.status, actorId, reason: 'ERA remittance posted' });
      if (claim.status === 'ACCEPTED') {
        // one more hop to PAID now that it's reconciled
        await ClaimStatusEvent.create({ claimId: claim._id, fromStatus: 'ACCEPTED', toStatus: 'PAID', actorId, reason: 'ERA remittance posted (full)' });
        claim.status = 'PAID';
      }
    }
    claim.updatedBy = actorId;
    await claim.save();

    payment.postedPaymentId = claim._id; // marker: posted to this claim
    payment.matchStatus = 'MATCHED';
    await payment.save();
  }

  /** Manually resolve an unmatched/ambiguous record to a specific claim. */
  async resolveRecord(orgId, recordId, { claimId }, actorId) {
    return withTenant(orgId, async () => {
      const rec = await EraClaimPayment.findById(recordId);
      if (!rec) throw AppError.notFound('ERA-404', 'ERA record not found');
      if (rec.matchStatus === 'RESOLVED' || rec.postedPaymentId) {
        throw AppError.conflict('ERA-409', 'Record already resolved/posted.');
      }
      const claim = await Claim.findById(claimId);
      if (!claim) throw AppError.notFound('ERA-404', 'Claim not found');
      rec.matchedClaimId = claimId;
      rec.matchStatus = 'RESOLVED';
      rec.resolvedAt = new Date(); rec.resolvedBy = actorId;
      await rec.save();
      recordSafely({
        tenantId: orgId, actorId, action: 'era.record_resolved', entityType: 'era_claim_payment', entityId: rec._id,
        outcome: 'success', payload: { claimId, paidAmount: rec.paidAmount },
      });
      // link any captured adjustments to the claim, then post.
      await PaymentAdjustment.updateMany({ eraClaimPaymentId: rec._id }, { $set: { claimId } });
      await this.#postPayment(rec, actorId);
      return rec.toObject();
    });
  }

  async platformOverview() {
    const { withPlatform } = await import('../../tenancy/tenantContext.js');
    return withPlatform(async () => {
      const [received, processing, processed, failed] = await Promise.all([
        EraFile.countDocuments({ status: 'RECEIVED' }),
        EraFile.countDocuments({ status: 'PROCESSING' }),
        EraFile.countDocuments({ status: 'PROCESSED' }),
        EraFile.countDocuments({ status: 'FAILED' }),
      ]);
      const [unmatched, ambiguous] = await Promise.all([
        EraClaimPayment.countDocuments({ matchStatus: 'UNMATCHED' }),
        EraClaimPayment.countDocuments({ matchStatus: 'AMBIGUOUS' }),
      ]);
      return { received, processing, processed, failed, unmatched, ambiguous };
    });
  }
}
