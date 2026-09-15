import {
  Claim, ClaimLine, ClaimStatusEvent, Session, Authorization, Client,
  ServiceAuthorization, Organization, InsuranceCoverage, PayRate,
  Appointment, StaffProfile, SessionTimeRecord, ClientAssignment,
} from '../../models/index.js';
import { createHash } from 'node:crypto';
import { newId } from '../../utils/id.js';
import { withTenant } from '../../tenancy/tenantContext.js';
import { AppError } from '../../common/errors/AppError.js';
import { assertClaimTransition } from './claim.state.js';
import { validateSessionForClaim, sumClaimCharges, sumClaimUnits } from './claim.validation.js';
import { aggregateCompanyBilling, aggregateGeneratedBill, authorizationIdFor } from './billing.aggregate.js';
import { loadStaffActivity, clinicianRoleOf } from '../activity/activity.pipeline.js';
import { resolveRoleKeys } from '../staff/staff.repository.js';
import { zonedMidnightToUtc } from '../bcba-session/weeklyHours.js';
import { recordSafely } from '../audit/audit.service.js';

/**
 * Claims business logic. Tenant-scoped via withTenant(orgId). Claims are
 * generated from FROZEN sessions within valid authorizations; the server
 * computes all units and charges. Status is only ever changed through the
 * state machine, which records an immutable ClaimStatusEvent.
 *
 * Charge basis: a fixed per-unit rate (minor units) supplied by the caller/config
 * at generation time. There is no negotiated fee schedule model yet, so the
 * default rate is used and documented as a known limitation.
 */
const DEFAULT_UNIT_CHARGE = 0; // minor units per unit; overridden per generate call

export class ClaimsService {
  async listClaims(orgId, { status, clientId } = {}) {
    return withTenant(orgId, async () => {
      const q = {};
      if (status) q.status = status;
      if (clientId) q.clientId = clientId;
      return Claim.find(q).sort({ createdAt: -1 }).lean();
    });
  }

  async getClaim(orgId, id) {
    return withTenant(orgId, async () => {
      const claim = await Claim.findById(id).lean();
      if (!claim) throw AppError.notFound('CLAIM-404', 'Claim not found');
      const [lines, history] = await Promise.all([
        ClaimLine.find({ claimId: id }).sort({ serviceDate: 1 }).lean(),
        ClaimStatusEvent.find({ claimId: id }).sort({ occurredAt: 1 }).lean(),
      ]);
      return { ...claim, lines, history };
    });
  }

  async getClaimLines(orgId, id) {
    return withTenant(orgId, async () => ClaimLine.find({ claimId: id }).sort({ serviceDate: 1 }).lean());
  }

  async getStatusHistory(orgId, id) {
    return withTenant(orgId, async () => ClaimStatusEvent.find({ claimId: id }).sort({ occurredAt: 1 }).lean());
  }

  async nextClaimNumber(prefix = 'CLM') {
    const now = new Date();
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const count = await Claim.countDocuments({ claimNumber: new RegExp(`^${prefix}-${ym}-`) });
    return `${prefix}-${ym}-${String(count + 1).padStart(5, '0')}`;
  }

  /**
   * Generate a claim from eligible FROZEN sessions for a client within an
   * authorization. Idempotent via generationKey. Server computes units/charges;
   * ineligible sessions are skipped and reported.
   */
  async generateFromSessions(orgId, { clientId, authorizationId, sessionIds, unitCharge = DEFAULT_UNIT_CHARGE, generationKey }, actorId) {
    return withTenant(orgId, async () => {
      if (generationKey) {
        const existing = await Claim.findOne({ generationKey });
        if (existing) return this.getClaim(orgId, existing._id); // idempotent
      }
      const { client, authorization, eligible, skipped, lines, totalUnits, totalCharge } =
        await this.#computeClaimDraft({ clientId, authorizationId, sessionIds, unitCharge });
      if (eligible.length === 0) {
        throw AppError.validation('No eligible sessions to claim.', { skipped });
      }

      const claimNumber = await this.nextClaimNumber();
      const claim = await Claim.create({
        claimNumber, clientId, payerName: authorization?.payerName ?? null,
        authorizationId: authorizationId ?? null,
        servicePeriodStart: lines[0].serviceDate,
        servicePeriodEnd: lines[lines.length - 1].serviceDate,
        totalUnits, totalCharge, status: 'DRAFT',
        generationKey: generationKey ?? null, createdBy: actorId,
      });
      await ClaimLine.insertMany(lines.map((l) => ({ ...l, claimId: claim._id, createdBy: actorId })));
      await ClaimStatusEvent.create({ claimId: claim._id, fromStatus: null, toStatus: 'DRAFT', actorId, reason: 'Generated from sessions' });
      recordSafely({
        tenantId: orgId, actorId, action: 'claim.generated', entityType: 'claim', entityId: claim._id,
        outcome: 'success', payload: { claimNumber: claim.claimNumber, lineCount: lines.length },
      });

      return { ...(await this.getClaim(orgId, claim._id)), skipped };
    });
  }

  /**
   * Read-only billing PREVIEW (Phase 5). Computes exactly what
   * generateFromSessions WOULD produce — same eligibility (validateSessionForClaim:
   * FROZEN state, authorization date-window + remaining units, already-claimed,
   * service code), same server-side unit/charge math — but persists NOTHING (no
   * claim, no lines, no status event). Both preview and commit call the shared
   * #computeClaimDraft, so they can never drift. Billing charge derives from the
   * billing unitCharge, NOT any payroll rate.
   */
  async previewFromSessions(orgId, { clientId, authorizationId, sessionIds, unitCharge = DEFAULT_UNIT_CHARGE }) {
    return withTenant(orgId, async () => {
      const { client, authorization, eligible, skipped, lines, totalUnits, totalCharge } =
        await this.#computeClaimDraft({ clientId, authorizationId, sessionIds, unitCharge });
      return {
        clientId,
        clientName: client ? `${client.lastName}, ${client.firstName}` : null,
        clientNumber: client?.clientNumber ?? null,
        payerName: authorization?.payerName ?? null,
        authorizationId: authorizationId ?? null,
        serviceCode: authorization?.serviceCode ?? null,
        unitCharge,
        lines,
        lineCount: lines.length,
        skipped,
        skippedCount: skipped.length,
        totalUnits,
        totalCharge,
        persisted: false,
      };
    });
  }

  /**
   * Shared, side-effect-free claim computation for a set of sessions. Loads the
   * client, authorization and sessions; validates each session for billing;
   * builds line specs and totals. The single source of truth for both preview
   * and commit — neither reimplements eligibility or charge math.
   */
  async #computeClaimDraft({ clientId, authorizationId, sessionIds, unitCharge = DEFAULT_UNIT_CHARGE }) {
    const client = await Client.findById(clientId).lean();
    if (!client) throw AppError.notFound('CLAIM-404', 'Client not found');
    // Resolve the authorization from EITHER the legacy Authorization model or a
    // 'svc:'-prefixed ServiceAuthorization (used by the child+period billing
    // workflow), normalized to the shape the validator and claim creation
    // expect. Non-'svc:' ids keep the exact legacy behavior.
    let authorization = null;
    if (authorizationId) {
      if (String(authorizationId).startsWith('svc:')) {
        const sa = await ServiceAuthorization.findById(String(authorizationId).slice(4)).lean();
        authorization = sa ? {
          _id: authorizationId,
          serviceCode: sa.billingCode ?? sa.serviceType ?? null,
          authorizationNumber: sa.authorizationNumber ?? null,
          payerName: sa.payerName ?? null,
          startDate: sa.startDate ?? null,
          endDate: sa.endDate ?? null,
          authorizedUnits: sa.units ?? 0,
          usedUnits: sa.usedUnits ?? 0,
        } : null;
      } else {
        authorization = await Authorization.findById(authorizationId).lean();
      }
    }

    const sessions = await Session.find({ _id: { $in: sessionIds ?? [] }, clientId }).lean();
    const claimedSessionIds = new Set(
      (await ClaimLine.find({ sessionId: { $in: sessionIds ?? [] } }).lean()).map((l) => l.sessionId),
    );

    const eligible = [];
    const skipped = [];
    for (const session of sessions) {
      const units = 1; // one unit per session by default (no unit field on session yet)
      const charge = Number.isInteger(unitCharge) ? unitCharge * units : 0;
      const { eligible: ok, reasons } = validateSessionForClaim({
        session, authorization, client,
        alreadyClaimedSessionIds: [...claimedSessionIds], units, charge,
      });
      if (ok) eligible.push({ session, units, charge });
      else skipped.push({ sessionId: session._id, reasons });
    }
    const lines = eligible.map((e) => ({
      sessionId: e.session._id,
      serviceDate: e.session.startedAt,
      staffProfileId: e.session.staffProfileId,
      serviceCode: authorization?.serviceCode ?? null,
      units: e.units,
      charge: e.charge,
      authorizationId: authorizationId ?? null,
    }));
    const totalUnits = sumClaimUnits(lines);
    const totalCharge = sumClaimCharges(lines);
    return { client, authorization, eligible, skipped, lines, totalUnits, totalCharge };
  }

  /**
   * CHILD + PERIOD insurance-billing preview. The same engine and rows as the
   * company view (#billingDataset), restricted to one client — so a child's
   * figures always equal that child's row in the company billing and export.
   */
  async previewChildBilling(orgId, { clientId, from, to } = {}) {
    const { timeZone } = await this.#billingContext(orgId);
    const window = this.#customWindow(from, to, timeZone);
    return withTenant(orgId, async () => {
      const client = await Client.findById(clientId).lean();
      if (!client) throw AppError.notFound('CLAIM-404', 'Client not found');
      const { clients } = await this.#billingDataset(window, { clientId });
      const row = clients[0] ?? null;
      const sessions = row?.sessions ?? [];
      return {
        child: {
          clientId,
          clientName: [client.firstName, client.lastName].filter(Boolean).join(' ').trim() || client.clientNumber || null,
          clientNumber: client.clientNumber ?? null,
        },
        payerName: row?.payerName ?? null,
        period: { label: window.label, startDate: window.start, endDate: window.end, timeZone: window.timeZone },
        authorizations: row?.authorizations ?? [],
        staff: row ? [...row.bcbaStaff, ...row.rbtStaff, ...row.unassignedStaff] : [],
        sessions,
        summary: {
          totalSessions: sessions.length,
          totalWorkedMinutes: row?.totalWorkedMinutes ?? 0,
          bcbaSessions: row?.bcbaSessions ?? 0,
          rbtSessions: row?.rbtSessions ?? 0,
          bcbaCharge: row?.bcbaCharge ?? 0,
          rbtCharge: row?.rbtCharge ?? 0,
          readyCount: row?.readyCount ?? 0,
          billedCount: row?.billedCount ?? 0,
          incompleteCount: row?.incompleteCount ?? 0,
          readyAmount: row?.readyAmount ?? 0,
          billedAmount: row?.billedAmount ?? 0,
          totalClaimAmount: row?.clientTotal ?? 0,
          issues: row?.issues ?? [],
          currency: 'usd',
        },
        persisted: false,
      };
    });
  }

  /** Company timezone + display name for period boundaries and export headers. */
  async #billingContext(orgId) {
    return withTenant(orgId, async () => {
      const org = await Organization.findById(orgId).lean().catch(() => null);
      return { timeZone: org?.timezone || 'UTC', name: org?.tradingName || org?.legalName || 'Organization' };
    });
  }

  /** [from 00:00, (to+1) 00:00) in the org timezone — inclusive of the whole `to` day. */
  #customWindow(from, to, timeZone) {
    const zone = timeZone || 'UTC';
    const parse = (v) => { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null; };
    const f = parse(from); const t = parse(to);
    if (!f || !t) throw AppError.validation('Select a From Date and a To Date.');
    const valid = ({ y, mo, d }) => { const x = new Date(Date.UTC(y, mo - 1, d)); return x.getUTCFullYear() === y && x.getUTCMonth() === mo - 1 && x.getUTCDate() === d; };
    if (!valid(f) || !valid(t)) throw AppError.validation('Enter a valid calendar date.');
    if (`${from}` > `${to}`) throw AppError.validation('From Date must be on or before To Date.');
    const start = zonedMidnightToUtc(f.y, f.mo, f.d, zone);
    const endCivil = new Date(Date.UTC(t.y, t.mo - 1, t.d + 1));
    const end = zonedMidnightToUtc(endCivil.getUTCFullYear(), endCivil.getUTCMonth() + 1, endCivil.getUTCDate(), zone);
    const us = ({ y, mo, d }) => `${String(mo).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
    return { start, end, timeZone: zone, from, to, label: `${us(f)} – ${us(t)}` };
  }

  /**
   * Batch-resolve authorization ids (legacy Authorization or 'svc:'-prefixed
   * ServiceAuthorization) by their INTERNAL id into the normalized shape the
   * billing engine reads. The human authorization number is carried for display
   * only. Archived rows are resolved too, so the engine can say why they are
   * not billable instead of pretending the authorization is missing.
   */
  async #resolveAuthorizations(ids) {
    const map = new Map();
    if (!ids.length) return map;
    const legacyIds = ids.filter((id) => !String(id).startsWith('svc:'));
    const svcIds = ids.filter((id) => String(id).startsWith('svc:')).map((id) => String(id).slice(4));
    const [legacy, svc] = await Promise.all([
      legacyIds.length ? Authorization.find({ _id: { $in: legacyIds } }).lean() : [],
      svcIds.length ? ServiceAuthorization.find({ _id: { $in: svcIds } }).lean() : [],
    ]);
    for (const a of legacy) {
      map.set(a._id, {
        id: a._id, clientId: a.clientId ?? null, authorizationNumber: a.authorizationNumber ?? null,
        serviceType: a.serviceCode ?? null, billingCode: a.serviceCode ?? null,
        authorizedUnits: a.authorizedUnits ?? null, status: a.status ?? null, deletedAt: a.deletedAt ?? null,
        startDate: a.startDate ?? null, endDate: a.endDate ?? null, payerName: a.payerName ?? null,
      });
    }
    for (const a of svc) {
      map.set(`svc:${a._id}`, {
        id: `svc:${a._id}`, clientId: a.clientId ?? null, authorizationNumber: a.authorizationNumber ?? null,
        serviceType: a.serviceType ?? null, billingCode: a.billingCode ?? null,
        authorizedUnits: a.units ?? null, status: a.status ?? null, deletedAt: a.deletedAt ?? null,
        startDate: a.startDate ?? null, endDate: a.endDate ?? null,
      });
    }
    return map;
  }

  /**
   * THE billing dataset for a window (optionally one client), shared by the
   * company preview, generation, the child view and both exports. Assumes an
   * active tenant context. One batched query per collection across all clients:
   * completed sessions + time records + appointments + staff + clients (the
   * shared activity pipeline), then authorizations, the clinicians' HOURLY pay
   * rates (the Staff Profile rate), existing claim lines and insurance coverage.
   */
  async #billingDataset(window, { clientId = null } = {}) {
    const ds = await loadStaffActivity(window, { statuses: ['FROZEN', 'SUBMITTED', 'AMENDED'] });
    const sessions = clientId ? ds.sessions.filter((x) => x.clientId === clientId) : ds.sessions;
    if (sessions.length === 0) return aggregateCompanyBilling({ window });

    const sessionIds = sessions.map((x) => x._id);
    const clientIds = [...new Set(sessions.map((x) => x.clientId).filter(Boolean))];
    const staffIds = [...new Set(sessions.map((x) => x.staffProfileId).filter(Boolean))];
    const authIds = [...new Set(sessions.map((x) => authorizationIdFor(x, ds.apptById.get(x.appointmentId))).filter(Boolean))];

    const [authById, claimedLines, coverages, payRates] = await Promise.all([
      this.#resolveAuthorizations(authIds),
      ClaimLine.find({ sessionId: { $in: sessionIds } }).lean(),
      InsuranceCoverage.find({ clientId: { $in: clientIds }, deletedAt: null }).lean(),
      PayRate.find({ staffProfileId: { $in: staffIds }, rateType: 'HOURLY' }).lean(),
    ]);
    const claims = claimedLines.length
      ? await Claim.find({ _id: { $in: [...new Set(claimedLines.map((l) => l.claimId))] } }).select({ claimNumber: 1 }).lean()
      : [];
    const claimNumberById = new Map(claims.map((c) => [c._id, c.claimNumber]));
    const coveragesByClient = new Map(clientIds.map((id) => [id, []]));
    for (const c of coverages) coveragesByClient.get(c.clientId)?.push(c);
    const payRatesByStaffId = new Map(staffIds.map((id) => [id, []]));
    for (const r of payRates) payRatesByStaffId.get(r.staffProfileId)?.push(r);

    return aggregateCompanyBilling({
      sessions,
      workedById: ds.workedById,
      apptById: ds.apptById,
      staffById: ds.staffById,
      clientById: ds.clientById,
      roleByStaffId: ds.roleByStaffId,
      authById,
      payRatesByStaffId,
      claimedLineBySession: new Map(claimedLines.map((l) => [l.sessionId, { charge: l.charge, hourlyRate: l.hourlyRate ?? null, claimId: l.claimId, claimNumber: claimNumberById.get(l.claimId) ?? null }])),
      coveragesByClient,
      timeZone: window.timeZone,
      window,
    });
  }


  async submitClaim(orgId, id, actorId) {
    return this.transition(orgId, id, 'SUBMITTED', actorId, { setSubmitted: true });
  }

  /** Child + period .xlsx — the same rows as the child and company views. */
  async buildChildBillingWorkbook(orgId, { clientId, from, to } = {}) {
    const data = await this.previewChildBilling(orgId, { clientId, from, to });
    const { buildInsuranceWorkbook } = await import('./claims.xlsx.js');
    const buffer = buildInsuranceWorkbook(data);
    const safe = String(data.child?.clientName || 'child').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '');
    return { buffer, filename: `insurance-billing-${safe || 'child'}.xlsx`, child: data.child, period: data.period };
  }

  /** Generate insurance billing for one child + period — the consolidated run restricted to that child. */
  async generateChildBilling(orgId, { clientId, from, to } = {}, actorId) {
    const run = await this.generateCompanyBilling(orgId, { from, to }, actorId, { clientId });
    const after = await this.previewChildBilling(orgId, { clientId, from, to });
    return {
      child: after.child,
      payerName: after.payerName,
      period: after.period,
      claims: run.claims,
      claimCount: run.claimCount,
      alreadyGenerated: run.alreadyGenerated,
      summary: after.summary,
      persisted: true,
    };
  }

  /**
   * COMPANY-WIDE billing PREVIEW. Given only a date range, the server finds
   * every qualifying session in the organization for the window (org timezone,
   * inclusive dates) and returns the consolidated result: per client, BCBA and
   * RBT activity kept separate with their insurance rates and charges, per-
   * session detail with review reasons, client totals and the company total.
   * Read-only.
   */
  async previewCompanyBilling(orgId, { from, to } = {}, { clientId = null } = {}) {
    const { timeZone, name } = await this.#billingContext(orgId);
    const window = this.#customWindow(from, to, timeZone);
    return withTenant(orgId, async () => {
      const agg = await this.#billingDataset(window, { clientId });
      return {
        organization: { name },
        period: { label: window.label, from: window.from, to: window.to, startDate: window.start, endDate: window.end, timeZone: window.timeZone },
        ...agg,
        persisted: false,
      };
    });
  }

  /**
   * ONE consolidated billing run for the organization and period. The server
   * recomputes the authoritative dataset and bills its READY sessions — every
   * completed session with complete billing data, no manual approval — as ONE
   * claim per client. Each claim line is one session carrying exactly the
   * preview's amount (the clinician's charge allocated by worked minutes), its
   * role, worked minutes and hourly rate, so claims, page and XLSX reconcile to
   * the cent. Duplicate protection:
   *   • a session already on a claim line is BILLED and never billed again;
   *   • the claim's generationKey hashes the exact session set, so a repeated or
   *     concurrent run for the same work returns without a second claim;
   *   • the unique (tenant, session) claim-line index is the last guard — a lost
   *     race removes the half-written claim instead of double billing.
   * Running again after everything is billed returns alreadyGenerated: true.
   * Running again after MORE sessions became ready (e.g. an RBT's hourly rate
   * was added after the first run) adds them to that client's DRAFT claim for
   * the same period, so the persisted bill — and its Excel — gains the RBT.
   */
  async generateCompanyBilling(orgId, { from, to } = {}, actorId, { clientId = null } = {}) {
    const preview = await this.previewCompanyBilling(orgId, { from, to }, { clientId });
    const groups = preview.clients
      .map((c) => ({ client: c, rows: c.sessions.filter((r) => r.billingStatus === 'READY') }))
      .filter((g) => g.rows.length > 0);

    if (groups.length === 0) {
      if (preview.summary.alreadyBilled > 0) {
        // Nothing new to bill: the period's bill already exists — return it, never a duplicate.
        const bill = await this.getGeneratedBill(orgId, { from, to });
        return { ...preview, bill, generatedAt: bill?.generatedAt ?? null, alreadyGenerated: true, clientCount: 0, claimCount: 0, updatedClaimCount: 0, addedSessionCount: 0, claims: [], generatedAmount: 0, persisted: true };
      }
      const n = preview.summary.incomplete;
      throw AppError.validation(n > 0
        ? `Some billing information is incomplete for ${n} session${n === 1 ? '' : 's'}. Add the missing information, then generate the bill.`
        : 'No completed sessions were recorded in this period.', { issues: preview.summary.issues });
    }

    const created = [];
    await withTenant(orgId, async () => {
      for (const g of groups) {
        const rows = [...g.rows].sort((a, b) => new Date(a.workDate) - new Date(b.workDate));
        // The period already has this client's DRAFT claim (e.g. generated before
        // the RBT's hourly rate existed): the newly ready sessions are ADDED to it,
        // so the client keeps ONE bill with BCBA and RBT together.
        const existing = await Claim.findOne({ clientId: g.client.clientId, billingPeriodStart: preview.period.from, billingPeriodEnd: preview.period.to, status: 'DRAFT' })
          .sort({ createdAt: 1 }).lean();
        if (existing) {
          const added = await this.#attachLines(existing, rows, actorId);
          if (added.length === 0) continue;
          const addedCharge = added.reduce((t, l) => t + l.charge, 0);
          recordSafely({
            tenantId: orgId, actorId, action: 'claim.lines_added', entityType: 'claim', entityId: existing._id,
            outcome: 'success', payload: { claimNumber: existing.claimNumber, lineCount: added.length, addedCharge },
          });
          created.push({
            id: existing._id, claimNumber: existing.claimNumber, status: existing.status, updated: true,
            clientId: g.client.clientId, clientName: g.client.clientName, payerName: existing.payerName,
            sessionCount: added.length, totalCharge: addedCharge,
          });
          continue;
        }

        const digest = createHash('sha256').update(rows.map((r) => r.sessionId).sort().join(',')).digest('hex').slice(0, 24);
        const generationKey = `billing:${g.client.clientId}:${digest}`;
        if (await Claim.findOne({ generationKey }).lean()) continue;

        const totalCharge = sumClaimCharges(rows.map((r) => ({ charge: r.amount })));
        const authIds = [...new Set(rows.map((r) => r.authorizationId))];
        const payers = [...new Set(rows.map((r) => r.payerName).filter(Boolean))];
        const claim = await this.#createClaimWithNumber({
          clientId: g.client.clientId,
          payerName: payers.join(', ') || null,
          authorizationId: authIds.length === 1 ? authIds[0] : null,
          servicePeriodStart: rows[0].workDate,
          servicePeriodEnd: rows[rows.length - 1].workDate,
          totalUnits: rows.length, totalCharge, status: 'DRAFT', generationKey, createdBy: actorId,
          billingPeriodStart: preview.period.from, billingPeriodEnd: preview.period.to,
        });
        if (!claim) continue; // the same work was generated concurrently
        const added = await this.#attachLines(claim, rows, actorId);
        if (added.length === 0) continue; // a concurrent run billed these sessions first
        const lineCharge = added.reduce((t, l) => t + l.charge, 0);
        await ClaimStatusEvent.create({ claimId: claim._id, fromStatus: null, toStatus: 'DRAFT', actorId, reason: `Generated from billing ${preview.period.label}` });
        recordSafely({
          tenantId: orgId, actorId, action: 'claim.generated', entityType: 'claim', entityId: claim._id,
          outcome: 'success', payload: { claimNumber: claim.claimNumber, lineCount: added.length, totalCharge: lineCharge },
        });
        created.push({
          id: claim._id, claimNumber: claim.claimNumber, status: claim.status, updated: false,
          clientId: g.client.clientId, clientName: g.client.clientName, payerName: claim.payerName,
          sessionCount: added.length, totalCharge: lineCharge,
        });
      }
    });

    const [after, bill] = await Promise.all([
      this.previewCompanyBilling(orgId, { from, to }, { clientId }),
      this.getGeneratedBill(orgId, { from, to }),
    ]);
    const updatedCount = created.filter((c) => c.updated).length;
    return {
      ...after,
      bill,
      generatedAt: new Date().toISOString(),
      alreadyGenerated: created.length === 0,
      clientCount: created.length,
      claimCount: created.length - updatedCount,
      updatedClaimCount: updatedCount,
      addedSessionCount: created.reduce((t, c) => t + c.sessionCount, 0),
      claims: created,
      generatedAmount: created.reduce((t, c) => t + c.totalCharge, 0),
      persisted: true,
    };
  }

  /**
   * Put ready rows on a claim as claim lines — each carrying the preview's
   * role, worked minutes, hourly rate and charge — then recompute the claim's
   * totals from ALL of its persisted lines. The unique (tenant, session) line
   * index is the double-billing guard: a session another run already billed is
   * skipped, never billed twice. Returns the lines this call added. A claim left
   * with no lines at all (every session lost to a concurrent run) is removed.
   */
  async #attachLines(claim, rows, actorId) {
    const docs = rows.map((r) => ({
      _id: newId(), claimId: claim._id, sessionId: r.sessionId, serviceDate: r.workDate, staffProfileId: r.staffProfileId,
      serviceCode: r.billingCode, units: 1, charge: r.amount, authorizationId: r.authorizationId,
      role: r.role, workedMinutes: r.workedMinutes, hourlyRate: r.hourlyRate, createdBy: actorId,
    }));
    try {
      await ClaimLine.insertMany(docs, { ordered: false });
    } catch (err) {
      const duplicatesOnly = err?.code === 11000 || (Array.isArray(err?.writeErrors) && err.writeErrors.length > 0 && err.writeErrors.every((e) => (e.code ?? e.err?.code) === 11000));
      if (!duplicatesOnly) throw err;
    }
    const lines = await ClaimLine.find({ claimId: claim._id }).sort({ serviceDate: 1 }).lean();
    if (lines.length === 0) {
      await Claim.deleteOne({ _id: claim._id });
      return [];
    }
    if (!(await Claim.exists({ _id: claim._id }))) {
      // The claim vanished underneath us (a concurrent run found it empty): never leave orphan lines.
      await ClaimLine.deleteMany({ claimId: claim._id });
      return [];
    }
    await Claim.updateOne({ _id: claim._id }, { $set: {
      totalCharge: sumClaimCharges(lines), totalUnits: lines.length,
      servicePeriodStart: lines[0].serviceDate, servicePeriodEnd: lines[lines.length - 1].serviceDate,
    } });
    const mine = new Set(docs.map((d) => d._id));
    return lines.filter((l) => mine.has(l._id));
  }

  /**
   * Create a claim with the next claim number. A duplicate claim NUMBER (two
   * runs numbering at once) retries with a fresh number; a duplicate
   * generationKey means the identical work was just generated — return null.
   */
  async #createClaimWithNumber(fields) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await Claim.create({ ...fields, claimNumber: await this.nextClaimNumber() });
      } catch (err) {
        if (err?.code !== 11000) throw err;
        if (err?.keyPattern?.generationKey || /generationKey/.test(err?.message ?? '')) return null;
      }
    }
    throw AppError.conflict('CLAIM_NUMBER_CONFLICT', 'Unable to generate the bill. Please try again.');
  }

  /**
   * THE GENERATED BILL for a billing period — read back from the persisted
   * claims: every claim line whose service date falls in the period (org
   * timezone, inclusive dates), with the role, worked minutes, hourly rate and
   * charge stored at generation. Nothing is recalculated, so the page, the Excel
   * and the PDF always show exactly what was generated — after a refresh, a
   * later rate change or reopening the bill. Null when nothing was generated.
   */
  async getGeneratedBill(orgId, { from, to } = {}) {
    const { timeZone, name } = await this.#billingContext(orgId);
    const window = this.#customWindow(from, to, timeZone);
    return withTenant(orgId, async () => {
      const lines = await ClaimLine.find({ serviceDate: { $gte: window.start, $lt: window.end } }).lean();
      if (lines.length === 0) return null;
      const claimIds = [...new Set(lines.map((l) => l.claimId))];
      const sessionIds = [...new Set(lines.map((l) => l.sessionId))];
      const [claims, sessions] = await Promise.all([
        Claim.find({ _id: { $in: claimIds } }).lean(),
        Session.find({ _id: { $in: sessionIds } }).lean(),
      ]);
      const clientIds = [...new Set(claims.map((c) => c.clientId))];
      const staffIds = [...new Set(lines.map((l) => l.staffProfileId).filter(Boolean))];
      const apptIds = [...new Set(sessions.map((x) => x.appointmentId).filter(Boolean))];
      // Lines generated before role / worked minutes were stored on the line.
      const legacy = lines.filter((l) => !l.role || !Number.isFinite(l.workedMinutes));
      const [appts, staff, clients, authById, timeRecords, assignments] = await Promise.all([
        apptIds.length ? Appointment.find({ _id: { $in: apptIds } }).lean() : [],
        staffIds.length ? StaffProfile.find({ _id: { $in: staffIds } }).lean() : [],
        Client.find({ _id: { $in: clientIds } }).lean(),
        this.#resolveAuthorizations([...new Set(lines.map((l) => l.authorizationId).filter(Boolean))]),
        legacy.length ? SessionTimeRecord.find({ sessionId: { $in: legacy.map((l) => l.sessionId) } }).lean() : [],
        legacy.length ? ClientAssignment.find({ clientId: { $in: clientIds }, staffProfileId: { $in: staffIds }, role: { $in: ['BCBA', 'RBT'] } }).lean() : [],
      ]);
      const roleByStaffId = new Map();
      if (legacy.length) {
        for (const a of assignments) if ((a.status ?? 'ACTIVE') === 'ACTIVE' && !roleByStaffId.has(a.staffProfileId)) roleByStaffId.set(a.staffProfileId, a.role);
        const unresolved = staff.filter((x) => !roleByStaffId.has(x._id));
        const keys = unresolved.length ? await resolveRoleKeys(unresolved) : new Map();
        for (const x of unresolved) { const role = clinicianRoleOf(keys.get(x.userId), x.discipline); if (role) roleByStaffId.set(x._id, role); }
      }
      const workedBySession = new Map(timeRecords.map((t) => [t.sessionId, t.workedMinutes]));
      const agg = aggregateGeneratedBill({
        claims,
        lines: lines.map((l) => (Number.isFinite(l.workedMinutes) || !workedBySession.has(l.sessionId) ? l : { ...l, workedMinutes: workedBySession.get(l.sessionId) })),
        sessionsById: new Map(sessions.map((x) => [x._id, x])),
        apptById: new Map(appts.map((a) => [a._id, a])),
        staffById: new Map(staff.map((x) => [x._id, x])),
        clientById: new Map(clients.map((c) => [c._id, c])),
        authById,
        roleByStaffId,
        timeZone: window.timeZone,
        window,
      });
      const clientNameById = new Map(agg.clients.map((c) => [c.clientId, c.clientName]));
      const linesByClaim = new Map();
      for (const l of lines) linesByClaim.set(l.claimId, (linesByClaim.get(l.claimId) ?? []).concat(l));
      const billClaims = claims
        .map((c) => {
          const own = linesByClaim.get(c._id) ?? [];
          return {
            id: c._id, claimNumber: c.claimNumber, status: c.status, clientId: c.clientId,
            clientName: clientNameById.get(c.clientId) ?? null, payerName: c.payerName ?? null,
            sessionCount: own.length, totalCharge: own.reduce((t, l) => t + (l.charge ?? 0), 0),
            createdAt: c.createdAt ?? null,
          };
        })
        .sort((a, b) => (a.clientName || '').localeCompare(b.clientName || '') || String(a.claimNumber).localeCompare(String(b.claimNumber)));
      const generatedAt = claims.reduce((latest, c) => (c.createdAt && (!latest || c.createdAt > latest) ? c.createdAt : latest), null);
      return {
        organization: { name },
        period: { label: window.label, from: window.from, to: window.to, startDate: window.start, endDate: window.end, timeZone: window.timeZone },
        generated: true,
        persisted: true,
        generatedAt,
        claims: billClaims,
        ...agg,
      };
    });
  }

  /** Billing periods that have a generated bill, newest first — so a bill can be reopened. */
  async listGeneratedBills(orgId, { limit = 12 } = {}) {
    return withTenant(orgId, async () => {
      const claims = await Claim.find({ billingPeriodStart: { $type: 'string' }, billingPeriodEnd: { $type: 'string' } })
        .select({ billingPeriodStart: 1, billingPeriodEnd: 1, clientId: 1, createdAt: 1 })
        .sort({ createdAt: -1 }).limit(1000).lean();
      const byPeriod = new Map();
      for (const c of claims) {
        const key = `${c.billingPeriodStart}|${c.billingPeriodEnd}`;
        if (!byPeriod.has(key)) byPeriod.set(key, { from: c.billingPeriodStart, to: c.billingPeriodEnd, claimCount: 0, clients: new Set(), generatedAt: c.createdAt ?? null });
        const p = byPeriod.get(key);
        p.claimCount += 1;
        p.clients.add(c.clientId);
      }
      const us = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k); return m ? `${m[2]}/${m[3]}/${m[1]}` : k; };
      return [...byPeriod.values()].slice(0, limit).map(({ clients, ...p }) => ({ ...p, clientCount: clients.size, label: `${us(p.from)} – ${us(p.to)}` }));
    });
  }

  /** The persisted bill for an export, or a clear 404 when the period has not been generated. */
  async #billForExport(orgId, { from, to }) {
    const bill = await this.getGeneratedBill(orgId, { from, to });
    if (!bill) throw AppError.notFound('BILL-404', 'No bill has been generated for this billing period yet. Select Generate Bill first.');
    return bill;
  }

  /** Generated-bill .xlsx — built ONLY from the persisted generated bill (the same data the page shows). */
  async buildCompanyBillingWorkbook(orgId, { from, to } = {}) {
    const data = await this.#billForExport(orgId, { from, to });
    const { buildCompanyInsuranceWorkbook } = await import('./claims.xlsx.js');
    const buffer = buildCompanyInsuranceWorkbook(data);
    return { buffer, filename: `insurance-bill-${(from || '').replace(/[^\d]/g, '')}-${(to || '').replace(/[^\d]/g, '')}.xlsx`, period: data.period };
  }

  /** Generated-bill .pdf — built ONLY from the persisted generated bill. */
  async buildCompanyBillingPdf(orgId, { from, to } = {}) {
    const data = await this.#billForExport(orgId, { from, to });
    const { buildCompanyBillingPdf } = await import('./claims.pdf.js');
    const buffer = buildCompanyBillingPdf(data);
    return { buffer, filename: `insurance-bill-${(from || '').replace(/[^\d]/g, '')}-${(to || '').replace(/[^\d]/g, '')}.pdf`, period: data.period };
  }

  async resubmitClaim(orgId, id, actorId) {
    // REJECTED/DENIED -> RESUBMITTED -> SUBMITTED, recorded as two events.
    return withTenant(orgId, async () => {
      const claim = await Claim.findById(id);
      if (!claim) throw AppError.notFound('CLAIM-404', 'Claim not found');
      assertClaimTransition(claim.status, 'RESUBMITTED');
      await this.#applyTransition(claim, 'RESUBMITTED', actorId, 'Resubmission started');
      assertClaimTransition(claim.status, 'SUBMITTED');
      await this.#applyTransition(claim, 'SUBMITTED', actorId, 'Resubmitted');
      claim.submittedAt = new Date(); claim.submittedBy = actorId;
      await claim.save();
      return this.getClaim(orgId, id);
    });
  }

  async transition(orgId, id, target, actorId, { reason, setSubmitted } = {}) {
    return withTenant(orgId, async () => {
      const claim = await Claim.findById(id);
      if (!claim) throw AppError.notFound('CLAIM-404', 'Claim not found');
      assertClaimTransition(claim.status, target);
      await this.#applyTransition(claim, target, actorId, reason);
      if (setSubmitted) { claim.submittedAt = new Date(); claim.submittedBy = actorId; }
      if (target === 'REJECTED') claim.rejectionReason = reason ?? null;
      if (target === 'DENIED') claim.denialReason = reason ?? null;
      await claim.save();
      return this.getClaim(orgId, id);
    });
  }

  // Applies a status change + appends an immutable status event. Caller saves.
  async #applyTransition(claim, target, actorId, reason) {
    const from = claim.status;
    claim.status = target;
    claim.updatedBy = actorId;
    await claim.save();
    await ClaimStatusEvent.create({ claimId: claim._id, fromStatus: from, toStatus: target, actorId, reason: reason ?? null });
    recordSafely({
      tenantId: claim.organizationId, actorId, action: 'claim.transitioned', entityType: 'claim', entityId: claim._id,
      outcome: 'success', payload: { from, to: target },
    });
  }

  // Platform (operator) cross-tenant read-only overview.
  async platformOverview() {
    const { withPlatform } = await import('../../tenancy/tenantContext.js');
    return withPlatform(async () => {
      const [total, submitted, accepted, rejected, denied, paid] = await Promise.all([
        Claim.countDocuments({}),
        Claim.countDocuments({ status: 'SUBMITTED' }),
        Claim.countDocuments({ status: 'ACCEPTED' }),
        Claim.countDocuments({ status: 'REJECTED' }),
        Claim.countDocuments({ status: 'DENIED' }),
        Claim.countDocuments({ status: 'PAID' }),
      ]);
      const outstanding = await Claim.find({ status: { $in: ['SUBMITTED', 'ACCEPTED'] } }).lean();
      const outstandingAmount = outstanding.reduce((s, c) => s + Math.max(0, c.totalCharge - c.paidAmount), 0);
      return { total, submitted, accepted, rejected, denied, paid, outstandingAmount };
    });
  }
}
