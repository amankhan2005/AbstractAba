import {
  Invoice, Payment, CreditNote, Claim, PayrollRun, PayPeriod, EraClaimPayment, ReconciliationRecord,
} from '../../models/index.js';
import { withTenant } from '../../tenancy/tenantContext.js';
import { resolveDateRange, ageBuckets } from './reports.dates.js';
import { collectionRate, sumMinor } from '../reconciliation/reconciliation.engine.js';
import { toCsv } from './reports.csv.js';

/**
 * Financial reporting. Every method is tenant-scoped via withTenant(orgId) and
 * aggregates authoritative source records server-side. All money is integer
 * minor units; the frontend only formats the returned values. Date ranges are
 * resolved server-side from a preset or a validated custom range.
 */
export class ReportsService {
  async revenue(orgId, range) {
    const { from, to } = resolveDateRange(range ?? {});
    return withTenant(orgId, async () => {
      const invoices = await Invoice.find({ createdAt: { $gte: from, $lt: to } }).lean();
      const credits = await CreditNote.find({ createdAt: { $gte: from, $lt: to } }).lean();
      const invoiced = sumMinor(invoices.map((i) => i.total));
      const paid = sumMinor(invoices.map((i) => i.amountPaid));
      const outstanding = sumMinor(invoices.map((i) => Math.max(0, i.amountDue)));
      const creditTotal = sumMinor(credits.map((c) => c.amount));
      return {
        range: { from, to }, invoiced, paid, outstanding, credits: creditTotal,
        collectionRate: collectionRate({ billed: invoiced, collected: paid }),
        invoiceCount: invoices.length,
      };
    });
  }

  async claims(orgId, range) {
    const { from, to } = resolveDateRange(range ?? {});
    return withTenant(orgId, async () => {
      const claims = await Claim.find({ createdAt: { $gte: from, $lt: to } }).lean();
      const byStatus = (s) => claims.filter((c) => c.status === s).length;
      const billed = sumMinor(claims.map((c) => c.totalCharge));
      const paid = sumMinor(claims.map((c) => c.paidAmount));
      const adjustments = sumMinor(claims.map((c) => c.adjustmentAmount));
      const outstanding = sumMinor(claims.map((c) => Math.max(0, c.totalCharge - c.paidAmount - c.adjustmentAmount)));
      return {
        range: { from, to }, total: claims.length,
        submitted: byStatus('SUBMITTED'), accepted: byStatus('ACCEPTED'),
        rejected: byStatus('REJECTED'), denied: byStatus('DENIED'), paid: byStatus('PAID'),
        billedAmount: billed, paidAmount: paid, adjustmentAmount: adjustments, outstandingAmount: outstanding,
      };
    });
  }

  async collections(orgId, range) {
    resolveDateRange(range ?? {}); // validate range param even though aging is "as of now"
    return withTenant(orgId, async () => {
      const open = await Invoice.find({ status: { $in: ['OPEN', 'UNCOLLECTIBLE'] } }).lean();
      const items = open.map((i) => ({ amount: Math.max(0, i.amountDue), date: i.dueDate ?? i.createdAt }));
      const buckets = ageBuckets(items);
      const invoiced = sumMinor(open.map((i) => i.total));
      const paid = sumMinor(open.map((i) => i.amountPaid));
      return { aging: buckets, outstanding: buckets.total, collectionRate: collectionRate({ billed: invoiced, collected: paid }) };
    });
  }

  async payroll(orgId, range) {
    const { from, to } = resolveDateRange(range ?? {});
    return withTenant(orgId, async () => {
      const periods = await PayPeriod.find({ startDate: { $gte: from, $lt: to } }).lean();
      const runs = await PayrollRun.find({}).lean();
      const finalized = runs.filter((r) => r.status === 'FINALIZED');
      const approved = runs.filter((r) => r.status === 'APPROVED');
      return {
        range: { from, to }, payPeriods: periods.length,
        finalizedRuns: finalized.length, approvedRuns: approved.length,
        totalFinalizedCost: sumMinor(finalized.map((r) => r.totalAmount)),
      };
    });
  }

  async reconciliation(orgId) {
    return withTenant(orgId, async () => {
      const recs = await ReconciliationRecord.find({}).lean();
      const by = (s) => recs.filter((r) => r.status === s).length;
      const [unmatchedEra, ambiguousEra] = await Promise.all([
        EraClaimPayment.countDocuments({ matchStatus: 'UNMATCHED' }),
        EraClaimPayment.countDocuments({ matchStatus: 'AMBIGUOUS' }),
      ]);
      const outstanding = sumMinor(recs.map((r) => Math.max(0, r.remainingAmount)));
      return {
        reconciled: by('RECONCILED'), partial: by('PARTIAL'), unreconciled: by('UNRECONCILED'),
        discrepancy: by('DISCREPANCY'), resolved: by('RESOLVED'),
        unmatchedEra, ambiguousEra, outstandingAmount: outstanding,
      };
    });
  }

  async overview(orgId, range) {
    const [rev, clm, col, pay, rec] = await Promise.all([
      this.revenue(orgId, range), this.claims(orgId, range),
      this.collections(orgId, range), this.payroll(orgId, range), this.reconciliation(orgId),
    ]);
    return { revenue: rev, claims: clm, collections: col, payroll: pay, reconciliation: rec };
  }

  // ---- exports (tenant-scoped) ----
  // Single source of truth for exportable report data: { headers, rows,
  // sheetName }. Both CSV and XLSX render this, so the two formats can never
  // diverge and there is no second data path.
  async buildExport(orgId, kind, range) {
    const { from, to } = resolveDateRange(range ?? {});
    return withTenant(orgId, async () => {
      if (kind === 'revenue') {
        const invoices = await Invoice.find({ createdAt: { $gte: from, $lt: to } }).sort({ createdAt: 1 }).lean();
        return {
          sheetName: 'Revenue',
          headers: ['invoiceNumber', 'organizationId', 'total', 'amountPaid', 'amountDue', 'status', 'createdAt'],
          rows: invoices.map((i) => [i.invoiceNumber, i.organizationId, i.total, i.amountPaid, i.amountDue, i.status, new Date(i.createdAt).toISOString()]),
        };
      }
      if (kind === 'claims') {
        const claims = await Claim.find({ createdAt: { $gte: from, $lt: to } }).sort({ createdAt: 1 }).lean();
        return {
          sheetName: 'Claims',
          headers: ['claimNumber', 'payerName', 'servicePeriodStart', 'servicePeriodEnd', 'totalCharge', 'paidAmount', 'adjustmentAmount', 'status', 'reconciliationStatus'],
          rows: claims.map((c) => [c.claimNumber, c.payerName ?? '', c.servicePeriodStart ? new Date(c.servicePeriodStart).toISOString() : '', c.servicePeriodEnd ? new Date(c.servicePeriodEnd).toISOString() : '', c.totalCharge, c.paidAmount, c.adjustmentAmount, c.status, c.reconciliationStatus]),
        };
      }
      if (kind === 'reconciliation') {
        const recs = await ReconciliationRecord.find({}).sort({ updatedAt: 1 }).lean();
        return {
          sheetName: 'Reconciliation',
          headers: ['source', 'claimId', 'invoiceId', 'billedAmount', 'paidAmount', 'adjustmentAmount', 'remainingAmount', 'status', 'lastReconciledAt'],
          rows: recs.map((r) => [r.source, r.claimId ?? '', r.invoiceId ?? '', r.billedAmount, r.paidAmount, r.adjustmentAmount, r.remainingAmount, r.status, r.lastReconciledAt ? new Date(r.lastReconciledAt).toISOString() : '']),
        };
      }
      if (kind === 'payroll') {
        const runs = await PayrollRun.find({}).sort({ createdAt: 1 }).lean();
        return {
          sheetName: 'Payroll',
          headers: ['payPeriodId', 'status', 'totalAmount', 'approvedAt', 'finalizedAt'],
          rows: runs.map((r) => [r.payPeriodId, r.status, r.totalAmount, r.approvedAt ? new Date(r.approvedAt).toISOString() : '', r.finalizedAt ? new Date(r.finalizedAt).toISOString() : '']),
        };
      }
      throw (await import('../../common/errors/AppError.js')).AppError.validation(`Unknown export kind: ${kind}`);
    });
  }

  async exportCsv(orgId, kind, range) {
    const { headers, rows } = await this.buildExport(orgId, kind, range);
    return toCsv(headers, rows);
  }

  async exportXlsx(orgId, kind, range) {
    const { headers, rows, sheetName } = await this.buildExport(orgId, kind, range);
    const { toXlsx } = await import('./reports.xlsx.js');
    return toXlsx(headers, rows, sheetName);
  }

  async platformOverview() {
    const { withPlatform } = await import('../../tenancy/tenantContext.js');
    return withPlatform(async () => {
      const invoices = await Invoice.find({}).lean();
      const claims = await Claim.find({}).lean();
      const finalized = await PayrollRun.find({ status: 'FINALIZED' }).lean();
      const invoiced = sumMinor(invoices.map((i) => i.total));
      const collected = sumMinor(invoices.map((i) => i.amountPaid));
      const outstanding = sumMinor(invoices.map((i) => Math.max(0, i.amountDue)));
      return {
        totalInvoiced: invoiced, totalCollected: collected, outstanding,
        collectionRate: collectionRate({ billed: invoiced, collected }),
        claimRevenue: sumMinor(claims.map((c) => c.paidAmount)),
        payrollCost: sumMinor(finalized.map((r) => r.totalAmount)),
        claimCount: claims.length,
      };
    });
  }
}
