import { bcbaSessionError } from './bcbaSession.errors.js';
import {
  workedMinutes, payAmountMinor, dollarsToMinor, humanDuration, humanSeconds, sessionWorkedSeconds,
  sessionWorkedMinutes, openInterval, closeInterval, hasRunningInterval, activePeriodStartedAt,
} from './bcbaSession.time.js';
import { companyWeekWindow, summarizeWeekly, companyPeriodWindow, splitHms, humanHms, zonedMidnightToUtc, HOURS_WEEK_STARTS_ON } from './weeklyHours.js';
import { civilDayNumber, describeStartIneligibility, lastBusinessDateString, parseCivilDate, sessionBusinessDate, startEligibility, zonedWallTimeToUtc } from '../../domain/businessDate.js';
import { authorizationCoversDate, isBookableAuthorization } from '../scheduling/scheduling.rules.js';
import { createHash } from 'node:crypto';
import { deriveSessionStatus } from './sessionStatus.js';

/**
 * ---------------------------------------------------------------------------
 * BCBA SESSION WORKFLOW — one connected pipeline (spec §1):
 *
 *   appointment → BCBA panel → START SESSION → persisted timer → child plan
 *   → STOP SESSION → exact timestamps → ABA/FBA selection → memo
 *   → staff hourly rate → payroll time + amount → admin payroll
 *
 * This service ORCHESTRATES the platform's existing primitives rather than
 * re-implementing them:
 *   - appointments   (scheduling repository) — the source of child/BCBA/RBT/auth
 *   - sessions       (session model, via the injected sessions port) — the
 *                     IN_PROGRESS → FROZEN lifecycle already in the codebase
 *   - plans          (plans repository) — the client's ACTIVE treatment plan
 *   - payRates       (staff pay-rate port) — the SINGLE source of pay truth
 *   - timeRecords    (SessionTimeRecord) — the per-session payroll receipt
 *   - payroll.math   — the ONLY pay arithmetic (via bcbaSession.time)
 *
 * SECURITY (§19, §20). The acting BCBA is identified by their resolved
 * staffProfileId (from the token, never the browser). Every id that arrives
 * from the client — appointmentId, sessionId, authorizationId — is re-validated
 * against the tenant and against this BCBA's ownership of the appointment. A
 * BCBA cannot touch another company's or another clinician's appointment by
 * submitting an id.
 *
 * TIME (§4, §5, §9, §10). The server clock is authoritative. `startedAt` and
 * `endedAt` are persisted on the server; the frontend timer only RECONSTRUCTS
 * elapsed time from `startedAt` and is never the source of truth.
 *
 * IDEMPOTENCY (§3, §16, §17). One live session per appointment is enforced by
 * the Session unique index, so START from two screens resolves to one session.
 * One SessionTimeRecord per session is enforced by its unique index, so a
 * repeated COMPLETE never creates a second payroll record. Finalization is a
 * safe idempotent sequence (freeze → record), not an unbounded transaction —
 * the previous booking system's hanging-transaction failure is deliberately not
 * recreated (§17). A retry after a partial finalize re-runs and converges:
 * freeze is a no-op if already frozen, and the record insert is a no-op if it
 * already exists; a frozen session with no record gets its record created.
 * ---------------------------------------------------------------------------
 *
 * @typedef {{
 *   organizations: { getById:(id:string)=>Promise<{state:string}|null> },
 *   appointments: { findById:(t:string,id:string)=>Promise<any>, listForBcba:(t:string,bcbaId:string,opts?:object)=>Promise<any[]> },
 *   sessions: {
 *     findByAppointment:(t:string,apptId:string)=>Promise<any>,
 *     findById:(t:string,id:string)=>Promise<any>,
 *     create:(t:string,doc:object)=>Promise<any>,
 *     update:(t:string,id:string,patch:object)=>Promise<any>,
 *     freeze:(t:string,id:string,actorUserId:string)=>Promise<any>,
 *   },
 *   plans: { findActivePlanForClient:(t:string,clientId:string,asOf?:Date)=>Promise<any> },
 *   payRates: { getCurrentHourlyRate:(args:{tenantId:string,staffProfileId:string})=>Promise<number|null> },
 *   timeRecords: {
 *     findBySession:(t:string,sessionId:string)=>Promise<any>,
 *     create:(t:string,doc:object)=>Promise<any>,
 *     list:(t:string,opts:object)=>Promise<any[]>,
 *   },
 *   phi: { seal:(v:any)=>any, open:(v:any)=>any },
 *   clock?: { now:()=>Date },
 * }} BcbaSessionDeps
 */
export class BcbaSessionService {
  /** @param {BcbaSessionDeps} deps */
  constructor(deps) {
    this.deps = deps;
    this.now = deps.clock?.now ?? (() => new Date());
  }

  async _assertActive(tenantId) {
    const org = await this.deps.organizations.getById(tenantId);
    if (!org || org.state !== 'ACTIVE') throw bcbaSessionError('ORG_NOT_ACTIVE');
  }

  _requireStaff(bcbaStaffProfileId) {
    if (!bcbaStaffProfileId) throw bcbaSessionError('MISSING_STAFF_PROFILE');
  }

  /**
   * Load an appointment and prove it is assigned to THIS clinician, in this
   * tenant. The core ownership gate every action funnels through (§19, §20).
   *
   * Role-aware so the SAME pipeline serves both panels without duplication:
   *   - BCBA (default): the appointment must name this staff as its bcbaId.
   *   - RBT: the appointment must name this staff as its rbtId.
   * The delivering staff is always the token's staffProfileId; the body can
   * never name a different clinician. Returns the appointment.
   */
  /**
   * The session Stop/Complete should act on: the OPEN one when there is one,
   * otherwise the most recently FINALIZED one for this appointment+clinician.
   *
   * The fallback is what makes the completion flow's idempotency guard actually
   * reachable. Completing a session sets active:false, and the open-session
   * lookup filters on active:true, so a double-clicked or retried Complete used
   * to resolve to nothing and fail with "We couldn't find that session" —
   * exactly the case §16 says must be a safe no-op. Start deliberately does NOT
   * use this fallback: a new session after a completed one is a genuinely
   * separate visit and must get its own row.
   */
  async _findSessionForFinalize(tenantId, appointmentId, staffProfileId) {
    const open = await this.deps.sessions.findByAppointment(tenantId, appointmentId, staffProfileId);
    if (open) return open;
    if (!this.deps.sessions.findLatestFinalized) return null;
    return this.deps.sessions.findLatestFinalized(tenantId, appointmentId, staffProfileId);
  }

  async _requireOwnedAppointment(tenantId, staffProfileId, appointmentId, role = 'BCBA') {
    const appt = await this.deps.appointments.findById(tenantId, appointmentId);
    if (!appt) throw bcbaSessionError('APPOINTMENT_NOT_FOUND');
    const assignedId = role === 'RBT' ? appt.rbtId : appt.bcbaId;
    // An appointment with no assignment for this role (legacy / other role) is
    // not startable from this panel.
    if (!assignedId || assignedId !== staffProfileId) {
      throw bcbaSessionError('NOT_YOUR_APPOINTMENT');
    }
    return appt;
  }

  // --- BCBA PANEL (§2) -----------------------------------------------------

  /**
   * Every appointment assigned to this BCBA, each annotated with its derived
   * session status so the panel can show START vs an active timer vs completed
   * (§2, §3). Session status is the single truth — SCHEDULED when no session
   * exists, otherwise the session's own state.
   */
  async listPanel({ tenantId, bcbaStaffProfileId, from = null, to = null, role = 'BCBA' }) {
    this._requireStaff(bcbaStaffProfileId);
    // One timezone lookup for the whole panel: every card's business-day status
    // is derived against the SAME organization calendar day.
    const org = await this.deps.organizations?.getById?.(tenantId);
    const timeZone = org?.timezone || 'UTC';
    const appts = role === 'RBT'
      ? await this.deps.appointments.listForRbt(tenantId, bcbaStaffProfileId, { from, to })
      : await this.deps.appointments.listForBcba(tenantId, bcbaStaffProfileId, { from, to });
    const cards = [];
    const nameCache = new Map(); // clientId → resolved display name (avoid duplicate lookups)
    const rbtCache = new Map();  // clientId → the child's assigned RBT name(s) (BCBA panel only)
    for (const appt of appts) {
      const session = await this.deps.sessions.findByAppointment(tenantId, appt.id, bcbaStaffProfileId);
      let childName = appt.clientId ? nameCache.get(appt.clientId) : null;
      if (childName === undefined) childName = null;
      if (appt.clientId && !nameCache.has(appt.clientId) && this.deps.clients?.findById) {
        try {
          const c = await this.deps.clients.findById(tenantId, appt.clientId);
          childName = c
            ? ((c.preferredName && String(c.preferredName).trim())
              || [c.firstName, c.lastName].filter((x) => x != null && String(x).trim() !== '').join(' ').trim()
              || null)
            : null;
        } catch { childName = null; }
        nameCache.set(appt.clientId, childName);
      }
      // The BCBA sees the child's assigned RBT even though this appointment
      // names only the BCBA. The RBT panel never receives other clinicians.
      let assignedRbtName = null;
      if (role !== 'RBT' && appt.clientId && this.deps.clients?.activeRbtNames) {
        if (!rbtCache.has(appt.clientId)) {
          const names = await this.deps.clients.activeRbtNames(tenantId, appt.clientId).catch(() => []);
          rbtCache.set(appt.clientId, names.join(', ') || null);
        }
        assignedRbtName = rbtCache.get(appt.clientId);
      }
      cards.push({ ...this._panelCard(appt, session, childName, timeZone), assignedRbtName });
    }
    return cards;
  }

  _panelCard(appt, session, childName = null, timeZone = 'UTC') {
    const sessionStatus = this._derivedStatus(appt, session);
    // Start eligibility from the ONE authority (a 24-hour window per scheduled
    // date, org timezone, server clock). Derived on every read, never stored.
    // A live (running/stopped) session is bound to the scheduled date it was
    // begun on, and the card describes THAT occurrence — so on 09/13 a session
    // begun on 09/12 reads EXPIRED (finish only), never 09/13's window.
    const live = sessionStatus === 'IN_PROGRESS' || sessionStatus === 'STOPPED';
    const boundDate = live ? sessionBusinessDate(appt, session, timeZone) : null;
    const eligibility = startEligibility(appt, timeZone, this.now(), boundDate ? { businessDate: boundDate } : {});
    return {
      appointmentId: appt.id,
      clientId: appt.clientId,
      childName: childName ?? null,   // backend-resolved display name (never an id)
      bcbaId: appt.bcbaId ?? null,
      rbtId: appt.rbtId ?? null,
      startAt: appt.startAt,
      endAt: appt.endAt,
      timeSet: appt.timeSet ?? true,
      authorizationIds: appt.authorizationIds?.length ? appt.authorizationIds : (appt.authorizationId ? [appt.authorizationId] : []),
      sessionId: session?.id ?? null,
      sessionStatus,               // SCHEDULED | IN_PROGRESS | STOPPED | COMPLETED | CANCELLED
      // Session Start Time — the first start of this logical session. Shown to
      // the clinician as "Session started at …"; it never moves.
      startedAt: session?.startedAt ?? null,
      endedAt: session?.endedAt ?? null,
      // The start of the work period currently in progress. THE anchor for the
      // live timer: after a Stop and restart, startedAt above is hours behind
      // the work actually happening, so a timer anchored on it counts the break
      // as worked time on screen. Null whenever nothing is running.
      activePeriodStartedAt: session ? activePeriodStartedAt(session) : null,
      // A STOPPED session can be STARTED AGAIN: that opens another timing
      // interval on the same logical session (§10/§30). The clinician therefore
      // has two actions while stopped — resume, or complete — and resuming no
      // longer requires completing first (which is what used to inflate the
      // session count).
      canStart: sessionStatus === 'SCHEDULED' || sessionStatus === 'STOPPED',
      canResume: sessionStatus === 'STOPPED',
      // Whether Start/Resume is permitted RIGHT NOW. `canStart` above stays the
      // lifecycle answer (unchanged contract); these describe the 24-hour start
      // window. startSession enforces the same rule server-side.
      startStatus: eligibility.status,         // UPCOMING | AVAILABLE | EXPIRED
      // The scheduled occurrence the card represents: the live session's date,
      // otherwise the date whose window is open (or next / last). NEVER the
      // appointment's range start.
      startBusinessDate: eligibility.businessDate,
      sessionBusinessDate: boundDate,
      expired: eligibility.status === 'EXPIRED',
      startableNow: eligibility.status === 'AVAILABLE',
      startWindowStart: eligibility.windowStart,
      startWindowEnd: eligibility.windowEnd,
      lastBusinessDate: lastBusinessDateString(appt.startAt, appt.endAt ?? appt.startAt, timeZone),
      isRunning: sessionStatus === 'IN_PROGRESS',
      // Worked so far across every recorded interval, so a resumed session's
      // card shows the running total rather than only the latest stretch.
      workedMinutes: session ? sessionWorkedMinutes(session) : 0,
      intervalCount: (session?.intervals ?? []).filter((iv) => iv?.startedAt && iv?.endedAt).length,
    };
  }

  /**
   * Panel-facing status. The Session model has no explicit "stopped" state — a
   * stopped-but-not-completed session is IN_PROGRESS with no RUNNING timing
   * interval. We surface that as STOPPED so the panel offers "start again" and
   * the completion form rather than a running timer. COMPLETED maps to the
   * platform's FROZEN (the payroll-eligible terminal state; see models/enums.js).
   */
  _derivedStatus(appt, session) {
    return deriveSessionStatus(appt, session);
  }

  // --- START SESSION (§3, §4, §5, §6) --------------------------------------

  /**
   * Start (or re-open) the session for one appointment. Server-side validation
   * per §4. Idempotent per §3: if a live session already exists it is returned
   * — never a second row (the Session unique index is the backstop, this is the
   * friendly path). The persisted `startedAt` is the authoritative clock (§5).
   */
  async startSession({ tenantId, actorUserId, bcbaStaffProfileId, appointmentId, role = 'BCBA' }) {
    await this._assertActive(tenantId);
    this._requireStaff(bcbaStaffProfileId);
    const appt = await this._requireOwnedAppointment(tenantId, bcbaStaffProfileId, appointmentId, role);

    if (appt.status === 'CANCELLED' || appt.status === 'COMPLETED') throw bcbaSessionError('APPOINTMENT_NOT_STARTABLE');
    if (!appt.clientId) throw bcbaSessionError('APPOINTMENT_NOT_STARTABLE');

    // Already have a session for this appointment? Resolve to it (§3).
    const existing = await this.deps.sessions.findByAppointment(tenantId, appt.id, bcbaStaffProfileId);
    if (existing) {
      if (existing.status === 'FROZEN' || existing.status === 'AMENDED') {
        throw bcbaSessionError('SESSION_ALREADY_COMPLETED');
      }
      if (existing.status === 'CANCELLED') throw bcbaSessionError('APPOINTMENT_NOT_STARTABLE');

      // RESUME (onboarding §10/§30). A session that has been stopped but not
      // completed is IN_PROGRESS with an endedAt set. Pressing Start again must
      // open a NEW timing interval on the SAME logical session — it must not
      // return the stopped session untouched (which is what used to happen, so
      // a second interval was impossible), and it must not create a second
      // Session row (which is how three intervals became "Sessions: 3").
      //
      // startedAt is left at the FIRST start for the whole session; each
      // interval's own boundaries live in `intervals`, and worked time is their
      // sum. Nothing already recorded is overwritten.
      const needsRun = existing.status !== 'IN_PROGRESS'
        || !existing.startedAt
        || existing.endedAt
        || !hasRunningInterval(existing.intervals);
      if (needsRun) {
        // Opening a timing interval IS starting work, so the 24-hour start
        // window applies here exactly as it does to a brand-new session. A
        // session already RUNNING is returned below untouched — no new work
        // begins — and Stop/Complete stay available after the window closes so
        // recorded time is never lost.
        await this._assertStartableNow(tenantId, appt, existing);
        const now = this.now();
        const reopened = await this.deps.sessions.update(tenantId, existing.id, {
          status: 'IN_PROGRESS',
          startedAt: existing.startedAt ?? now,
          endedAt: null,
          clockOutAt: null,
          intervals: openInterval(existing.intervals, now, bcbaStaffProfileId),
          updatedBy: actorUserId,
        });
        return this._present(reopened);
      }
      return this._present(existing);
    }

    // START WINDOW. A brand-NEW session may only be started while one of the
    // appointment's 24-hour start windows is open (startEligibility: scheduled
    // start → +24h per scheduled date, org timezone, server clock). A
    // multi-day appointment (e.g. 09/01→09/30) opens a window on every date in
    // its range. A running session (resolved above) is never cut off.
    await this._assertStartableNow(tenantId, appt);

    // WEEKLY TARGET GATE (§14, §15) — BCBA-only. The company weekly work
    // requirement is a BCBA scheduling rule; the RBT panel does not apply it.
    // We are about to create a BRAND-NEW session for this company week. If the
    // company configured a weekly requirement and this BCBA has already reached
    // it, the server refuses to start another session — this is enforced HERE,
    // not in the browser, and never silently (no create-then-fix). This check
    // runs only on the new-session path: an existing IN_PROGRESS/STOPPED session
    // is resolved above and can always be resumed, and a BCBA who is still SHORT
    // of the target (e.g. 29h of 30h) is allowed to start their valid remaining
    // appointment.
    if (role !== 'RBT') {
      await this._assertWeeklyCapacity(tenantId, bcbaStaffProfileId);
    }

    // TREATMENT PLAN IS OPTIONAL AT START (spec Part 9 & 13, and the fix for
    // the 409 that blocked assigned BCBAs). A child may have no plan yet — the
    // BCBA creates it DURING the session. Bind the child's ACTIVE plan when one
    // exists so data-point capture works immediately; otherwise start with a
    // null plan. Starting a session must never fail for a missing plan.
    // The plan applicable ON THIS SESSION'S SERVICE DATE — not merely the most
    // recently edited active plan for the client.
    const plan = await this.deps.plans.findActivePlanForClient(tenantId, appt.clientId, appt.startAt ?? undefined);

    const now = this.now();
    const created = await this.deps.sessions.create(tenantId, {
      appointmentId: appt.id,
      clientId: appt.clientId,
      // The delivering staff member is the BCBA running this panel session.
      staffProfileId: bcbaStaffProfileId,
      treatmentPlanId: plan ? plan.id : null,
      startedAt: now,          // authoritative server start (§5)
      endedAt: null,
      // The first timing interval of this logical session. Later Start presses
      // append to this list rather than creating another session.
      intervals: [{ startedAt: now, endedAt: null, startedBy: bcbaStaffProfileId, endedBy: null }],
      status: 'IN_PROGRESS',
      clockInAt: now,
      clockInBy: bcbaStaffProfileId,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });
    return this._present(created);
  }

  /**
   * The active session for an appointment, for timer reconstruction after a
   * refresh or a dashboard→child navigation (§5). Never trusts a client clock:
   * the caller derives elapsed time from the returned `startedAt`.
   */
  async getActiveByAppointment({ tenantId, bcbaStaffProfileId, appointmentId, role = 'BCBA' }) {
    this._requireStaff(bcbaStaffProfileId);
    await this._requireOwnedAppointment(tenantId, bcbaStaffProfileId, appointmentId, role);
    const session = await this.deps.sessions.findByAppointment(tenantId, appointmentId, bcbaStaffProfileId);
    if (!session) return null;
    // Reconcile the plan link (spec Part 13): if the session started with no
    // plan and the BCBA has since created one during the session, bind it now
    // so the session references the newly ACTIVE plan. Only ever fills a null —
    // it never repoints an existing link, and it never blocks the read.
    if (!session.treatmentPlanId && session.status === 'IN_PROGRESS') {
      const plan = await this.deps.plans.findActivePlanForClient(tenantId, session.clientId, session.startedAt ?? undefined);
      if (plan) {
        const bound = await this.deps.sessions.update(tenantId, session.id, { treatmentPlanId: plan.id });
        return this._present(bound ?? session);
      }
    }
    return this._present(session);
  }

  /**
   * Persist in-session documentation (What / How / Child response) against the
   * caller's OWN session for this appointment (spec §1/§6/§8/§9). Reuses the
   * exact ownership + tenant + role guard every other action here uses, so an
   * RBT can only ever write their own session's documentation — never a BCBA's,
   * another RBT's, or another child's. Only the documentation sub-fields are
   * touched: clock-in/out, workedMinutes, startedAt/endedAt and status are left
   * exactly as they are (§6). Partial updates are allowed (any subset of the
   * three fields); an omitted field is left unchanged, an explicit '' clears it.
   * The treatment plan is never modified (§3/§14).
   */
  /**
   * MANUAL SESSION — record a COMPLETED session the clinician already performed,
   * through the SAME architecture the live Start/Stop workflow uses. No parallel
   * model and no manual-only calculation:
   *
   *   Appointment      a real single-clinician appointment (status COMPLETED) —
   *                    carries the role (bcbaId/rbtId) payroll attributes by and
   *                    the authorization(s) with the existing unit burn-down
   *   Session          FROZEN, active:false, source 'MANUAL', with clock-in/out,
   *                    selectedAuthorizationIds (what Insurance Billing reads)
   *                    and the sealed Session Memo
   *   SessionTimeRecord via _ensureTimeRecord — workedMinutes = end − start,
   *                    computed HERE; the one number My Hours, Payroll and
   *                    reporting read (payroll prices it at the effective staff
   *                    rate; billing prices by authorization unit price)
   *
   * Server-enforced:
   *   - clinician = the authenticated staff profile (token), never the body;
   *     tenant from the authenticated context
   *   - the clinician must be an ACTIVE care-team member of the client in their
   *     role (tenant-scoped, so a cross-tenant client fails here)
   *   - real calendar date; 15-minute clock times; end after start (same day);
   *     instants composed as org-timezone WALL CLOCK times (DST-correct)
   *   - ≥1 authorization; each must resolve in this tenant, belong to this
   *     client, be in a usable (approved) state, and cover the session date
   *   - duplicate protection: an identical repeat returns the existing session
   *     (alreadyExists); overlapping recorded work for the same clinician is
   *     SESSION_CONFLICT; the database's unique manual key + a deterministic
   *     appointment id stop two concurrent identical requests both writing
   * Validation completes before the first write, so a refusal writes nothing.
   */
  async createManualSession({ tenantId, actorUserId, bcbaStaffProfileId, role = 'BCBA', input }) {
    await this._assertActive(tenantId);
    this._requireStaff(bcbaStaffProfileId);
    const wantRole = role === 'RBT' ? 'RBT' : 'BCBA';

    // --- date & time --------------------------------------------------------
    const date = parseCivilDate(input.date);
    if (!date) throw bcbaSessionError('INVALID_DATE');
    const clock = (t) => {
      const [h, m] = String(t).split(':').map(Number);
      return { h, m, total: h * 60 + m };
    };
    const from = clock(input.startTime);
    const to = clock(input.endTime);
    if (from.m % 15 !== 0 || to.m % 15 !== 0) throw bcbaSessionError('INVALID_TIME_INCREMENT');
    if (to.total <= from.total) throw bcbaSessionError('INVALID_TIME', { message: 'End time must be after start time.' });

    // --- client access (tenant-scoped care team, server-derived clinician) ---
    const assignments = (await this.deps.assignments.listActiveForClient(tenantId, input.clientId)) || [];
    const assigned = assignments.some((a) => a.staffProfileId === bcbaStaffProfileId
      && String(a.role).toUpperCase() === wantRole && String(a.status ?? 'ACTIVE').toUpperCase() === 'ACTIVE');
    if (!assigned) throw bcbaSessionError('NOT_ASSIGNED_TO_CHILD');

    // --- instants in the ORG timezone (wall clock, DST-correct) --------------
    const org = await this.deps.organizations.getById(tenantId);
    const tz = org?.timezone || 'UTC';
    const startedAt = zonedWallTimeToUtc(date.year, date.month, date.day, from.h, from.m, 0, tz);
    const endedAt = zonedWallTimeToUtc(date.year, date.month, date.day, to.h, to.m, 0, tz);
    const workedMin = Math.round((endedAt.getTime() - startedAt.getTime()) / 60000);
    if (workedMin <= 0) throw bcbaSessionError('INVALID_TIME', { message: 'End time must be after start time.' });

    // --- authorizations (existing resolver + shared usability rules) --------
    const authorizationIds = [...new Set((input.authorizationIds ?? []).filter(Boolean))];
    if (authorizationIds.length === 0) throw bcbaSessionError('AUTHORIZATION_REQUIRED');
    for (const authId of authorizationIds) {
      const auth = this.deps.authorizations?.findById ? await this.deps.authorizations.findById(tenantId, authId) : null;
      if (!auth || auth.clientId !== input.clientId) throw bcbaSessionError('AUTHORIZATION_NOT_FOR_CLIENT');
      if (!isBookableAuthorization(auth)) throw bcbaSessionError('AUTHORIZATION_NOT_USABLE');
      if (!authorizationCoversDate(auth, input.date)) throw bcbaSessionError('AUTHORIZATION_NOT_VALID_FOR_DATE');
    }

    // --- duplicates & conflicts ---------------------------------------------
    // The exact-duplicate identity: same clinician, client, date, From, To and
    // authorization set. Anything else is a distinct session (several per day
    // are normal); a same-clinician time overlap is refused below as a conflict.
    const authKey = [...authorizationIds].sort().join(',');
    const generationKey = `manual:${bcbaStaffProfileId}:${input.clientId}:${input.date}:${input.startTime}:${input.endTime}:${authKey}`;
    const existing = await this._findManualByKey(tenantId, generationKey);
    if (existing) return existing;
    if (this.deps.timeRecords?.list) {
      const nearby = await this.deps.timeRecords.list(tenantId, {
        staffProfileId: bcbaStaffProfileId,
        from: new Date(startedAt.getTime() - 24 * 60 * 60 * 1000),
        to: endedAt,
        limit: 500,
      });
      const overlaps = (nearby ?? []).some((r) => r.startedAt && r.endedAt
        && new Date(r.startedAt) < endedAt && new Date(r.endedAt) > startedAt);
      if (overlaps) throw bcbaSessionError('SESSION_CONFLICT', { message: 'You already have a session recorded during this time.' });
    }

    // --- persist ------------------------------------------------------------
    const units = Math.max(1, Math.ceil(workedMin / 15));
    let appt;
    try {
      appt = await this.deps.appointments.createManual(tenantId, {
        // Deterministic id: a concurrent identical request collides here, before
        // any session or time record is written.
        _id: manualAppointmentId(tenantId, generationKey),
        clientId: input.clientId,
        staffProfileId: bcbaStaffProfileId,
        bcbaId: wantRole === 'BCBA' ? bcbaStaffProfileId : null,
        rbtId: wantRole === 'RBT' ? bcbaStaffProfileId : null,
        authorizationId: authorizationIds[0],
        authorizationIds,
        startAt: startedAt,
        endAt: endedAt,
        timeSet: true,
        businessTimeZone: tz,
        // Completed work, not a bookable slot: never offered for Start Session.
        status: 'COMPLETED',
        units,
        createdBy: actorUserId,
      });
    } catch (err) {
      if (err?.code !== 11000) throw err;
      const raced = await this._findManualByKey(tenantId, generationKey, { ensureRecord: false });
      if (raced) return raced;
      // The appointment exists but its session does not: either a concurrent
      // identical request is between the two writes, or an earlier attempt
      // failed after the appointment. Continue on THAT appointment — the session
      // write below is itself guarded by the unique generationKey.
      appt = await this.deps.appointments.findById(tenantId, manualAppointmentId(tenantId, generationKey));
      if (!appt || appt.clientId !== input.clientId) throw bcbaSessionError('SESSION_CONFLICT');
    }

    const doc = input.documentation || {};
    const now = this.now();
    let session;
    try {
      session = await this.deps.sessions.create(tenantId, {
        appointmentId: appt.id,
        clientId: input.clientId,
        staffProfileId: bcbaStaffProfileId,
        treatmentPlanId: null,
        startedAt,
        endedAt,
        clockInAt: startedAt,
        clockInBy: bcbaStaffProfileId,
        clockOutAt: endedAt,
        clockOutBy: bcbaStaffProfileId,
        intervals: [{ startedAt, endedAt, startedBy: bcbaStaffProfileId, endedBy: bcbaStaffProfileId }],
        status: 'FROZEN',
        active: false, // completed — does not occupy the open-session slot
        source: 'MANUAL',
        frozenAt: now,
        frozenBy: actorUserId,
        generationKey,
        selectedAuthorizationId: authorizationIds[0],
        selectedAuthorizationIds: authorizationIds,
        authorizationMemos: authorizationIds.map((authorizationId) => ({ authorizationId, memo: null })),
        documentation: {
          what: doc.what != null && doc.what !== '' ? this.deps.phi.seal(doc.what) : null,
          how: doc.how != null && doc.how !== '' ? this.deps.phi.seal(doc.how) : null,
          childResponse: doc.childResponse != null && doc.childResponse !== '' ? this.deps.phi.seal(doc.childResponse) : null,
        },
        sensitive: { narrative: input.memo != null && input.memo !== '' ? this.deps.phi.seal(input.memo) : null },
        createdBy: actorUserId,
        updatedBy: actorUserId,
      });
    } catch (err) {
      // The sessions repository reports its unique-index violation as
      // SESSION_EXISTS (a raw driver error may still carry 11000): an identical
      // concurrent request won — return its session instead of failing.
      if (err?.code !== 11000 && err?.code !== 'SESSION_EXISTS') throw err;
      const raced = await this._findManualByKey(tenantId, generationKey);
      if (raced) return raced;
      throw bcbaSessionError('SESSION_CONFLICT');
    }

    // Same time-record path payroll, My Hours and billing read.
    const record = await this._ensureTimeRecord({
      tenantId, actorUserId, bcbaStaffProfileId, appt, session, memoCaptured: Boolean(input.memo),
    });
    return { session: this._present(session), timeRecord: record, alreadyExists: false };
  }

  /** An identical manual entry already recorded → its session + time record (idempotent). */
  async _findManualByKey(tenantId, generationKey, { ensureRecord = true } = {}) {
    if (!this.deps.sessions.findByGenerationKey) return null;
    const existing = await this.deps.sessions.findByGenerationKey(tenantId, generationKey);
    if (!existing) return null;
    // A request that lost a concurrent race only READS the winner's record; the
    // winner writes it. A plain repeat backfills a missing record (partial failure).
    let record = await this.deps.timeRecords.findBySession(tenantId, existing.id);
    if (!record && ensureRecord) {
      const appt = existing.appointmentId ? await this.deps.appointments.findById(tenantId, existing.appointmentId) : null;
      if (appt) record = await this._ensureTimeRecord({ tenantId, actorUserId: existing.createdBy ?? null, bcbaStaffProfileId: existing.staffProfileId, appt, session: existing });
    }
    return { session: this._present(existing), timeRecord: record, alreadyExists: true };
  }

  async saveDocumentation({ tenantId, actorUserId, bcbaStaffProfileId, appointmentId, documentation = {}, role = 'BCBA' }) {
    await this._assertActive(tenantId);
    this._requireStaff(bcbaStaffProfileId);
    await this._requireOwnedAppointment(tenantId, bcbaStaffProfileId, appointmentId, role);

    const session = await this.deps.sessions.findByAppointment(tenantId, appointmentId, bcbaStaffProfileId);
    if (!session) throw bcbaSessionError('SESSION_NOT_FOUND');
    // Documentation is captured live during the session; a finalized (frozen)
    // session is immutable — amendments go through the existing amend path.
    if (session.status === 'FROZEN' || session.status === 'AMENDED') {
      throw bcbaSessionError('SESSION_ALREADY_COMPLETED');
    }

    // Build a sparse patch: only the provided keys are written, each sealed as
    // PHI. Nothing else on the session is read or written here.
    const patch = {};

    // ROLE SPLIT, ENFORCED HERE ON THE SERVER (not by hiding UI).
    //
    // The three-field clinical documentation (what / how / client response) is
    // the BCBA's workflow. The RBT's in-session input is the Session Memo. An
    // RBT request carrying documentation fields is rejected rather than quietly
    // dropped, so a mistaken client cannot half-write a record and a caller
    // always learns that the write did not happen.
    const wantsDocumentation = documentation.what !== undefined
      || documentation.how !== undefined
      || documentation.childResponse !== undefined;
    if (role === 'RBT' && wantsDocumentation) {
      throw bcbaSessionError('DOCUMENTATION_NOT_PERMITTED');
    }

    if (documentation.what !== undefined) patch['documentation.what'] = documentation.what === '' ? null : this.deps.phi.seal(documentation.what);
    if (documentation.how !== undefined) patch['documentation.how'] = documentation.how === '' ? null : this.deps.phi.seal(documentation.how);
    if (documentation.childResponse !== undefined) patch['documentation.childResponse'] = documentation.childResponse === '' ? null : this.deps.phi.seal(documentation.childResponse);

    // SESSION MEMO — available to BOTH roles, and the RBT's only in-session
    // input. It is stored in the session's EXISTING sealed narrative field, the
    // same one the completion flow writes, so the memo a clinician saves while
    // working is the memo that flows downstream into the session note. No second
    // memo field and no second notes architecture.
    if (documentation.memo !== undefined) {
      patch['sensitive.narrative'] = documentation.memo === '' ? null : this.deps.phi.seal(documentation.memo);
    }
    patch.updatedBy = actorUserId;

    const updated = await this.deps.sessions.update(tenantId, session.id, patch);
    return this._present(updated ?? session);
  }

  // --- CHILD DETAIL (spec Part 5, 6, 24) -----------------------------------

  /**
   * A clean, permission-scoped child overview for the session/child dashboard.
   * Scoped through _requireOwnedAppointment, so a BCBA can only read the child
   * of an appointment assigned to THEM (bcbaId === me) — requesting another
   * BCBA's appointment/child id is rejected (Part 24). No raw DB dump and no
   * invented fields: only what the Client model and the appointment/session
   * actually hold. SSN and other sensitive identifiers are never included.
   */
  async getChildDetail({ tenantId, bcbaStaffProfileId, appointmentId, role = 'BCBA' }) {
    this._requireStaff(bcbaStaffProfileId);
    const appt = await this._requireOwnedAppointment(tenantId, bcbaStaffProfileId, appointmentId, role);

    const client = await this.deps.clients.findById(tenantId, appt.clientId);
    const session = await this.deps.sessions.findByAppointment(tenantId, appt.id, bcbaStaffProfileId);
    // This is the screen the RBT reads the plan from during a session, so the
    // plan resolved here must be the one applicable on THIS appointment's
    // service date — never simply the most recently edited active plan.
    const plan = await this.deps.plans.findActivePlanForClient(tenantId, appt.clientId, appt.startAt ?? undefined);
    let planSummary = null;
    if (plan && this.deps.plans.summarize) planSummary = await this.deps.plans.summarize(tenantId, plan.id);
    const authorizations = await this._resolveAuths(tenantId, appt);

    return {
      child: client ? {
        id: client.id,
        clientNumber: client.clientNumber ?? null,
        firstName: client.firstName ?? null,
        lastName: client.lastName ?? null,
        preferredName: client.preferredName ?? null,
        dateOfBirth: client.dateOfBirth ?? null,
        age: ageFrom(client.dateOfBirth),
        pronouns: client.pronouns ?? null,
        status: client.status ?? null,
        primaryLanguage: client.primaryLanguage ?? null,
        city: client.address?.city ?? client.city ?? null,
        state: client.address?.state ?? client.state ?? null,
      } : { id: appt.clientId },
      appointment: {
        id: appt.id,
        startAt: appt.startAt,
        endAt: appt.endAt,
        timeSet: appt.timeSet ?? true,
        bcbaId: appt.bcbaId ?? null,
        rbtId: appt.rbtId ?? null,
        authorizationIds: this._eligibleAuthorizations(appt),
        authorizations, // normalized display objects (§10/§11)
        status: appt.status,
      },
      activePlan: plan ? { id: plan.id, title: plan.title ?? null, status: plan.status, ...(planSummary ?? {}) } : null,
      session: session ? {
        id: session.id,
        status: this._derivedStatus(appt, session),
        startedAt: session.startedAt ?? null,
        endedAt: session.endedAt ?? null,
        // In-session documentation (opened) so the active-session screen can
        // pre-fill What / How / Child response on reload and navigation (§8).
        documentation: {
          what: session.documentation?.what != null ? this.deps.phi.open(session.documentation.what) : null,
          how: session.documentation?.how != null ? this.deps.phi.open(session.documentation.how) : null,
          childResponse: session.documentation?.childResponse != null ? this.deps.phi.open(session.documentation.childResponse) : null,
        },
        // The in-session Session Memo, so it rehydrates on reload/navigation.
        memo: session.sensitive?.narrative != null ? this.deps.phi.open(session.sensitive.narrative) : null,
        // The running work period's start — the timer's anchor on this surface
        // too, so no screen has to fall back to the session start.
        activePeriodStartedAt: activePeriodStartedAt(session),
      } : null,
    };
  }

  // --- STOP SESSION (§9, §10, §11) -----------------------------------------

  /**
   * Stop the running session: fix `endedAt` on the server (§9) and return the
   * completion payload — exact start/end to the second, duration, and the
   * eligible ABA/FBA authorizations for selection (§11). Does NOT finalize or
   * touch payroll yet; that is a deliberate second step (COMPLETE) so the BCBA
   * can choose the authorization and write the memo. Idempotent: stopping an
   * already-stopped session just returns the same completion payload.
   */
  async stopSession({ tenantId, actorUserId, bcbaStaffProfileId, appointmentId, role = 'BCBA' }) {
    await this._assertActive(tenantId);
    this._requireStaff(bcbaStaffProfileId);
    const appt = await this._requireOwnedAppointment(tenantId, bcbaStaffProfileId, appointmentId, role);

    // A finalized session is active:false and so is NOT returned by
    // findByAppointment; resolve it explicitly so a repeated Stop after
    // completion returns the recorded work instead of a 404.
    const session = await this._findSessionForFinalize(tenantId, appointmentId, bcbaStaffProfileId);
    if (!session) throw bcbaSessionError('SESSION_NOT_FOUND');
    if (session.status === 'FROZEN' || session.status === 'AMENDED') {
      // Already completed — hand back the completion payload from the record.
      return this._completionPayload(appt, session, await this.deps.timeRecords.findBySession(tenantId, session.id), await this._resolveAuths(tenantId, appt));
    }
    if (session.status !== 'IN_PROGRESS') throw bcbaSessionError('SESSION_NOT_RUNNING');

    let stopped = session;
    if (hasRunningInterval(session.intervals) || !session.endedAt) {
      const now = this.now();
      // endedAt must be after startedAt — a coherence guard, not a rounding one.
      if (session.startedAt && now <= new Date(session.startedAt)) {
        throw bcbaSessionError('INVALID_TIME', { message: 'The stop time has to be after the start time.' });
      }
      // Close the RUNNING interval and record the session's latest end. Earlier
      // intervals are carried through untouched (§10: previous timing
      // information is never overwritten), so the history stays complete and
      // worked time is the sum across all of them.
      stopped = await this.deps.sessions.update(tenantId, session.id, {
        endedAt: now,
        clockOutAt: now,
        clockOutBy: bcbaStaffProfileId,
        intervals: closeInterval(session.intervals, now, bcbaStaffProfileId),
        updatedBy: actorUserId,
      });
    }
    return this._completionPayload(appt, stopped, null, await this._resolveAuths(tenantId, appt));
  }

  /** Normalized, user-facing eligible authorizations (never raw `svc:` ids). */
  async _resolveAuths(tenantId, appt) {
    const ids = this._eligibleAuthorizations(appt);
    if (!this.deps.authorizations?.resolveMany) return ids.map((id) => ({ id, label: id }));
    return this.deps.authorizations.resolveMany(tenantId, ids);
  }

  // --- COMPLETE / FINALIZE (§11, §12, §13, §14, §16, §17) ------------------

  /**
   * Finalize a stopped session: record the selected authorization and memo,
   * freeze the session (COMPLETED), and create the one idempotent payroll time
   * record with the rate snapshot and computed amount.
   *
   * @param {object} p
   * @param {string} p.authorizationId  must be one already bound to the appointment (§11)
   * @param {string} [p.memo]           free-text session note (§12), sealed as PHI
   */
  /**
   * Comparable civil day number (YYYYMMDD) for an instant in a timezone.
   * Delegates to the ONE business-date authority so this gate can never drift
   * from the calendar, the booking core, or payroll's period windows.
   */
  _civilDayNumber(value, timeZone) {
    return civilDayNumber(value, timeZone);
  }

  /**
   * THE server-side Start gate. Refuses with APPOINTMENT_NOT_TODAY (409, the
   * existing contract) unless one of the appointment's 24-hour start windows
   * is open NOW — judged by the SERVER clock in the organization timezone, via
   * the shared startEligibility rule. `details.startStatus` says whether it is
   * EXPIRED or not yet open (UPCOMING).
   */
  async _assertStartableNow(tenantId, appt, existingSession = null) {
    if (!appt?.startAt) return;
    const org = await this.deps.organizations.getById(tenantId);
    const tz = org?.timezone || 'UTC';
    // Resuming work already begun is judged by THAT session's own scheduled
    // date — each date in a multi-date range is its own occurrence — so a
    // session begun on 09/12 can't be restarted under 09/13's window.
    const boundDate = existingSession ? sessionBusinessDate(appt, existingSession, tz) : null;
    const eligibility = startEligibility(appt, tz, this.now(), boundDate ? { businessDate: boundDate } : {});
    if (eligibility.status === 'AVAILABLE') return;
    throw bcbaSessionError('APPOINTMENT_NOT_TODAY', describeStartIneligibility(eligibility, tz, { sessionBound: Boolean(boundDate) }));
  }

  async completeSession({ tenantId, actorUserId, bcbaStaffProfileId, appointmentId, authorizationId, memo = null, authorizations = null, role = 'BCBA' }) {
    await this._assertActive(tenantId);
    this._requireStaff(bcbaStaffProfileId);
    const appt = await this._requireOwnedAppointment(tenantId, bcbaStaffProfileId, appointmentId, role);

    const session = await this._findSessionForFinalize(tenantId, appointmentId, bcbaStaffProfileId);
    if (!session) throw bcbaSessionError('SESSION_NOT_FOUND');

    // --- IDEMPOTENCY FAST PATH (§16). Already completed: never a second
    //     payroll record. If the record somehow does not exist yet (a partial
    //     finalize), create it now so payroll is never permanently missing
    //     (§17) — but never duplicate it.
    if (session.status === 'FROZEN' || session.status === 'AMENDED') {
      const existingRecord = await this.deps.timeRecords.findBySession(tenantId, session.id);
      if (existingRecord) {
        return { session: this._present(session), timeRecord: existingRecord, alreadyCompleted: true };
      }
      const record = await this._ensureTimeRecord({ tenantId, actorUserId, bcbaStaffProfileId, appt, session });
      return { session: this._present(session), timeRecord: record, alreadyCompleted: true };
    }

    if (session.status !== 'IN_PROGRESS') throw bcbaSessionError('SESSION_NOT_RUNNING');

    // Normalize the two accepted shapes into ONE ordered list of
    // { authorizationId, memo }. The multi form (spec §22/§23) wins when given;
    // otherwise the legacy single authorizationId (+ optional session memo).
    const eligible = this._eligibleAuthorizations(appt);
    const selections = this._normalizeSelections({ authorizations, authorizationId, memo });
    if (selections.length === 0) {
      throw bcbaSessionError('INVALID_AUTHORIZATION', { details: { eligible } });
    }
    // De-duplicate by id (first memo wins) while preserving order.
    const seen = new Set();
    const unique = [];
    for (const s of selections) {
      if (seen.has(s.authorizationId)) continue;
      seen.add(s.authorizationId);
      unique.push(s);
    }
    // EVERY selected authorization must be one bound to THIS appointment (§11/§25):
    // a BCBA cannot hand-submit another child's authorization id — it will not
    // be in the eligible set. This is the server-side guard; the UI only offers
    // eligible rows.
    for (const s of unique) {
      if (!s.authorizationId || !eligible.includes(s.authorizationId)) {
        throw bcbaSessionError('INVALID_AUTHORIZATION', { details: { eligible } });
      }
    }
    const selectedIds = unique.map((s) => s.authorizationId);
    const primaryId = selectedIds[0];

    // Ensure the session is stopped; if the BCBA completes directly, stop now.
    const endedAt = session.endedAt ?? this.now();
    if (session.startedAt && new Date(endedAt) <= new Date(session.startedAt)) {
      throw bcbaSessionError('INVALID_TIME', { message: 'The session end has to be after its start.' });
    }

    // Persist per-authorization memos (each sealed as PHI) + selected set + the
    // primary + end. The legacy single memo, when given, is ALSO kept as the
    // session narrative so existing Session Detail readers still show it.
    const authorizationMemos = unique.map((s) => ({
      authorizationId: s.authorizationId,
      memo: s.memo != null ? this.deps.phi.seal(s.memo) : null,
    }));
    const anyMemo = unique.some((s) => s.memo != null && String(s.memo).trim() !== '');
    const legacyNarrative = memo != null ? memo : (unique.length === 1 ? unique[0].memo : null);
    await this.deps.sessions.update(tenantId, session.id, {
      endedAt,
      ...(legacyNarrative != null ? { 'sensitive.narrative': this.deps.phi.seal(legacyNarrative) } : {}),
      selectedAuthorizationId: primaryId,
      selectedAuthorizationIds: selectedIds,
      authorizationMemos,
      updatedBy: actorUserId,
    });

    // Freeze = COMPLETED. Self-delivered completion is NOT peer review, so it
    // does not pass through the separation-of-duties approval gate — the BCBA
    // is finalizing their OWN direct-service session, which is the whole point
    // of this workflow.
    const frozen = await this.deps.sessions.freeze(tenantId, session.id, actorUserId);

    // Re-read to get the persisted endedAt/narrative/authorizations onto the record.
    const finalized = await this.deps.sessions.findById(tenantId, session.id);
    const record = await this._ensureTimeRecord({
      tenantId, actorUserId, bcbaStaffProfileId, appt, session: finalized ?? frozen, memoCaptured: anyMemo || memo != null,
    });

    // Resolve the SELECTED authorizations to display objects (§10/§11/§26) so the
    // completion screen / review queue never shows a raw `svc:` id.
    const resolved = await this._resolveAuths(tenantId, appt);
    const authorizations2 = selectedIds
      .map((aid) => resolved.find((a) => a.id === aid) ?? { id: aid, label: aid });

    return {
      session: this._present(finalized ?? frozen),
      timeRecord: record,
      authorization: authorizations2[0] ?? null, // primary (legacy field)
      authorizations: authorizations2,            // full selected set (spec §22)
      alreadyCompleted: false,
    };
  }

  /**
   * Fold the two accepted request shapes into one ordered [{authorizationId,
   * memo}] list. The multi form (spec §22/§23) takes precedence; otherwise the
   * legacy single authorizationId with the session-level memo attached.
   */
  _normalizeSelections({ authorizations, authorizationId, memo }) {
    if (Array.isArray(authorizations) && authorizations.length > 0) {
      return authorizations
        .filter((a) => a && a.authorizationId)
        .map((a) => ({ authorizationId: a.authorizationId, memo: a.memo ?? null }));
    }
    if (authorizationId) return [{ authorizationId, memo: memo ?? null }];
    return [];
  }

  /**
   * Create the payroll time record for a completed session, idempotently. The
   * unique index on (tenant, sessionId) is the real guarantee; this method
   * checks-then-creates and also swallows a duplicate-key race, so two racing
   * finalizes still yield exactly one record (§16).
   */
  async _ensureTimeRecord({ tenantId, actorUserId, bcbaStaffProfileId, appt, session, memoCaptured = undefined }) {
    const found = await this.deps.timeRecords.findBySession(tenantId, session.id);
    if (found) return found;

    // Worked time is the SUM of this session's timing intervals (one logical
    // session, several Start/Stop periods), falling back to the verified clock
    // for sessions recorded before intervals existed. This is the ONE number
    // payroll, billing, reports and exports all read, via SessionTimeRecord.
    const minutes = sessionWorkedMinutes(session);
    const rateDollars = await this.deps.payRates.getCurrentHourlyRate({ tenantId, staffProfileId: bcbaStaffProfileId });
    const hourlyRateMinor = dollarsToMinor(rateDollars);
    const amount = payAmountMinor({ hourlyRateMinor, minutes });

    const doc = {
      staffProfileId: bcbaStaffProfileId,
      clientId: session.clientId,
      sessionId: session.id,
      appointmentId: appt.id,
      authorizationId: session.selectedAuthorizationId ?? null,
      // The authorizations actually selected at completion (spec §22), not the
      // whole eligible set — falls back to eligible for legacy sessions that
      // never recorded a selection.
      authorizationIds: session.selectedAuthorizationIds?.length
        ? session.selectedAuthorizationIds
        : this._eligibleAuthorizations(appt),
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      workedMinutes: minutes,
      hourlyRateSnapshot: hourlyRateMinor,
      currency: 'usd',
      amount,
      memoCaptured: memoCaptured ?? !!session.narrative,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    };
    try {
      return await this.deps.timeRecords.create(tenantId, doc);
    } catch (err) {
      // The (tenant, session) unique index: a concurrent writer recorded it first.
      // That record IS this session's record — return it instead of failing.
      if (err?.code === 11000) {
        const raced = await this.deps.timeRecords.findBySession(tenantId, session.id);
        if (raced) return raced;
      }
      throw err;
    }
  }

  // --- WEEKLY HOURS (§K, §L, §M, §N) ---------------------------------------

  /**
   * This BCBA's progress toward the COMPANY-configured weekly work requirement.
   * The target comes from the company's staffing settings (never hardcoded, §K);
   * the completed total is the sum of actual worked minutes on the BCBA's own
   * finalized sessions within the CURRENT company week, anchored in the company's
   * timezone with the company's week-start day (§L — not a rolling 7 days). Only
   * this BCBA's own records are summed (§R): the staffProfileId is the token's.
   */
  async getWeeklyHours({ tenantId, bcbaStaffProfileId, now = null }) {
    this._requireStaff(bcbaStaffProfileId);

    const org = await this.deps.organizations.getById(tenantId);
    const timeZone = org?.timezone || 'UTC';

    let target = 0;
    // Strict Monday → Sunday clinician week (see HOURS_WEEK_STARTS_ON).
    const weekStartsOn = HOURS_WEEK_STARTS_ON;
    if (this.deps.settings?.getStaffing) {
      const s = await this.deps.settings.getStaffing(tenantId);
      target = Number(s?.weeklyHoursTarget) || 0;
    }

    const at = now ? new Date(now) : this.now();
    const week = companyWeekWindow(at, timeZone, weekStartsOn);
    const { minutes, sessions } = await this.deps.timeRecords.sumWorkedMinutes(tenantId, {
      staffProfileId: bcbaStaffProfileId,
      from: week.start,
      to: week.end,
    });

    const summary = summarizeWeekly({ targetHours: target, completedMinutes: minutes });
    return {
      ...summary,
      sessionCount: sessions,
      weekStart: week.start,
      weekEnd: week.end,
      timeZone,
      weekStartsOn: week.weekStartsOn,
    };
  }

  /**
   * "My Hours" (spec Change 4) — the authenticated BCBA's OWN worked time over a
   * selectable period, as exact hours/minutes/seconds. Worked-time only: this
   * returns no rate, amount, currency or any pay field. It reuses the SAME
   * authoritative SessionTimeRecord data and the SAME company timezone/week
   * configuration as the weekly block, so the two never disagree.
   *
   * Security (§R): only THIS staffProfileId's records are summed. The id is the
   * caller's own, resolved from the token by requirePermission — the frontend
   * cannot pass an arbitrary staffProfileId — and the aggregate is tenant-scoped
   * via withTenant, so BCBA A can never see BCBA B's hours and tenant A can
   * never see tenant B's.
   */
  async getMyHours({ tenantId, bcbaStaffProfileId, period = 'week', now = null }) {
    this._requireStaff(bcbaStaffProfileId);

    const org = await this.deps.organizations.getById(tenantId);
    const timeZone = org?.timezone || 'UTC';

    // Strict Monday → Sunday clinician week (see HOURS_WEEK_STARTS_ON).
    const weekStartsOn = HOURS_WEEK_STARTS_ON;

    const at = now ? new Date(now) : this.now();
    const win = companyPeriodWindow(at, timeZone, weekStartsOn, period);
    const { seconds, sessions } = await this.deps.timeRecords.sumWorkedSeconds(tenantId, {
      staffProfileId: bcbaStaffProfileId,
      from: win.start,
      to: win.end,
    });

    const parts = splitHms(seconds);
    return {
      period: win.period,
      totalSeconds: seconds,
      hours: parts.hours,
      minutes: parts.minutes,
      seconds: parts.seconds,
      text: humanHms(seconds),
      sessionCount: sessions,
      from: win.start,
      to: win.end,
      timeZone,
      weekStartsOn,
    };
  }

  /**
   * Throw WEEKLY_TARGET_REACHED when this BCBA has already met the company's
   * configured weekly requirement for the current company week (§14). A no-op
   * when the weekly-hours primitives are not wired, or when the company has NOT
   * configured a target (§17: no target → no block), or when time remains in the
   * week (§15: a valid remaining appointment must still be startable). Reuses
   * getWeeklyHours so the block and the dashboard read from the SAME truth — the
   * summed authoritative worked minutes, in the company timezone/week.
   */
  async _assertWeeklyCapacity(tenantId, bcbaStaffProfileId) {
    if (!this.deps.settings?.getStaffing || !this.deps.timeRecords?.sumWorkedMinutes) return;
    const weekly = await this.getWeeklyHours({ tenantId, bcbaStaffProfileId });
    if (!weekly.configured) return;               // no configured target → never block
    if (weekly.remainingMinutes > 0) return;      // still short of the target → allow
    // Whole-hour phrasing for the user-facing message: "Your 30-hour weekly
    // schedule is complete." (spec §12) — dynamic from the configured target.
    const hours = Math.round((weekly.targetMinutes || 0) / 60);
    throw bcbaSessionError('WEEKLY_TARGET_REACHED', {
      message: `Your ${hours}-hour weekly schedule is complete. No additional sessions can be started this week.`,
      details: {
        targetText: weekly.targetText,
        completedText: weekly.completedText,
        remainingText: weekly.remainingText,
      },
    });
  }

  // --- ADMIN PAYROLL VISIBILITY (§15) --------------------------------------

  /** List session payroll/time records for the admin payroll area. */
  async listTimeRecords({ tenantId, staffProfileId = null, from = null, to = null, limit = 100 }) {
    return this.deps.timeRecords.list(tenantId, { staffProfileId, from, to, limit });
  }

  // --- internals -----------------------------------------------------------

  _eligibleAuthorizations(appt) {
    if (appt.authorizationIds?.length) return [...appt.authorizationIds];
    return appt.authorizationId ? [appt.authorizationId] : [];
  }

  _completionPayload(appt, session, timeRecord, resolvedAuths = null) {
    const rawIds = this._eligibleAuthorizations(appt);
    return {
      appointmentId: appt.id,
      sessionId: session.id,
      status: this._derivedStatus(appt, session),
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      // Worked time is the SUM across every timing interval of this one logical
      // session, so a Start/Stop/Start/Stop day reads as a single session with
      // the correct total — not as several sessions.
      durationText: session.endedAt ? humanSeconds(sessionWorkedSeconds(session)) : null,
      workedMinutes: session.endedAt ? sessionWorkedMinutes(session) : null,
      // The full timing history (§10/§30): every interval stays visible in the
      // session detail, while the totals above stay single-valued.
      intervals: (session.intervals ?? []).map((iv) => ({
        startedAt: iv.startedAt ?? null,
        endedAt: iv.endedAt ?? null,
        workedMinutes: iv.startedAt && iv.endedAt ? workedMinutes(iv.startedAt, iv.endedAt) : null,
      })),
      intervalCount: (session.intervals ?? []).filter((iv) => iv?.startedAt && iv?.endedAt).length,
      // Normalized, user-facing options (never a raw `svc:` id as a label).
      eligibleAuthorizations: resolvedAuths ?? rawIds.map((id) => ({ id, label: id })),
      eligibleAuthorizationIds: rawIds, // internal ids kept for validation
      selectedAuthorizationId: session.selectedAuthorizationId ?? null,
      // The saved Session Note (opened) so the completion screen can offer
      // "Import from Session Note" into the memo (Phase 4 §5/§10). Read-only copy.
      // The Session Memo written DURING the session travels with it, so the
      // completion screen can show what the clinician already wrote instead of
      // presenting an empty box and quietly losing it.
      memo: session.sensitive?.narrative != null ? this.deps.phi.open(session.sensitive.narrative) : null,
      documentation: {
        what: session.documentation?.what != null ? this.deps.phi.open(session.documentation.what) : null,
        how: session.documentation?.how != null ? this.deps.phi.open(session.documentation.how) : null,
        childResponse: session.documentation?.childResponse != null ? this.deps.phi.open(session.documentation.childResponse) : null,
      },
      timeRecord: timeRecord ?? null,
    };
  }

  /** Open the sealed narrative for an authorised response; drop the raw sealed blob. */
  _present(session) {
    if (!session) return session;
    const narrative = session.sensitive ? this.deps.phi.open(session.sensitive.narrative) : (session.narrative ?? null);
    // Open each per-authorization memo (sealed PHI) into plaintext for the
    // authorised completion/detail response (spec §23). Never leak the sealed blob.
    const authorizationMemos = Array.isArray(session.authorizationMemos)
      ? session.authorizationMemos.map((m) => ({
        authorizationId: m.authorizationId,
        memo: m.memo != null ? this.deps.phi.open(m.memo) : null,
      }))
      : [];
    const { sensitive, ...rest } = session;
    // Open the in-session documentation envelope for the authorised response
    // (spec §1/§8/§11). Never leak the sealed blobs.
    const documentation = {
      what: session.documentation?.what != null ? this.deps.phi.open(session.documentation.what) : null,
      how: session.documentation?.how != null ? this.deps.phi.open(session.documentation.how) : null,
      childResponse: session.documentation?.childResponse != null ? this.deps.phi.open(session.documentation.childResponse) : null,
    };
    // `memo` is the same sealed narrative under the name the session screens
    // use, so a memo saved mid-session reappears after a refresh without the
    // client needing to know the storage field's history.
    return { ...rest, narrative: narrative ?? null, memo: narrative ?? null, authorizationMemos, documentation };
  }
}

/** Whole years from a date of birth, or null. Used for the child overview. */
function ageFrom(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
  return age >= 0 && age < 200 ? age : null;
}

/**
 * Deterministic UUID-shaped appointment id for a manual entry, from the tenant
 * and the manual key — so two concurrent identical requests collide on the
 * appointment insert instead of both creating records.
 */
export function manualAppointmentId(tenantId, generationKey) {
  const h = createHash('sha256').update(`${tenantId}|${generationKey}`).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
