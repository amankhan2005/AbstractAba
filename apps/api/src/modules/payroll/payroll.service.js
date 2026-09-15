import {
  PayRate, PayPeriod, Timesheet, TimeEntry, PayrollRun, PayrollLine, Session,
  StaffProfile, Client, Appointment, Organization, OrganizationSetting,
} from '../../models/index.js';
import { withTenant, withPlatform } from '../../tenancy/tenantContext.js';
import { AppError } from '../../common/errors/AppError.js';
import {
  computeLineAmount, sumMinutes, sumLineAmounts, minutesBetween,
} from './payroll.math.js';
import { resolvePayrollWindow, aggregatePeriodPayroll, byRoleThenName } from './payroll.periods.js';
import { loadStaffActivity, clinicianRoleOf } from '../activity/activity.pipeline.js';
import { clientName } from '../activity/activity.projection.js';
import { buildPayrollWorkbook } from './payroll.xlsx.js';
import { buildPayrollPdf } from './payroll.pdf.js';
import { resolveRoleKeys } from '../staff/staff.repository.js';
import { assertTimesheetTransition, assertPayrollRunTransition } from './payroll.state.js';
import { recordSafely } from '../audit/audit.service.js';
import { scopeToStaff } from '../rbac/scopeFilters.js';
import { scopeAllowsStaff } from '../rbac/dataScope.js';
import { PAYROLL_ELIGIBLE_STATES } from '../sessions/sessions.lifecycle.js';

/**
 * The payable duration of an approved session: the verified clock where it was
 * captured, otherwise the recorded session times. Returns 0 rather than a
 * negative or NaN value for an incoherent pair, so one bad row can never
 * silently reduce a whole period's total.
 */
function payableMinutesOf(session) {
  const start = session.clockInAt ?? session.startedAt;
  const end = session.clockOutAt ?? session.endedAt;
  const minutes = minutesBetween(start, end);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
}

/**
 * Timesheets & payroll business logic. All operations are tenant-scoped via
 * withTenant(orgId) so one company can never touch another's data. All money is
 * computed server-side in integer minor units; a FINALIZED payroll run is
 * immutable.
 */
export class PayrollService {
  /** @param {{ clock?: { now: () => Date } }} [deps] clock: "today" for completed-period rules (injectable for tests). */
  constructor({ clock } = {}) {
    this.clock = clock ?? { now: () => new Date() };
  }

  // ---- pay rates ----
  async createPayRate(orgId, input, actorId) {
    return withTenant(orgId, async () => {
      if (![0, undefined].includes(input.amount) && (!Number.isInteger(input.amount) || input.amount < 0)) {
        throw AppError.validation('amount must be a non-negative integer (minor units).');
      }
      return PayRate.create({ ...input, createdBy: actorId });
    });
  }

  async listPayRates(orgId, { staffProfileId } = {}) {
    return withTenant(orgId, async () =>
      PayRate.find(staffProfileId ? { staffProfileId } : {}).sort({ effectiveFrom: -1 }).lean());
  }

  /** The effective rate for a staff member on a date: latest effectiveFrom <= date. */
  async effectiveRate(orgId, staffProfileId, date) {
    return withTenant(orgId, async () => {
      const d = new Date(date);
      const rates = await PayRate.find({ staffProfileId, effectiveFrom: { $lte: d } })
        .sort({ effectiveFrom: -1 }).lean();
      return rates.find((r) => !r.effectiveTo || new Date(r.effectiveTo) >= d) ?? null;
    });
  }

  // ---- pay periods ----
  async createPayPeriod(orgId, input, actorId) {
    return withTenant(orgId, async () => {
      if (new Date(input.endDate) <= new Date(input.startDate)) {
        throw AppError.validation('endDate must be after startDate.');
      }
      return PayPeriod.create({ ...input, createdBy: actorId });
    });
  }

  async listPayPeriods(orgId) {
    return withTenant(orgId, async () => PayPeriod.find({}).sort({ startDate: -1 }).lean());
  }

  // ---- timesheets ----
  async getOrCreateTimesheet(orgId, { staffProfileId, payPeriodId }, actorId) {
    return withTenant(orgId, async () => {
      const existing = await Timesheet.findOne({ staffProfileId, payPeriodId });
      if (existing) return existing.toObject();
      return (await Timesheet.create({ staffProfileId, payPeriodId, createdBy: actorId })).toObject();
    });
  }

  /**
   * Blueprint 4.5: an RBT has "no financial visibility beyond their own hours",
   * and 4.9 gives tenant-wide timesheet review to Payroll Staff. Both are the
   * same endpoint, separated only by scope — so the scope is applied to the
   * QUERY. Without it, GET /payroll/timesheets returned every technician's
   * hours to every technician.
   */
  async listTimesheets(orgId, { payPeriodId, staffProfileId, status, dataScope } = {}) {
    return withTenant(orgId, async () => {
      const q = {};
      if (payPeriodId) q.payPeriodId = payPeriodId;
      if (staffProfileId) q.staffProfileId = staffProfileId;
      if (status) q.status = status;
      if (dataScope) scopeToStaff(q, dataScope);
      return Timesheet.find(q).sort({ createdAt: -1 }).lean();
    });
  }

  async getTimesheet(orgId, id, { dataScope } = {}) {
    return withTenant(orgId, async () => {
      const ts = await Timesheet.findById(id).lean();
      if (!ts) throw AppError.notFound('PAYROLL-404', 'Timesheet not found');
      // A correct list filter does not protect the by-id read. Refuse as
      // NOT FOUND: confirming that a colleague's timesheet exists is itself a
      // disclosure of who works here and when.
      if (dataScope && !scopeAllowsStaff(dataScope, ts.staffProfileId)) {
        throw AppError.notFound('PAYROLL-404', 'We couldn\u2019t find that timesheet.');
      }
      const entries = await TimeEntry.find({ timesheetId: id }).sort({ workDate: 1 }).lean();
      return { ...ts, entries };
    });
  }

  async #assertEditable(ts) {
    if (ts.status === 'APPROVED') throw AppError.conflict('PAYROLL-409', 'An approved timesheet is immutable.');
    if (ts.status === 'SUBMITTED') throw AppError.conflict('PAYROLL-409', 'Submit must be withdrawn before editing.');
  }

  async #recalcTimesheet(ts) {
    const entries = await TimeEntry.find({ timesheetId: ts._id }).lean();
    ts.totalMinutes = sumMinutes(entries);
    await ts.save();
  }

  /** Import FROZEN sessions in the pay period for this staff member as entries. */
  async importSessions(orgId, timesheetId, actorId) {
    return withTenant(orgId, async () => {
      const ts = await Timesheet.findById(timesheetId);
      if (!ts) throw AppError.notFound('PAYROLL-404', 'Timesheet not found');
      await this.#assertEditable(ts);
      const period = await PayPeriod.findById(ts.payPeriodId).lean();
      if (!period) throw AppError.notFound('PAYROLL-404', 'Pay period not found');
      // BR-PR-1: "Only approved sessions contribute payable direct hours."
      // PAYROLL_ELIGIBLE_STATES is the single shared answer to that question —
      // billing asks it too, and neither module should reimplement it. Drafts,
      // in-progress, submitted, returned, cancelled and amended-away sessions
      // all contribute nothing.
      const sessions = await Session.find({
        staffProfileId: ts.staffProfileId,
        status: { $in: PAYROLL_ELIGIBLE_STATES },
        deletedAt: null,
        startedAt: { $gte: period.startDate, $lte: period.endDate },
      }).lean();
      const existing = new Set(
        (await TimeEntry.find({ timesheetId, source: 'SESSION' }).lean()).map((e) => e.sessionId),
      );
      let imported = 0;
      for (const s of sessions) {
        if (existing.has(s._id)) continue; // dedupe
        // Payable duration comes from the VERIFIED clock where one exists.
        // §6.6 captures clock-in/clock-out as part of the verified visit
        // record; startedAt/endedAt are the scheduled intention. Paying from
        // the intention rather than the verified event is precisely the
        // "billing and payroll drift" the blueprint names as problem P4.
        const minutes = payableMinutesOf(s);
        await TimeEntry.create({
          timesheetId, staffProfileId: ts.staffProfileId, source: 'SESSION', sessionId: s._id,
          workDate: s.startedAt, minutes, createdBy: actorId,
        });
        imported += 1;
      }
      await this.#recalcTimesheet(ts);
      return { imported, totalMinutes: ts.totalMinutes };
    });
  }

  async addManualEntry(orgId, timesheetId, { workDate, minutes, note }, actorId) {
    return withTenant(orgId, async () => {
      const ts = await Timesheet.findById(timesheetId);
      if (!ts) throw AppError.notFound('PAYROLL-404', 'Timesheet not found');
      await this.#assertEditable(ts);
      if (!Number.isInteger(minutes) || minutes < 1) throw AppError.validation('minutes must be a positive integer.');
      const entry = await TimeEntry.create({
        timesheetId, staffProfileId: ts.staffProfileId, source: 'MANUAL',
        workDate, minutes, note: note ?? null, createdBy: actorId,
      });
      await this.#recalcTimesheet(ts);
      return entry.toObject();
    });
  }

  async removeEntry(orgId, timesheetId, entryId, actorId) {
    return withTenant(orgId, async () => {
      const ts = await Timesheet.findById(timesheetId);
      if (!ts) throw AppError.notFound('PAYROLL-404', 'Timesheet not found');
      await this.#assertEditable(ts);
      const entry = await TimeEntry.findOne({ _id: entryId, timesheetId });
      if (!entry) throw AppError.notFound('PAYROLL-404', 'Time entry not found');
      await TimeEntry.deleteOne({ _id: entryId });
      ts.updatedBy = actorId;
      await this.#recalcTimesheet(ts);
      return { removed: true };
    });
  }

  async transitionTimesheet(orgId, id, target, actorId, extra = {}) {
    return withTenant(orgId, async () => {
      const ts = await Timesheet.findById(id);
      if (!ts) throw AppError.notFound('PAYROLL-404', 'Timesheet not found');
      const fromStatus = ts.status;
      assertTimesheetTransition(ts.status, target);
      ts.status = target;
      if (target === 'SUBMITTED') ts.submittedAt = new Date();
      if (target === 'APPROVED') { ts.approvedAt = new Date(); ts.approvedBy = actorId; }
      if (target === 'REJECTED') { ts.rejectedAt = new Date(); ts.rejectionReason = extra.reason ?? null; }
      if (target === 'DRAFT') { ts.submittedAt = null; ts.rejectedAt = null; ts.rejectionReason = null; }
      ts.updatedBy = actorId;
      await ts.save();
      recordSafely({
        tenantId: orgId, actorId, action: 'timesheet.transitioned', entityType: 'timesheet', entityId: ts._id,
        outcome: 'success', payload: { from: fromStatus, to: target },
      });
      return ts.toObject();
    });
  }

  // ---- payroll runs ----
  /**
   * Generate (or regenerate a DRAFT) payroll run from APPROVED timesheets in a
   * pay period. All amounts are computed server-side from effective rates.
   */
  async generatePayrollRun(orgId, { payPeriodId }, actorId) {
    return withTenant(orgId, async () => {
      const period = await PayPeriod.findById(payPeriodId).lean();
      if (!period) throw AppError.notFound('PAYROLL-404', 'Pay period not found');

      let run = await PayrollRun.findOne({ payPeriodId });
      if (run && run.status === 'FINALIZED') {
        throw AppError.conflict('PAYROLL-409', 'Payroll for this period is finalized and cannot be regenerated.');
      }
      if (!run) run = await PayrollRun.create({ payPeriodId, status: 'DRAFT', createdBy: actorId });
      else { await PayrollLine.deleteMany({ payrollRunId: run._id }); } // rebuild draft lines

      const { specs, skipped } = await this.#computeLineSpecs(period);
      const lines = [];
      for (const spec of specs) {
        lines.push(await PayrollLine.create({ payrollRunId: run._id, createdBy: actorId, ...spec }));
      }
      run.totalAmount = sumLineAmounts(lines.map((l) => l.toObject()));
      run.updatedBy = actorId;
      await run.save();
      return { run: run.toObject(), lineCount: lines.length, skipped };
    });
  }

  /**
   * Read-only payroll preview (Phase 4). Computes exactly what generatePayrollRun
   * WOULD produce for a period — same eligibility (APPROVED timesheets), same
   * rate-by-service-date resolution, same integer-cents math — but persists
   * NOTHING (no run, no lines). This is the "preview before commit" surface: a
   * Compute/Preview action must never write payroll. Reuses #computeLineSpecs so
   * preview and commit can never drift.
   */
  async previewPayrollRun(orgId, { payPeriodId }) {
    return withTenant(orgId, async () => {
      const period = await PayPeriod.findById(payPeriodId).lean();
      if (!period) throw AppError.notFound('PAYROLL-404', 'Pay period not found');
      const existing = await PayrollRun.findOne({ payPeriodId }).lean();
      const { specs, skipped } = await this.#computeLineSpecs(period);
      const totalAmount = sumLineAmounts(specs);
      return {
        payPeriodId,
        periodLabel: period.label,
        lines: await this.#enrichLines(specs, period),
        lineCount: specs.length,
        skipped,
        totalAmount,
        currency: specs[0]?.currency ?? 'USD',
        committedStatus: existing?.status ?? null, // null => not yet generated
        persisted: false,
      };
    });
  }

  /**
   * Read-only PRESENTATION enrichment for the Admin payroll drill-down (spec
   * §2/§6/§7). Adds the clinician NAME, ROLE (BCBA/RBT, derived from the
   * persisted appointment assignment), worked hours, and the per-SESSION work
   * entries (child, real session/appointment ids, verified clock-in/out,
   * worked minutes, effective rate, amount) to each already-computed line.
   *
   * This NEVER changes the payroll calculation or the persisted PayrollLine:
   * the authoritative line `amount`/`minutes` come straight from
   * #computeLineSpecs (workedMinutes × effective rate). Per-entry amounts are
   * computed with the SAME server math for display. Worked time is the verified
   * clock (clockInAt/clockOutAt) — never the appointment window. Unresolved
   * lookups return null (no fabricated child/clinician/time). Tenant scoping is
   * inherited from the withTenant() context of the caller.
   */
  async #enrichLines(specs, period) {
    const clientCache = new Map();
    const apptCache = new Map();
    const staffCache = new Map();
    const nameOfClient = async (id) => {
      if (!id) return null;
      if (clientCache.has(id)) return clientCache.get(id);
      let name = null;
      try {
        const c = await Client.findOne({ _id: id }).lean();
        name = c ? (c.preferredName?.trim() || [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || null) : null;
      } catch { name = null; }
      clientCache.set(id, name);
      return name;
    };
    const apptOf = async (id) => {
      if (!id) return null;
      if (apptCache.has(id)) return apptCache.get(id);
      let appt = null;
      try { appt = await Appointment.findOne({ _id: id }).lean(); } catch { appt = null; }
      apptCache.set(id, appt);
      return appt;
    };
    const nameOfStaff = async (id) => {
      if (!id) return null;
      if (staffCache.has(id)) return staffCache.get(id);
      let name = null;
      try {
        const s = await StaffProfile.findOne({ _id: id }).lean();
        name = s ? ([s.firstName, s.lastName].filter(Boolean).join(' ').trim() || null) : null;
      } catch { name = null; }
      staffCache.set(id, name);
      return name;
    };

    const out = [];
    for (const spec of specs) {
      const staffName = await nameOfStaff(spec.staffProfileId);
      const ts = await Timesheet.findOne({ staffProfileId: spec.staffProfileId, payPeriodId: period._id }).lean();
      const timeEntries = ts ? await TimeEntry.find({ timesheetId: ts._id, source: 'SESSION' }).lean() : [];
      let role = null;
      const entries = [];
      for (const te of timeEntries) {
        let clientId = null; let appointmentId = null; let childName = null;
        let clockInAt = null; let clockOutAt = null; let entryRole = null;
        let session = null;
        if (te.sessionId) { try { session = await Session.findOne({ _id: te.sessionId, deletedAt: null }).lean(); } catch { session = null; } }
        if (session) {
          clientId = session.clientId ?? null;
          appointmentId = session.appointmentId ?? null;
          clockInAt = session.clockInAt ?? session.startedAt ?? null;
          clockOutAt = session.clockOutAt ?? session.endedAt ?? null;
          childName = await nameOfClient(clientId);
          const appt = await apptOf(appointmentId);
          if (appt) entryRole = spec.staffProfileId === appt.bcbaId ? 'BCBA' : spec.staffProfileId === appt.rbtId ? 'RBT' : null;
        }
        if (entryRole && !role) role = entryRole;
        const amount = computeLineAmount({ rateType: spec.rateType, rateAmount: spec.rateAmount, minutes: te.minutes, sessionCount: 1 });
        entries.push({
          sessionId: te.sessionId ?? null,
          appointmentId,
          clientId,
          childName,
          workDate: te.workDate ?? null,
          clockInAt,
          clockOutAt,
          workedMinutes: te.minutes,
          rateType: spec.rateType,
          rateAmount: spec.rateAmount,
          currency: spec.currency,
          amount,
        });
      }
      out.push({
        ...spec,
        staffName,
        role, // BCBA | RBT | null (never fabricated)
        hours: Math.floor((spec.minutes ?? 0) / 60),
        minutesRemainder: (spec.minutes ?? 0) % 60,
        entries,
      });
    }
    return out;
  }

  /**
   * Shared, side-effect-free computation for a period: for each APPROVED
   * timesheet, resolve the rate effective on the period start and compute the
   * line amount. Returns line specs (not persisted) plus a skipped count for
   * staff with no configured rate. The single source of truth for both preview
   * and commit.
   */
  async #computeLineSpecs(period) {
    const approved = await Timesheet.find({ payPeriodId: period._id, status: 'APPROVED' }).lean();
    const specs = [];
    let skipped = 0;
    for (const ts of approved) {
      const rate = await this.#effectiveRateInTenant(ts.staffProfileId, period.startDate);
      if (!rate) { skipped += 1; continue; } // no rate configured -> skipped
      const sessionCount = await TimeEntry.countDocuments({ timesheetId: ts._id, source: 'SESSION' });
      const amount = computeLineAmount({
        rateType: rate.rateType, rateAmount: rate.amount,
        minutes: ts.totalMinutes, sessionCount,
      });
      specs.push({
        staffProfileId: ts.staffProfileId,
        rateType: rate.rateType, rateAmount: rate.amount,
        minutes: ts.totalMinutes, sessionCount, amount, currency: rate.currency,
      });
    }
    return { specs, skipped };
  }

  async #effectiveRateInTenant(staffProfileId, date) {
    const d = new Date(date);
    const rates = await PayRate.find({ staffProfileId, effectiveFrom: { $lte: d } })
      .sort({ effectiveFrom: -1 }).lean();
    return rates.find((r) => !r.effectiveTo || new Date(r.effectiveTo) >= d) ?? null;
  }

  async getPayrollRun(orgId, id) {
    return withTenant(orgId, async () => {
      const run = await PayrollRun.findById(id).lean();
      if (!run) throw AppError.notFound('PAYROLL-404', 'Payroll run not found');
      const lines = await PayrollLine.find({ payrollRunId: id }).lean();
      return { ...run, lines };
    });
  }

  async listPayrollRuns(orgId, { payPeriodId, status } = {}) {
    return withTenant(orgId, async () => {
      const q = {};
      if (payPeriodId) q.payPeriodId = payPeriodId;
      if (status) q.status = status;
      return PayrollRun.find(q).sort({ createdAt: -1 }).lean();
    });
  }

  async transitionPayrollRun(orgId, id, target, actorId) {
    return withTenant(orgId, async () => {
      const run = await PayrollRun.findById(id);
      if (!run) throw AppError.notFound('PAYROLL-404', 'Payroll run not found');
      const fromStatus = run.status;
      assertPayrollRunTransition(run.status, target);
      run.status = target;
      if (target === 'APPROVED') { run.approvedAt = new Date(); run.approvedBy = actorId; }
      if (target === 'FINALIZED') {
        run.finalizedAt = new Date(); run.finalizedBy = actorId;
        await PayPeriod.updateOne({ _id: run.payPeriodId }, { $set: { finalizedAt: new Date() } });
      }
      if (target === 'DRAFT') { run.approvedAt = null; run.approvedBy = null; }
      run.updatedBy = actorId;
      await run.save();
      recordSafely({
        tenantId: orgId, actorId, action: 'payroll_run.transitioned', entityType: 'payroll_run', entityId: run._id,
        outcome: 'success', payload: { from: fromStatus, to: target, totalAmount: run.totalAmount },
      });
      return run.toObject();
    });
  }
  // ---- Company Admin period payroll (weekly / bi-weekly / custom) ---------
  //
  // A lighter, session-driven surface than the timesheet→run pipeline above:
  // the Admin picks a PERIOD and immediately sees payroll computed from the
  // authoritative per-session time records (spec §1–§10). It REUSES this
  // module's models, money math (integer cents), effective-rate concept, state
  // machine and duplicate protection — it does NOT introduce a parallel payroll
  // store. Preview persists nothing; generate persists a standard PayrollRun +
  // PayrollLines for the resolved window.

  /** Resolve the company's timezone + week-start for period boundaries (§15).
   *  Payroll's standard week is MONDAY→SUNDAY (spec Phase 5 §4); the org setting
   *  overrides only when explicitly configured. */
  async #periodContext(orgId) {
    return withTenant(orgId, async () => {
      const org = await Organization.findById(orgId).lean().catch(() => null);
      const timeZone = org?.timezone || 'UTC';
      const name = org?.tradingName || org?.legalName || 'Organization';
      let weekStartsOn = 1; // Monday — the payroll standard
      try {
        const s = await OrganizationSetting.findOne({ namespace: 'staffing', key: 'weekStartsOn' }).lean();
        if (s?.value != null && s.value !== '') weekStartsOn = Number(s.value);
      } catch { weekStartsOn = 1; }
      return { timeZone, weekStartsOn, name };
    });
  }

  /**
   * Build per-staff payroll specs for a window from the SAME authoritative set
   * of completed sessions Billing derives from (spec §5/§8/§9).
   *
   * ROOT-CAUSE FIX (RBT missing from Payroll). Payroll previously read ONLY from
   * SessionTimeRecord, which is written solely by the bcba-session self-finalize
   * path. A session that reaches FROZEN through the standard submit→approve
   * review flow — the path a technician's (RBT) session takes, because
   * separation of duties forbids self-approval — never gets a SessionTimeRecord,
   * so it was invisible to Payroll while remaining visible to Billing (which
   * reads Session directly). Result: in a typical clinic only BCBAs (who deliver
   * and self-finalize) appeared. Payroll now enumerates every payroll-eligible
   * (FROZEN) session and USES the SessionTimeRecord.workedMinutes where one
   * exists (authoritative, spec §9), falling back to the session's OWN verified
   * clock otherwise — so BCBA and RBT both appear, from persisted data, however
   * the session was finalized. AMENDED is excluded (BR-PR-1) so hours are never
   * paid twice. One indexed range query + batched id lookups → no N+1 (§21).
   */
  async #computePeriodSpecs(window) {
    // ONE authoritative pipeline (spec §3–§5): the SAME staff-activity dataset
    // Billing derives from. Payroll excludes AMENDED sessions (superseded — no
    // double-pay, BR-PR-1) and applies its own pay rollup on top.
    const ds = await loadStaffActivity(window, { includeAmended: false });
    if (ds.sessions.length === 0) return { staff: [], summary: this.#emptySummary(window) };

    const clientNameById = new Map([...ds.clientById].map(([id, c]) => [id, clientName(c)]));
    // Effective HOURLY rate in integer cents (the pipeline resolved HOURLY only).
    const rateByStaff = new Map([...ds.rateByStaffId].map(([id, r]) => [id, r.rateCents ?? null]));

    // One record per completed session for the aggregator, sourced from the
    // shared normalized activity (worked minutes already authoritative:
    // SessionTimeRecord.workedMinutes where present, else the verified clock).
    const records = ds.activities.map((a) => ({
      sessionId: a.sessionId,
      staffProfileId: a.staffProfileId,
      appointmentId: a.appointmentId,
      clientId: a.clientId,
      startedAt: a.sessionStart,
      endedAt: a.sessionEnd,
      workedMinutes: a.workedMinutes,
      // Carried through so the drilldown and the Excel export can show how many
      // Start/Stop periods made up this one session's worked time.
      intervals: a.intervals ?? [],
      hourlyRateSnapshot: null, // effective rate is authoritative; snapshot unused
    }));

    return aggregatePeriodPayroll({
      records,
      payRatesByStaffId: ds.payRatesByStaffId,
      apptById: ds.apptById,
      staffById: ds.staffById,
      clientNameById,
      rateByStaff,
      roleByStaffId: ds.roleByStaffId,
      window,
    });
  }

  /**
   * Batched effective HOURLY rate per staff (integer cents): latest
   * effectiveFrom <= asOf whose effectiveTo is unset or still on/after asOf.
   * `asOf` defaults to now; the period path passes the period start so the rate
   * used is the one that applied during the work. (Retained for the timesheet
   * pipeline; the period pipeline resolves rates via loadStaffActivity.)
   */
  async #ratesForStaff(staffIds, asOf = new Date()) {
    const map = new Map();
    if (!staffIds.length) return map;
    const at = asOf ? new Date(asOf) : new Date();
    const rates = await PayRate.find({
      staffProfileId: { $in: staffIds },
      rateType: 'HOURLY',
      effectiveFrom: { $lte: at },
    }).sort({ effectiveFrom: -1 }).lean();
    for (const id of staffIds) {
      const active = rates.find((r) => r.staffProfileId === id && (!r.effectiveTo || new Date(r.effectiveTo) >= at));
      map.set(id, active ? active.amount : null); // cents, or null when genuinely none
    }
    return map;
  }

  #emptySummary(window) {
    return {
      periodStart: window.start, periodEnd: window.end,
      staffCount: 0, bcbaCount: 0, rbtCount: 0, sessionCount: 0,
      totalMinutes: 0, totalAmount: 0, missingRateCount: 0, currency: 'usd',
    };
  }

  /** Resolve the requested period in the organization's timezone; weekly / bi-weekly must have finished. */
  async #periodWindow(orgId, { mode, from, to, anchor } = {}) {
    const ctx = await this.#periodContext(orgId);
    const window = resolvePayrollWindow({ mode, from, to, anchor, now: this.clock.now(), timeZone: ctx.timeZone, weekStartsOn: ctx.weekStartsOn, requireCompleted: true });
    return { ...ctx, window };
  }

  #periodOf(window) {
    return {
      mode: window.mode, label: window.label, from: window.from, to: window.to,
      startDate: window.start, endDate: window.end,
      previousAnchor: window.previousAnchor, nextAnchor: window.nextAnchor,
    };
  }

  /** Staff with payable work — exactly what a generated payroll holds. */
  #payableStaff(staff) {
    return staff.filter((s) => s.rateLines.length > 0);
  }

  /** True when the saved lines are the payroll the period computes to now. */
  #linesMatch(lines, staff) {
    const key = (id, minutes, amount, role) => `${id}|${minutes}|${amount}|${role ?? ''}`;
    const saved = lines.map((l) => key(l.staffProfileId, l.minutes, l.amount, l.role)).sort();
    const current = this.#payableStaff(staff).map((s) => key(s.staffProfileId, s.payableMinutes, s.amount, s.role)).sort();
    return saved.length === current.length && saved.every((v, i) => v === current[i]);
  }

  /**
   * Read-only payroll for a chosen period: the weekly / bi-weekly period is the
   * latest COMPLETED one (or a completed one picked via `anchor`); custom is the
   * exact From–To range. Worked time is each completed session's actual worked
   * minutes; the rate is the staff member's Staff Profile rate applicable on each
   * work date. Also reports whether payroll was already generated for the exact
   * period and whether it still matches. Persists nothing.
   */
  async previewPeriodPayroll(orgId, params = {}) {
    const { name, window } = await this.#periodWindow(orgId, params);
    return withTenant(orgId, async () => {
      const { staff, summary } = await this.#computePeriodSpecs(window);
      const period = await PayPeriod.findOne({ startDate: window.start, endDate: window.end }).lean();
      const run = period ? await PayrollRun.findOne({ payPeriodId: period._id }).lean() : null;
      const lines = run ? await PayrollLine.find({ payrollRunId: run._id }).lean() : [];
      return {
        organization: { name },
        period: this.#periodOf(window),
        summary,
        staff,
        committedStatus: run?.status ?? null, // null => not generated
        payrollRunId: run?._id ?? null,
        generatedUpToDate: run ? this.#linesMatch(lines, staff) : null,
        persisted: false,
      };
    });
  }

  /**
   * THE GENERATED PAYROLL for a period, read back from the saved PayrollRun and
   * PayrollLines — the figures shown on the page and in the Excel / PDF
   * downloads, exactly as generated. Null when payroll was not generated for
   * the exact period.
   */
  async getGeneratedPeriodPayroll(orgId, params = {}) {
    const { name, window } = await this.#periodWindow(orgId, params);
    return withTenant(orgId, async () => this.#generatedFor(window, name));
  }

  async #generatedFor(window, name) {
    const period = await PayPeriod.findOne({ startDate: window.start, endDate: window.end }).lean();
    const run = period ? await PayrollRun.findOne({ payPeriodId: period._id }).lean() : null;
    if (!run) return null;
    const lines = await PayrollLine.find({ payrollRunId: run._id }).lean();
    const staffDocs = lines.length ? await StaffProfile.find({ _id: { $in: lines.map((l) => l.staffProfileId) } }).lean() : [];
    const staffById = new Map(staffDocs.map((d) => [d._id, d]));
    // Lines saved before the role was stored: the staff member's own clinical role.
    const legacy = staffDocs.filter((d) => lines.some((l) => l.staffProfileId === d._id && !l.role));
    const keys = legacy.length ? await resolveRoleKeys(legacy) : new Map();
    const staff = lines.map((l) => {
      const sp = staffById.get(l.staffProfileId);
      const hourlyRates = l.hourlyRates?.length ? l.hourlyRates : (l.rateAmount != null ? [l.rateAmount] : []);
      return {
        staffProfileId: l.staffProfileId,
        staffName: sp ? [sp.firstName, sp.middleName, sp.lastName].filter(Boolean).join(' ').trim() : null,
        role: l.role ?? (sp ? clinicianRoleOf(keys.get(sp.userId), sp.discipline) : null),
        hourlyRates,
        hourlyRate: hourlyRates.length === 1 ? hourlyRates[0] : null,
        workedMinutes: l.minutes,
        sessionCount: l.sessionCount,
        amount: l.amount,
        currency: l.currency,
      };
    }).sort(byRoleThenName);
    return {
      organization: { name },
      period: this.#periodOf(window),
      generated: true,
      status: run.status,
      payrollRunId: run._id,
      generatedAt: run.updatedAt ?? run.createdAt ?? null,
      staff,
      summary: {
        staffCount: staff.length,
        bcbaCount: staff.filter((x) => String(x.role ?? '').includes('BCBA')).length,
        rbtCount: staff.filter((x) => String(x.role ?? '').includes('RBT')).length,
        totalMinutes: staff.reduce((t, x) => t + x.workedMinutes, 0),
        totalAmount: run.totalAmount ?? staff.reduce((t, x) => t + x.amount, 0),
        currency: run.currency ?? 'usd',
      },
    };
  }

  /**
   * Generate payroll for a chosen period. Resolves the window, finds-or-creates
   * the PayPeriod for that exact window and saves ONE PayrollRun with one
   * PayrollLine per staff member with payable work. Duplicate protection:
   *   • one run per pay period — generating the same period again never creates
   *     a second run;
   *   • when the saved payroll already matches, nothing is rewritten and the
   *     existing payroll is returned (alreadyGenerated);
   *   • when completed work changed since (e.g. a rate was added), a DRAFT run's
   *     lines are rebuilt (updated); a FINALIZED run is never changed.
   * Everything is recomputed on the server — nothing from the request is trusted.
   */
  async generatePeriodPayroll(orgId, params = {}, actorId) {
    const { name, window } = await this.#periodWindow(orgId, params);
    return withTenant(orgId, async () => {
      const { staff, summary } = await this.#computePeriodSpecs(window);
      const payable = this.#payableStaff(staff);

      let period = await PayPeriod.findOne({ startDate: window.start, endDate: window.end });
      let run = period ? await PayrollRun.findOne({ payPeriodId: period._id }) : null;
      const existingLines = run ? await PayrollLine.find({ payrollRunId: run._id }).lean() : [];

      if (run && this.#linesMatch(existingLines, staff)) {
        return { period: this.#periodOf(window), summary, staff, generated: await this.#generatedFor(window, name), alreadyGenerated: true, updated: false, persisted: true };
      }
      if (payable.length === 0) {
        throw AppError.validation(summary.missingRateCount > 0
          ? 'Some payroll information is incomplete. Add the hourly rate for the staff members listed, then generate payroll.'
          : 'No staff worked during this payroll period.');
      }
      if (run && run.status === 'FINALIZED') {
        throw AppError.conflict('PAYROLL-409', 'Payroll for this period has been finalised and cannot be changed.');
      }

      if (!period) period = await PayPeriod.create({ label: window.label, startDate: window.start, endDate: window.end, createdBy: actorId });
      const updated = Boolean(run);
      if (!run) {
        try {
          run = await PayrollRun.create({ payPeriodId: period._id, status: 'DRAFT', createdBy: actorId });
        } catch (err) {
          if (err?.code !== 11000) throw err;
          run = await PayrollRun.findOne({ payPeriodId: period._id }); // a concurrent run created it first
        }
      }
      await PayrollLine.deleteMany({ payrollRunId: run._id });
      const lines = await PayrollLine.insertMany(payable.map((s) => ({
        payrollRunId: run._id,
        staffProfileId: s.staffProfileId,
        rateType: 'HOURLY',
        rateAmount: s.hourlyRates[0],
        hourlyRates: s.hourlyRates,
        role: s.role,
        minutes: s.payableMinutes,
        sessionCount: s.entries.filter((e) => e.hourlyRate != null).length,
        amount: s.amount,
        currency: s.currency,
        createdBy: actorId,
      })));
      run.totalAmount = sumLineAmounts(lines.map((l) => l.toObject()));
      run.updatedBy = actorId;
      await run.save();

      recordSafely({
        tenantId: orgId, actorId, action: updated ? 'payroll_run.updated_for_period' : 'payroll_run.generated_for_period', entityType: 'payroll_run', entityId: run._id,
        outcome: 'success', payload: { mode: window.mode, start: window.start, end: window.end, totalAmount: run.totalAmount, lineCount: lines.length },
      });

      return {
        period: this.#periodOf(window),
        summary,
        staff,
        generated: await this.#generatedFor(window, name),
        alreadyGenerated: false,
        updated,
        skipped: summary.missingRateCount,
        persisted: true,
      };
    });
  }

  /** The saved payroll for a download, or a clear message when the period has not been generated. */
  async #generatedForExport(orgId, params) {
    const data = await this.getGeneratedPeriodPayroll(orgId, params);
    if (!data) throw AppError.notFound('PAYROLL-404', 'Payroll has not been generated for this period yet. Select Generate Payroll first.');
    return data;
  }

  #exportName(data, ext) {
    return `payroll-${String(data.period.from).replace(/-/g, '')}-${String(data.period.to).replace(/-/g, '')}.${ext}`;
  }

  /** Payroll Summary .xlsx — built only from the generated payroll. */
  async buildPeriodPayrollWorkbook(orgId, params = {}) {
    const data = await this.#generatedForExport(orgId, params);
    return { buffer: buildPayrollWorkbook(data), filename: this.#exportName(data, 'xlsx'), period: data.period, summary: data.summary };
  }

  /** Payroll Summary .pdf — built only from the generated payroll. */
  async buildPeriodPayrollPdf(orgId, params = {}) {
    const data = await this.#generatedForExport(orgId, params);
    return { buffer: buildPayrollPdf(data), filename: this.#exportName(data, 'pdf'), period: data.period, summary: data.summary };
  }

  // ---- operator cross-tenant overview (platform context) ----
  async platformOverview() {
    return withPlatform(async () => {
      const [draftRuns, approvedRuns, finalizedRuns, finalized] = await Promise.all([
        PayrollRun.countDocuments({ status: 'DRAFT' }),
        PayrollRun.countDocuments({ status: 'APPROVED' }),
        PayrollRun.countDocuments({ status: 'FINALIZED' }),
        PayrollRun.find({ status: 'FINALIZED' }).lean(),
      ]);
      const finalizedTotal = finalized.reduce((s, r) => s + (r.totalAmount || 0), 0);
      return { draftRuns, approvedRuns, finalizedRuns, finalizedTotal };
    });
  }
}

