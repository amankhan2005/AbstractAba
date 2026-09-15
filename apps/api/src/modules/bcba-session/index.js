import { organizationService } from '../organization/index.js';
import { settingsService } from '../settings/index.js';
import { schedulingRepository } from '../scheduling/index.js';
import { resolveAuthorizations } from '../scheduling/authorizationDisplay.js';
import { sessionsRepository } from '../sessions/index.js';
import { staffPayRatesPort } from '../staff/index.js';
import { clientsRepository } from '../clients/index.js';
import { TreatmentPlan, Goal, Program } from '../../models/index.js';
import { withTenant } from '../../tenancy/tenantContext.js';
import { sealPhi, openPhi } from '../../utils/phi.js';
import { BcbaSessionService } from './bcbaSession.service.js';
import { bcbaSessionRepository } from './bcbaSession.repository.js';
import { createBcbaSessionRouter } from './bcbaSession.routes.js';

/**
 * Composition root for the BCBA session workflow. The service orchestrates the
 * platform's existing primitives through narrow ports so no module reaches into
 * another's internals:
 *
 *   organizations  → ACTIVE gate (organizationService)
 *   appointments   → findById + listForBcba (scheduling + this module's repo)
 *   sessions       → the platform sessions repository (create/find/update/freeze)
 *   plans          → the client's ACTIVE treatment plan (read below)
 *   payRates       → the SINGLE source of pay truth (staff module's port,
 *                    reused via staffService — the same rate payroll reads)
 *   timeRecords    → the per-session payroll receipt (this module's repo)
 *   phi            → seal/open the session memo (clinical narrative)
 */

/**
 * The treatment plan APPLICABLE TO A SESSION: this tenant, this client, ACTIVE,
 * and already in effect on the session's service date.
 *
 * SELECTION RULES (audited — the previous ordering was not safe):
 *
 *   tenant + client   `withTenant` scopes the read and `clientId` is required,
 *                     so a plan belonging to another client or another company
 *                     can never surface. This part was already correct.
 *
 *   ACTIVE only       DRAFT plans are not yet in force and ARCHIVED plans are
 *                     history; neither is clinical direction for today.
 *
 *   effective on the  A plan dated to START NEXT MONTH must not be presented as
 *   service date      today's direction. Plans with no effectiveDate are treated
 *                     as always in effect, which is how existing records behave.
 *
 *   newest first      Ordered by effectiveDate DESC so the most recently
 *                     effective plan wins, with updatedAt only as a tie-break.
 *                     Ordering by updatedAt alone (the previous behaviour) meant
 *                     that merely EDITING an older plan promoted it over the
 *                     current one — the edit date says nothing about which plan
 *                     is in force.
 *
 * `asOf` is the session's service date. It defaults to now so existing callers
 * keep working unchanged.
 */
const plansPort = {
  async findActivePlanForClient(tenantId, clientId, asOf = new Date()) {
    return withTenant(tenantId, async () => {
      const when = asOf ? new Date(asOf) : new Date();
      const doc = await TreatmentPlan.findOne({
        clientId,
        status: 'ACTIVE',
        deletedAt: null,
        $or: [{ effectiveDate: null }, { effectiveDate: { $lte: when } }],
      })
        .sort({ effectiveDate: -1, updatedAt: -1 })
        .lean();
      return doc ? {
        id: doc._id,
        clientId: doc.clientId,
        status: doc.status,
        title: doc.title ?? null,
        effectiveDate: doc.effectiveDate ?? null,
      } : null;
    });
  },
  /**
   * Counts PLUS the goal and program names for the child overview.
   *
   * The names are what make the plan usable as clinical guidance during a
   * session: "3 goals, 2 programs" tells a technician nothing about what to
   * actually work on. This is READ-ONLY context — the session screens render it
   * as guidance and have no edit path, and the plan itself is still only
   * editable through the treatment-plan module's own permissions.
   *
   * No new permission surface is opened: the caller has already been authorized
   * against the appointment it is assigned to, and this reads only the ACTIVE
   * plan of that appointment's client. The list is bounded so a long plan cannot
   * bloat the panel response.
   */
  async summarize(tenantId, planId) {
    return withTenant(tenantId, async () => {
      const [goalCount, programCount, goals, programs] = await Promise.all([
        Goal.countDocuments({ treatmentPlanId: planId, status: { $ne: 'ARCHIVED' }, deletedAt: null }),
        Program.countDocuments({ treatmentPlanId: planId, archivedAt: null }),
        Goal.find({ treatmentPlanId: planId, status: { $ne: 'ARCHIVED' }, deletedAt: null })
          .select({ description: 1 }).sort({ createdAt: 1 }).limit(12).lean(),
        Program.find({ treatmentPlanId: planId, archivedAt: null })
          .select({ name: 1 }).sort({ createdAt: 1 }).limit(12).lean(),
      ]);
      return {
        goalCount,
        programCount,
        goals: goals.map((g) => ({ id: String(g._id), description: g.description ?? null })),
        programs: programs.map((p) => ({ id: String(p._id), name: p.name ?? null })),
      };
    });
  },
};

/** Read-only child lookup for the permission-scoped child overview. */
const clientsPort = {
  findById: (tenantId, clientId) => clientsRepository.findClientById(tenantId, clientId),
  // The child's active RBT(s) from the existing care-team assignments, as
  // "First Last" display names (the BCBA panel names the assigned RBT).
  activeRbtNames: async (tenantId, clientId) => (await clientsRepository.listAssignments(tenantId, clientId))
    .filter((a) => a.role === 'RBT' && a.status === 'ACTIVE' && a.staffName)
    .map((a) => { const [last, first] = a.staffName.split(',').map((p) => p.trim()); return [first, last].filter(Boolean).join(' '); }),
};

/**
 * Resolves authorization ids (legacy Authorization _id OR the unified
 * `svc:<ServiceAuthorization._id>` transport marker) into normalized,
 * user-facing objects. Reuses schedulingRepository.findAuthorizationById — the
 * ONE resolver that already knows both collections — so no duplicate
 * authorization system is created. The raw id is kept as `id` (internal value);
 * a human `label` and the real fields (payer, number, service, units, dates)
 * are added for display. This is the fix for raw `svc:<id>` leaking to the UI.
 */
const authorizationsPort = {
  resolveMany: (tenantId, ids) => resolveAuthorizations(tenantId, ids),
  // Raw, tenant-scoped authorization (legacy id or `svc:` ServiceAuthorization)
  // for manual-session validation — the same resolver booking uses.
  findById: (tenantId, id) => schedulingRepository.findAuthorizationById(tenantId, id),
};

/**
 * Staffing-settings port. Reuses the platform settings service so the company's
 * weekly work requirement (BCBA panel §K) lives in ONE place — the same
 * namespaced OrganizationSetting the settings screen edits — not a disconnected
 * store. Returns the effective staffing namespace (stored value over registered
 * default), so an unconfigured company yields target 0 and the weekly block is
 * simply not shown.
 */
const settingsPort = {
  getStaffing: (tenantId) => settingsService.getNamespace(tenantId, 'staffing'),
};

/**
 * Pay-rate port. Reuses the staff module's authoritative hourly-rate reader —
 * the same effective-dated PayRate collection the payroll run reads — so the
 * BCBA receipt and the payroll aggregate can never disagree on the rate.
 */
const payRatesPort = {
  getCurrentHourlyRate: ({ tenantId, staffProfileId }) =>
    staffPayRatesPort.getCurrentHourlyRate({ tenantId, staffProfileId }),
};

export const bcbaSessionService = new BcbaSessionService({
  organizations: { getById: (id) => organizationService.getById(id) },
  appointments: {
    findById: (tenantId, id) => schedulingRepository.findAppointmentById(tenantId, id),
    listForBcba: (tenantId, bcbaId, opts) => bcbaSessionRepository.listForBcba(tenantId, bcbaId, opts),
    listForRbt: (tenantId, rbtId, opts) => bcbaSessionRepository.listForRbt(tenantId, rbtId, opts),
    // Manual session entry (Phase 3): create a REAL appointment via the existing
    // simple-create path — no parallel appointment model.
    createManual: (tenantId, doc) => schedulingRepository.createAppointmentSimple(tenantId, doc),
  },
  // Care-team access check for manual session entry (same source booking uses).
  assignments: { listActiveForClient: (tenantId, clientId) => clientsRepository.listAssignments(tenantId, clientId) },
  sessions: {
    findByAppointment: (tenantId, apptId, staffProfileId) => sessionsRepository.findSessionByAppointmentAndStaff(tenantId, apptId, staffProfileId),
    // Idempotency fallback ONLY (see the repository method): the completed
    // session for this appointment+clinician, which findByAppointment cannot
    // return because a finalized session is active:false.
    findLatestFinalized: (tenantId, apptId, staffProfileId) => sessionsRepository.findLatestFinalizedByAppointmentAndStaff(tenantId, apptId, staffProfileId),
    findByGenerationKey: (tenantId, key) => sessionsRepository.findSessionByGenerationKey(tenantId, key),
    findById: (tenantId, id) => sessionsRepository.findSessionById(tenantId, id),
    create: (tenantId, doc) => sessionsRepository.createSession(tenantId, doc),
    update: (tenantId, id, patch) => sessionsRepository.updateSession(tenantId, id, patch),
    freeze: (tenantId, id, actorUserId) => sessionsRepository.freezeSession(tenantId, id, actorUserId),
  },
  plans: plansPort,
  clients: clientsPort,
  authorizations: authorizationsPort,
  payRates: payRatesPort,
  settings: settingsPort,
  timeRecords: {
    findBySession: (tenantId, sessionId) => bcbaSessionRepository.findBySession(tenantId, sessionId),
    create: (tenantId, doc) => bcbaSessionRepository.create(tenantId, doc),
    list: (tenantId, opts) => bcbaSessionRepository.list(tenantId, opts),
    sumWorkedMinutes: (tenantId, opts) => bcbaSessionRepository.sumWorkedMinutes(tenantId, opts),
    sumWorkedSeconds: (tenantId, opts) => bcbaSessionRepository.sumWorkedSeconds(tenantId, opts),
  },
  phi: { seal: sealPhi, open: openPhi },
});

export const bcbaSessionRouter = createBcbaSessionRouter(bcbaSessionService);

/**
 * RBT technician panel — the SAME connected pipeline (start → persisted timer →
 * child plan → stop → authorization → memo → SessionTimeRecord → my-hours),
 * reusing the same service and controller. The only difference is the
 * assignment axis: the router tags the controller with role 'RBT', so ownership
 * is proven against the appointment's rbtId and the panel lists the RBT's own
 * assignments. Identity is still the token's staffProfileId; the browser never
 * supplies it. No duplicate session / timer / plan / authorization system.
 */
export const rbtSessionRouter = createBcbaSessionRouter(bcbaSessionService, 'RBT');

export { BcbaSessionService } from './bcbaSession.service.js';
export { BcbaSessionController } from './bcbaSession.controller.js';
export { bcbaSessionRepository } from './bcbaSession.repository.js';
