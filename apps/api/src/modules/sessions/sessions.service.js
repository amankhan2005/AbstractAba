import { sessionsError } from './sessions.errors.js';
import { businessDayRange, civilDateString, describeStartIneligibility, startEligibility } from '../../domain/businessDate.js';
import { aggregateOversightChildren, aggregateOversightInsights } from './sessions.oversight.js';
import { validateMeasurement, assertMutable, assertFreezable, assertPatchStatus } from './sessions.rules.js';
import { submissionProblems } from './sessions.completeness.js';
import {
  assertTransition, assertReason, assertCancellationReason, assertMayApprove,
  MUTABLE_STATES,
} from './sessions.lifecycle.js';
import {
  computeBindingHash, assertMaySign, assertSignatureAbsent, assertSignaturesIntact,
  missingEvvElements, isEvvComplete, coarsenLocation,
} from './sessions.signatures.js';

/**
 * Session-capture business rules. The repository holds data access; the
 * organization port answers the ACTIVE gate; the appointments, plans, and
 * targets ports validate cross-module references through narrow reads over the
 * existing repositories; the phi port seals and opens the clinical narrative.
 * Dependencies are injected so the whole orchestration runs without a database.
 *
 * Invariants enforced here:
 *   - ACTIVE gate on every write (409 otherwise).
 *   - A session is captured against a real, non-cancelled appointment, and its
 *     client / staff are taken from that appointment (not the caller's input).
 *   - The referenced plan must be the ACTIVE treatment plan of the appointment's
 *     client; data points may only target targets that belong to that plan and
 *     are not archived.
 *   - The narrative is PHI: sealed on write, opened only on an authorised detail
 *     read, never present in a list.
 *   - FREEZE is terminal and makes the session + its data points immutable — the
 *     record of record. Every mutating path first refuses a frozen session.
 *
 * @typedef {{
 *   repository: object,
 *   organizations: { getById:(id:string)=>Promise<{state:string}|null> },
 *   appointments: { findById:(t:string,id:string)=>Promise<any> },
 *   plans: { findPlanById:(t:string,id:string)=>Promise<any>, findTargetById:(t:string,id:string)=>Promise<any> },
 *   phi: { seal:(v:any)=>any, open:(v:any)=>any },
 * }} SessionsDeps
 */
export class SessionsService {
  /** @param {SessionsDeps} deps */
  constructor(deps) {
    this.deps = deps;
  }

  async _assertActive(tenantId) {
    const org = await this.deps.organizations.getById(tenantId);
    if (!org || org.state !== 'ACTIVE') throw sessionsError('ORG_NOT_ACTIVE');
    return org;
  }

  /**
   * Start-window gate for clocking in (the lifecycle route's "start"). Same
   * shared rule as the BCBA/RBT panel's startSession — a 24-hour window per
   * scheduled date, org timezone — judged by the SERVER clock, never the
   * client-supplied `at`.
   */
  async _assertAppointmentStartableNow(tenantId, org, appointmentId) {
    if (!appointmentId) return;
    const appt = await this.deps.appointments.findById(tenantId, appointmentId);
    if (!appt?.startAt) return;
    const tz = org?.timezone || 'UTC';
    const now = this.deps.now ? this.deps.now() : new Date();
    const eligibility = startEligibility(appt, tz, now);
    if (eligibility.status === 'AVAILABLE') return;
    throw sessionsError('APPOINTMENT_NOT_TODAY', describeStartIneligibility(eligibility, tz, { verb: 'clock in' }));
  }

  /** Load a session and refuse when it is missing or frozen (the immutability guard). */
  async _requireMutableSession(tenantId, sessionId) {
    const session = await this.deps.repository.findSessionById(tenantId, sessionId);
    if (!session) throw sessionsError('SESSION_NOT_FOUND');
    assertMutable(session.status);
    return session;
  }

  // --- sessions ------------------------------------------------------------

  async createSession({ tenantId, actorUserId, input }) {
    await this._assertActive(tenantId);

    const appointment = await this.deps.appointments.findById(tenantId, input.appointmentId);
    if (!appointment || appointment.status === 'CANCELLED') throw sessionsError('APPOINTMENT_INVALID');

    // Treatment plan is OPTIONAL (spec §8/§15). When the caller supplies one it
    // MUST be an ACTIVE plan for the appointment's client — an invalid or
    // wrong-child plan id is still rejected (never silently dropped). When none
    // is supplied the session is created plan-less (treatmentPlanId:null); the
    // RBT can still start and document, and a plan can be bound later.
    let treatmentPlanId = null;
    if (input.treatmentPlanId) {
      const plan = await this.deps.plans.findPlanById(tenantId, input.treatmentPlanId);
      if (!plan || plan.status !== 'ACTIVE' || plan.clientId !== appointment.clientId) {
        throw sessionsError('PLAN_INVALID');
      }
      treatmentPlanId = plan.id;
    }

    const doc = {
      appointmentId: appointment.id,
      clientId: appointment.clientId,
      staffProfileId: appointment.staffProfileId,
      treatmentPlanId,
      startedAt: input.startedAt !== undefined ? new Date(input.startedAt) : (appointment.startAt ?? new Date()),
      ...(input.endedAt !== undefined ? { endedAt: new Date(input.endedAt) } : {}),
      sensitive: { narrative: input.narrative !== undefined ? this.deps.phi.seal(input.narrative) : null },
      status: 'DRAFT',
      createdBy: actorUserId,
      updatedBy: actorUserId,
    };
    const created = await this.deps.repository.createSession(tenantId, doc);
    return this._present(created);
  }

  async getSession({ tenantId, sessionId, actorScope = null }) {
    const session = await this.deps.repository.findSessionById(tenantId, sessionId);
    if (!session) throw sessionsError('SESSION_NOT_FOUND');
    // Data points and the display context are independent: read them together.
    const [dataPoints, context] = await Promise.all([
      this.deps.repository.listDataPoints(tenantId, sessionId),
      this._resolveSessionContext(tenantId, session, actorScope),
    ]);
    // Resolve the related records into user-facing context (child, appointment
    // window, BCBA/RBT, units, authorization label, payroll) so the Session
    // Detail can show meaningful business information instead of blanks. This
    // reuses the already-wired appointment/client/authorization/time-record
    // ports; it is best-effort and never blocks the core session read.
    // actorScope role-scopes the COUNTERPART clinician: a clinician viewing their
    // own session never receives the other clinician's identity (spec §7–§14);
    // a tenant-wide admin (oversight) sees both.
    return { session: this._present(session), dataPoints, ...context };
  }

  /**
   * Compose the read-only display context for a session from the platform's
   * existing repositories. Every lookup is guarded (the port may be absent in a
   * narrow test harness) and the whole thing is wrapped so a resolution failure
   * degrades to nulls rather than breaking Session Detail.
   */
  async _resolveSessionContext(tenantId, session, actorScope = null) {
    const out = { child: null, appointment: null, payroll: null, display: { childName: null, bcbaName: null, rbtName: null, treatmentPlanName: null } };
    // In-session documentation (spec §11): surface What / How / Child response
    // for an authorised viewer, distinct from the treatment plan and the
    // completion memos. Opened here from the sealed envelope on the session.
    out.documentation = {
      what: session.documentation?.what != null ? this.deps.phi.open(session.documentation.what) : null,
      how: session.documentation?.how != null ? this.deps.phi.open(session.documentation.how) : null,
      childResponse: session.documentation?.childResponse != null ? this.deps.phi.open(session.documentation.childResponse) : null,
    };
    // Resolve a tenant-scoped staff display name (never an id) — used for the
    // BCBA and RBT on the appointment. Guarded: the port may be absent in a
    // narrow test harness.
    const staffName = async (id) => {
      if (!id || !this.deps.staff?.findById) return null;
      try {
        const p = await this.deps.staff.findById(tenantId, id);
        if (!p) return null;
        const name = [p.firstName, p.lastName].filter((x) => x != null && String(x).trim() !== '').join(' ').trim();
        return name || null;
      } catch { return null; }
    };
    try {
      // The appointment, the child and this session's time record do not depend
      // on one another, so they are read together; the appointment's
      // authorizations and clinician names follow in a second parallel step.
      const [appt, client, timeRecord, plan] = await Promise.all([
        (session.appointmentId && this.deps.appointments?.findById)
          ? this.deps.appointments.findById(tenantId, session.appointmentId).catch(() => null)
          : Promise.resolve(null),
        (session.clientId && this.deps.clients?.findById)
          ? this.deps.clients.findById(tenantId, session.clientId).catch(() => null)
          : Promise.resolve(null),
        (this.deps.timeRecords?.findBySession)
          ? this.deps.timeRecords.findBySession(tenantId, session.id).catch(() => null)
          : Promise.resolve(null),
        (session.treatmentPlanId && this.deps.plans?.findPlanById)
          ? this.deps.plans.findPlanById(tenantId, session.treatmentPlanId).catch(() => null)
          : Promise.resolve(null),
      ]);
      // The treatment plan's display name (the plan itself is unchanged and read-only here).
      out.display.treatmentPlanName = plan ? (plan.name ?? plan.title ?? null) : null;
      // PERFORMANCE (spec §34/§35): the child, the appointment's authorizations,
      // and this session's time record are INDEPENDENT of one another and of the
      // appointment's clinician names. Previously each was awaited in series, so
      // Session Detail paid the sum of every round-trip. They are now issued
      // together and awaited once — the response is bounded by the slowest
      // lookup, not their sum — while every result stays behind the same guards
      // and the same role scoping below. No data is added or removed.
      const rawAuthIds = appt
        ? (appt.authorizationIds?.length ? appt.authorizationIds : (appt.authorizationId ? [appt.authorizationId] : []))
        : [];
      const authorizationsPromise = (appt && this.deps.authorizations?.resolveMany && rawAuthIds.length)
        ? this.deps.authorizations.resolveMany(tenantId, rawAuthIds).catch(() => [])
        : Promise.resolve([]);
      if (appt) {
        // Role scoping (spec §7–§14): a clinician viewing THEIR OWN session must
        // not receive the other clinician's identity. A tenant-wide admin
        // (oversight) — or a caller with no scope, e.g. an internal/test call —
        // sees both. `ownRole` is the role that actually owns THIS session.
        const unrestricted = (v) => v == null;
        const isAdminOrInternal = !actorScope || (unrestricted(actorScope.clientIds) && unrestricted(actorScope.staffIds));
        const ownRole = session.staffProfileId === appt.bcbaId ? 'BCBA'
          : session.staffProfileId === appt.rbtId ? 'RBT' : null;
        // The clinical lead (BCBA, TEAM scope) supervises the child's care team,
        // so they see the RBT as well as the BCBA. The RBT (SELF scope) never
        // receives the BCBA's identity. Access to the session itself was already
        // decided by the route's scope guard.
        const viewerIsLead = actorScope?.scope === 'TEAM';
        const showBcba = isAdminOrInternal || ownRole === 'BCBA' || viewerIsLead;
        const showRbt = isAdminOrInternal || ownRole === 'RBT' || viewerIsLead;
        // The RBT named for the BCBA: the appointment's RBT, else the child's
        // active RBT assignment(s) — the persisted care team, never guessed.
        let rbtIds = appt.rbtId ? [appt.rbtId] : [];
        if (!rbtIds.length && viewerIsLead && session.clientId && this.deps.careTeam?.activeRbtIds) {
          rbtIds = await this.deps.careTeam.activeRbtIds(tenantId, session.clientId).catch(() => []);
        }
        // Resolve only the clinician name(s) this caller is allowed to see — in
        // parallel, and only the ones actually shown.
        const wanted = [showBcba ? appt.bcbaId : null, ...(showRbt ? rbtIds : [])].filter(Boolean);
        const namesPromise = this.deps.staff?.findNamesByIds
          ? this.deps.staff.findNamesByIds(tenantId, wanted).then((list) => new Map(list.map((p) => [p.id, [p.firstName, p.lastName].filter((x) => x != null && String(x).trim() !== '').join(' ').trim() || null]))).catch(() => new Map())
          : Promise.all(wanted.map((id) => staffName(id))).then((names) => new Map(wanted.map((id, i) => [id, names[i]])));
        const [authorizations, names] = await Promise.all([authorizationsPromise, namesPromise]);
        const bcbaName = showBcba && appt.bcbaId ? names.get(appt.bcbaId) ?? null : null;
        const rbtName = showRbt ? (rbtIds.map((id) => names.get(id)).filter(Boolean).join(', ') || null) : null;
        // Prefer the authorization the BCBA actually selected at completion.
        const selected = session.selectedAuthorizationId
          ? (authorizations.find((a) => a.id === session.selectedAuthorizationId) ?? null)
          : null;
        // The full SELECTED authorization set + each one's memo (spec §22/§23),
        // resolved to display objects. Memos arrive already-opened on the session.
        const memoById = new Map((session.authorizationMemos ?? []).map((m) => [
          m.authorizationId,
          m.memo != null ? this.deps.phi.open(m.memo) : null,
        ]));
        const selectedIds = session.selectedAuthorizationIds?.length
          ? session.selectedAuthorizationIds
          : (session.selectedAuthorizationId ? [session.selectedAuthorizationId] : []);
        const selectedAuthorizations = selectedIds.map((aid) => {
          const disp = authorizations.find((a) => a.id === aid) ?? { id: aid, label: aid };
          return { ...disp, memo: memoById.get(aid) ?? null };
        });
        out.appointment = {
          startAt: appt.startAt ?? null,
          endAt: appt.endAt ?? null,
          timeSet: appt.timeSet ?? true, // date-only appointments must not invent a clock time (spec §32)
          bcbaId: showBcba ? (appt.bcbaId ?? null) : null,
          rbtId: showRbt ? (appt.rbtId ?? null) : null,
          units: appt.units ?? null,
          authorizations,
          selectedAuthorization: selected ?? (authorizations[0] ?? null),
          selectedAuthorizations,
        };
        out.display.bcbaName = bcbaName;
        out.display.rbtName = rbtName;
      }
      if (client) {
        out.child = {
          firstName: client.firstName ?? null,
          lastName: client.lastName ?? null,
          preferredName: client.preferredName ?? null,
          age: ageFromDob(client.dateOfBirth),
        };
        const childName = (client.preferredName && String(client.preferredName).trim())
          || [client.firstName, client.lastName].filter((x) => x != null && String(x).trim() !== '').join(' ').trim();
        out.display.childName = childName || null;
      }
      if (timeRecord) {
        out.payroll = {
          workedMinutes: timeRecord.workedMinutes ?? null,
          hourlyRateSnapshot: timeRecord.hourlyRateSnapshot ?? null,
          amount: timeRecord.amount ?? null,
          currency: timeRecord.currency ?? 'usd',
        };
      }
    } catch {
      /* best-effort enrichment — the core session read must never fail here */
    }
    return out;
  }

  /**
   * Minimal projection used by the by-id scope guard: just the two references
   * the caseload boundary is decided on. Deliberately does NOT open the sealed
   * narrative — the guard must be able to run before we know the caller is
   * entitled to the record's contents.
   */
  async findSessionForScope({ tenantId, sessionId }) {
    const row = await this.deps.repository.findSessionById(tenantId, sessionId);
    if (!row) return null;
    return { clientId: row.clientId, staffProfileId: row.staffProfileId };
  }

  /**
   * Session-oversight child summaries (spec §4): per child, the BCBA/RBT who
   * worked, session count, total worked minutes and last session. Tenant + data
   * scope enforced by the repository; shaped by the pure aggregator.
   */
  async oversightChildren({ tenantId, dataScope }) {
    if (!this.deps.repository.oversightChildren) return [];
    const { sessions, timeRecs, appts, staff, clients } = await this.deps.repository.oversightChildren(tenantId, dataScope);
    return aggregateOversightChildren({
      sessions,
      workedBySession: new Map((timeRecs ?? []).map((t) => [t.sessionId, t.workedMinutes])),
      apptById: new Map((appts ?? []).map((a) => [a._id, a])),
      staffById: new Map((staff ?? []).map((s) => [s._id, s])),
      clientById: new Map((clients ?? []).map((c) => [c._id, c])),
    });
  }

  /**
   * Session Insights for the caller's scope. Dates are the organization's
   * business dates: `from`/`to` (inclusive 'YYYY-MM-DD') become org-midnight
   * instants, and every session is bucketed on the org calendar.
   */
  async oversightInsights({ tenantId, dataScope, from = null, to = null, clientId, staffProfileId, status, now = new Date() }) {
    if (!this.deps.repository.oversightInsights) return null;
    const org = await Promise.resolve(this.deps.organizations?.getById?.(tenantId)).catch(() => null);
    const timeZone = org?.timezone || 'UTC';
    const range = (from || to) ? businessDayRange(from ?? to, to ?? from, timeZone) : null;
    const records = await this.deps.repository.oversightInsights(tenantId, dataScope, {
      from: from && range ? range.startAt : null,
      to: to && range ? range.endAt : null,
      ...(clientId ? { clientId } : {}),
      ...(staffProfileId ? { staffProfileId } : {}),
      ...(status ? { status } : {}),
    });
    const todayKey = civilDateString(now, timeZone);
    return {
      timeZone,
      ...aggregateOversightInsights({ ...records, timeZone, fromKey: from ?? null, toKey: to ?? (from ? todayKey : null), todayKey }),
    };
  }

  async listSessions({ tenantId, limit, cursor, clientId, staffProfileId, appointmentId, status, dataScope }) {
    const page = await this.deps.repository.listSessions(tenantId, {
      ...(dataScope !== undefined ? { dataScope } : {}),
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(clientId !== undefined ? { clientId } : {}),
      ...(staffProfileId !== undefined ? { staffProfileId } : {}),
      ...(appointmentId !== undefined ? { appointmentId } : {}),
      ...(status !== undefined ? { status } : {}),
    });
    // Enrich each row with resolved display names (never ids), so the review
    // queue shows real children/clinicians without depending on a capped
    // client list in the browser. Additive, guarded, and cached per page.
    const items = await this._decorateWithNames(tenantId, page.items ?? []);
    return { ...page, items };
  }

  /**
   * Add childName/clinicianName + authoritative workedMinutes (and the scheduled
   * window/role from the session's own appointment) to session rows.
   *
   * PERFORMANCE. This used to await, row by row, the appointment, the time
   * record and the names — ~57 sequential database round trips for a 25-row
   * page, which is what made the Sessions page take seconds on a remote
   * database. Every related record is now resolved up front with ONE batched
   * `$in` read per collection (appointments, time records, client names, staff
   * names), all issued in parallel. When a port has no batched method (narrow
   * test harnesses) the unique ids are looked up in parallel instead. The output
   * shape is unchanged.
   */
  async _decorateWithNames(tenantId, rows) {
    const hasName = this.deps.clients?.findById || this.deps.staff?.findById;
    const hasTime = Boolean(this.deps.timeRecords?.findBySession || this.deps.timeRecords?.findBySessions);
    if (!rows.length || (!hasName && !hasTime)) return rows;
    const uniq = (values) => [...new Set(values.filter(Boolean))];
    const safe = (p, fallback) => Promise.resolve(p).catch(() => fallback);
    const byIdMap = (list, key = 'id') => new Map((list ?? []).filter(Boolean).map((x) => [x[key], x]));
    /** Batched read when available, otherwise parallel single reads. */
    const many = async (batched, single, ids, key = 'id') => {
      if (!ids.length) return new Map();
      if (batched) return byIdMap(await safe(batched(tenantId, ids), []), key);
      if (!single) return new Map();
      const found = await Promise.all(ids.map((id) => safe(single(tenantId, id), null)));
      return new Map(ids.map((id, i) => [id, found[i]]).filter(([, v]) => v));
    };
    const personName = (p) => (p ? ([p.firstName, p.lastName].filter((x) => x != null && String(x).trim() !== '').join(' ').trim() || null) : null);
    const clientDisplay = (c) => (c ? ((c.preferredName && String(c.preferredName).trim()) || personName(c)) : null);

    const [appts, timeRecs, clients, staff] = await Promise.all([
      many(this.deps.appointments?.findManyByIds, this.deps.appointments?.findById, uniq(rows.map((r) => r.appointmentId))),
      many(this.deps.timeRecords?.findBySessions, this.deps.timeRecords?.findBySession, uniq(rows.map((r) => r.id)), this.deps.timeRecords?.findBySessions ? 'sessionId' : 'id'),
      many(this.deps.clients?.findNamesByIds, this.deps.clients?.findById, uniq(rows.map((r) => r.clientId))),
      many(this.deps.staff?.findNamesByIds, this.deps.staff?.findById, uniq(rows.map((r) => r.staffProfileId))),
    ]);

    return rows.map((r) => {
      const appt = r.appointmentId ? appts.get(r.appointmentId) ?? null : null;
      // Clinician ROLE from the persisted appointment assignment (never inferred).
      let role = null;
      if (appt && r.staffProfileId) role = r.staffProfileId === appt.bcbaId ? 'BCBA' : r.staffProfileId === appt.rbtId ? 'RBT' : null;
      // Actual clock-in/out and worked minutes: this session's own SessionTimeRecord.
      const tr = timeRecs.get(r.id) ?? null;
      return {
        ...r,
        childName: clientDisplay(clients.get(r.clientId)),
        clinicianName: personName(staff.get(r.staffProfileId)),
        workedMinutes: tr?.workedMinutes ?? null,
        actualStart: tr?.startedAt ?? null,
        actualEnd: tr?.endedAt ?? null,
        role,
        // Scheduled window from THIS session's own appointment; date-only
        // appointments carry timeSet:false so no clock time is fabricated.
        scheduledStart: appt?.startAt ?? null,
        scheduledEnd: appt?.endAt ?? null,
        scheduledTimeSet: appt ? (appt.timeSet ?? true) : true,
        documentation: {
          what: r.documentation?.what != null ? this.deps.phi.open(r.documentation.what) : null,
          how: r.documentation?.how != null ? this.deps.phi.open(r.documentation.how) : null,
          childResponse: r.documentation?.childResponse != null ? this.deps.phi.open(r.documentation.childResponse) : null,
        },
      };
    });
  }

  async updateSession({ tenantId, sessionId, actorUserId, expectedVersion, input }) {
    await this._assertActive(tenantId);
    await this._requireMutableSession(tenantId, sessionId);
    assertPatchStatus(input.status);
    const patch = { updatedBy: actorUserId };
    if (input.status !== undefined) patch.status = input.status;
    if (input.startedAt !== undefined) patch.startedAt = new Date(input.startedAt);
    if (input.endedAt !== undefined) patch.endedAt = new Date(input.endedAt);
    if (input.narrative !== undefined) patch['sensitive.narrative'] = this.deps.phi.seal(input.narrative);
    const updated = await this.deps.repository.updateSession(tenantId, sessionId, patch, expectedVersion);
    return this._present(updated);
  }

  /**
   * Submit a session for review (§6.6, Figure 6.2 Captured ─▶ Submitted).
   *
   * WHY THIS ENDPOINT EXISTS. Submission previously happened through
   * `PATCH { status: 'SUBMITTED' }`, and `assertPatchStatus` permitted any
   * DRAFT↔SUBMITTED move with no further checks. That made the blueprint's
   * completeness gate — "Before submission: required data present, note fields
   * complete, times consistent, signatures captured" (§6.6) — enforceable only
   * by the UI's own `canSubmit` boolean. Any client that sent the PATCH
   * directly put an incomplete session into a BCBA's review queue, and from
   * there one approval away from billing.
   *
   * The completeness check now runs server-side and reports EVERY problem at
   * once, because §6.6 requires failures be "shown inline with what to fix" —
   * returning only the first means the technician submits, fixes, resubmits and
   * discovers the next one.
   */
  async submitSession({ tenantId, sessionId, actorUserId, actorStaffProfileId }) {
    await this._assertActive(tenantId);
    const session = await this.deps.repository.findSessionById(tenantId, sessionId);
    if (!session) throw sessionsError('SESSION_NOT_FOUND');

    // The state machine decides whether this move is legal at all; RETURNED
    // sessions resubmit through exactly this path after correction.
    assertTransition(session.status, 'SUBMITTED');

    const problems = submissionProblems(session);
    if (problems.length > 0) {
      throw sessionsError('SESSION_INCOMPLETE', {
        message: problems[0],
        details: { problems },
      });
    }

    const updated = await this.deps.repository.updateSession(
      tenantId,
      sessionId,
      { status: 'SUBMITTED', submittedAt: new Date(), submittedBy: actorUserId, updatedBy: actorUserId },
      session.version,
    );
    return this._present(updated);
  }

  /**
   * BCBA approval — "the hinge of the platform" (§9.4 step 6). At approval the
   * record freezes and becomes the fact billing and payroll independently
   * derive from.
   *
   * Two guards the previous implementation had no way to express:
   *   - only SUBMITTED may be approved (a DRAFT was previously freezable, so a
   *     session could reach billing without ever passing review);
   *   - separation of duties (BR-CN-2, §4.5): the delivering technician may
   *     never approve their own work, whatever else they hold.
   */
  async freezeSession({ tenantId, sessionId, actorUserId, actorStaffProfileId, separationOfDuties = true }) {
    await this._assertActive(tenantId);
    const session = await this.deps.repository.findSessionById(tenantId, sessionId);
    if (!session) throw sessionsError('SESSION_NOT_FOUND');
    assertTransition(session.status, 'FROZEN');
    assertMayApprove({
      deliveredByStaffId: session.staffProfileId,
      actorStaffId: actorStaffProfileId,
      separationOfDuties,
    });
    assertSignaturesIntact(session);
    const frozen = await this.deps.repository.freezeSession(tenantId, sessionId, actorUserId);
    return this._present(frozen);
  }

  /**
   * Return with a comment — §9.4 step 5, "Approve, or return with a comment
   * that reaches the technician immediately". The review queue previously had
   * only one of its two documented actions.
   */
  async returnSession({ tenantId, sessionId, actorUserId, comment }) {
    await this._assertActive(tenantId);
    const session = await this.deps.repository.findSessionById(tenantId, sessionId);
    if (!session) throw sessionsError('SESSION_NOT_FOUND');
    assertTransition(session.status, 'RETURNED');
    assertReason('RETURNED', comment);
    const updated = await this.deps.repository.updateSession(tenantId, sessionId, {
      status: 'RETURNED',
      returnedAt: new Date(),
      returnedBy: actorUserId,
      returnComment: comment,
      updatedBy: actorUserId,
    });
    return this._present(updated);
  }

  /**
   * Cancellation — §6.4. A structured reason from the taxonomy, never a soft
   * delete, "because each drives different billing, payroll and outcome
   * consequences".
   */
  async cancelSession({ tenantId, sessionId, actorUserId, reasonCode, note = null }) {
    await this._assertActive(tenantId);
    const session = await this.deps.repository.findSessionById(tenantId, sessionId);
    if (!session) throw sessionsError('SESSION_NOT_FOUND');
    assertTransition(session.status, 'CANCELLED');
    assertCancellationReason(reasonCode);
    const updated = await this.deps.repository.updateSession(tenantId, sessionId, {
      status: 'CANCELLED',
      cancelledAt: new Date(),
      cancelledBy: actorUserId,
      cancellationReason: reasonCode,
      cancellationNote: note,
      updatedBy: actorUserId,
    });
    return this._present(updated);
  }

  // --- clock in / clock out (§6.6, one action each) ------------------------

  /**
   * Clock in. Time and coarse location are captured AT THE EVENT and written
   * into the verification record — never derived later, which is the difference
   * between a verifiable visit and a reconstructed one (§8.4).
   */
  async clockIn({ tenantId, sessionId, actorUserId, actorStaffProfileId, location = null, serviceType = null, at = null }) {
    const org = await this._assertActive(tenantId);
    const session = await this.deps.repository.findSessionById(tenantId, sessionId);
    if (!session) throw sessionsError('SESSION_NOT_FOUND');

    // A technician records time against their OWN session only.
    if (actorStaffProfileId && session.staffProfileId !== actorStaffProfileId) {
      throw sessionsError('NOT_SESSION_OWNER');
    }
    if (session.clockInAt) throw sessionsError('ALREADY_CLOCKED_IN');
    assertTransition(session.status, 'IN_PROGRESS');
    await this._assertAppointmentStartableNow(tenantId, org, session.appointmentId);

    const now = at ? new Date(at) : new Date();
    if (Number.isNaN(now.getTime())) throw sessionsError('INVALID_CLOCK_TIME');

    const updated = await this.deps.repository.updateSession(tenantId, sessionId, {
      status: 'IN_PROGRESS',
      clockInAt: now,
      clockInBy: actorStaffProfileId ?? session.staffProfileId,
      'verification.serviceType': serviceType ?? session.serviceType ?? null,
      'verification.recipientClientId': session.clientId,
      'verification.providerStaffProfileId': session.staffProfileId,
      'verification.serviceDate': now,
      'verification.startTime': now,
      'verification.clockInLocation': coarsenLocation(location) ?? undefined,
      updatedBy: actorUserId,
    });
    return this._present(updated);
  }

  /** Clock out. Completes the verification record and fixes the duration. */
  async clockOut({ tenantId, sessionId, actorUserId, actorStaffProfileId, location = null, at = null }) {
    await this._assertActive(tenantId);
    const session = await this.deps.repository.findSessionById(tenantId, sessionId);
    if (!session) throw sessionsError('SESSION_NOT_FOUND');

    if (actorStaffProfileId && session.staffProfileId !== actorStaffProfileId) {
      throw sessionsError('NOT_SESSION_OWNER');
    }
    if (!session.clockInAt) throw sessionsError('NOT_CLOCKED_IN');
    if (session.clockOutAt) throw sessionsError('INVALID_CLOCK_TIME', { message: 'You have already clocked out of this session.' });

    const now = at ? new Date(at) : new Date();
    if (Number.isNaN(now.getTime())) throw sessionsError('INVALID_CLOCK_TIME');
    // A clock-out before the clock-in is not a rounding question; it is wrong.
    if (now <= new Date(session.clockInAt)) {
      throw sessionsError('INVALID_CLOCK_TIME', { message: 'The clock-out time has to be after the clock-in time.' });
    }

    const verification = {
      ...(session.verification ?? {}),
      startTime: session.clockInAt,
      endTime: now,
      clockOutLocation: coarsenLocation(location) ?? (session.verification?.clockOutLocation ?? null),
    };

    const updated = await this.deps.repository.updateSession(tenantId, sessionId, {
      clockOutAt: now,
      clockOutBy: actorStaffProfileId ?? session.staffProfileId,
      endedAt: now,
      'verification.endTime': now,
      'verification.clockOutLocation': coarsenLocation(location) ?? undefined,
      'verification.complete': isEvvComplete(verification),
      updatedBy: actorUserId,
    });
    return this._present(updated);
  }

  /** Which of the six EVV elements are still missing (§6.7 exception queue). */
  async verificationStatus({ tenantId, sessionId }) {
    const session = await this.deps.repository.findSessionById(tenantId, sessionId);
    if (!session) throw sessionsError('SESSION_NOT_FOUND');
    const missing = missingEvvElements(session.verification ?? {});
    return { sessionId, complete: missing.length === 0, missing };
  }

  // --- signatures (§6.6) ---------------------------------------------------

  /**
   * Capture a signature on the device at the point of service, bound
   * cryptographically to the session record.
   *
   * Refusal is a first-class outcome: "Guardian refuses to sign: refusal is
   * recorded with reason; the session proceeds to review flagged" (§9.4).
   */
  async captureSignature({ tenantId, sessionId, actorUserId, actorStaffProfileId, role, signerName = null, signerGuardianId = null, refused = false, refusalReason = null }) {
    await this._assertActive(tenantId);
    const session = await this.deps.repository.findSessionById(tenantId, sessionId);
    if (!session) throw sessionsError('SESSION_NOT_FOUND');
    assertMutable(session.status);
    assertMaySign({ role, actorStaffProfileId, deliveredByStaffId: session.staffProfileId });
    assertSignatureAbsent(session, role);
    if (refused && !refusalReason) {
      throw sessionsError('REASON_REQUIRED', { message: 'Please record why the signature was refused.' });
    }

    const signature = {
      role,
      signerName,
      signerUserId: role === 'TECHNICIAN' ? actorUserId : null,
      signerGuardianId: role === 'GUARDIAN' ? signerGuardianId : null,
      signedAt: new Date(),
      refused,
      refusalReason: refused ? refusalReason : null,
    };
    signature.bindingHash = computeBindingHash(session, signature);

    const updated = await this.deps.repository.appendSignature(tenantId, sessionId, signature, actorUserId);
    return this._present(updated);
  }

  // --- amendments (§6.6) ---------------------------------------------------

  /**
   * Post-approval correction. "The original is never overwritten": the approved
   * row moves to AMENDED and a NEW session row carries the corrected values,
   * attributed with what changed, by whom, when and why.
   *
   * This is why editing a FROZEN session is refused rather than merely
   * discouraged — billing and payroll have already derived figures from it, and
   * §6.6 requires the correction to re-derive them explicitly.
   */
  async amendSession({ tenantId, sessionId, actorUserId, reason, changes = {} }) {
    await this._assertActive(tenantId);
    const original = await this.deps.repository.findSessionById(tenantId, sessionId);
    if (!original) throw sessionsError('SESSION_NOT_FOUND');
    if (original.status !== 'FROZEN') throw sessionsError('AMENDMENT_INVALID');
    assertReason('AMENDED', reason);

    const amendment = await this.deps.repository.createAmendment(tenantId, {
      original,
      changes,
      reason,
      actorUserId,
    });
    return this._present(amendment);
  }

  // --- data points ---------------------------------------------------------

  async addDataPoint({ tenantId, sessionId, actorUserId, input }) {
    await this._assertActive(tenantId);
    const session = await this._requireMutableSession(tenantId, sessionId);
    const target = await this._requireTargetInPlan(tenantId, session.treatmentPlanId, input.targetId);
    const measurement = validateMeasurement(input.measurementType, input);
    return this.deps.repository.addDataPoint(tenantId, sessionId, {
      targetId: target.id,
      programId: target.programId ?? null,
      treatmentPlanId: session.treatmentPlanId,
      measurementType: input.measurementType,
      ...measurement,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });
  }

  async updateDataPoint({ tenantId, sessionId, dataPointId, actorUserId, expectedVersion, input }) {
    await this._assertActive(tenantId);
    await this._requireMutableSession(tenantId, sessionId);
    const existing = await this.deps.repository.findDataPoint(tenantId, sessionId, dataPointId);
    if (!existing) throw sessionsError('DATA_POINT_NOT_FOUND');
    const measurementType = input.measurementType ?? existing.measurementType;
    const measurement = validateMeasurement(measurementType, {
      value: input.value ?? existing.value,
      numerator: input.numerator ?? existing.numerator,
      denominator: input.denominator ?? existing.denominator,
    });
    const patch = { measurementType, ...measurement, updatedBy: actorUserId };
    return this.deps.repository.updateDataPoint(tenantId, sessionId, dataPointId, patch, expectedVersion);
  }

  async removeDataPoint({ tenantId, sessionId, dataPointId, actorUserId }) {
    await this._assertActive(tenantId);
    await this._requireMutableSession(tenantId, sessionId);
    return this.deps.repository.removeDataPoint(tenantId, sessionId, dataPointId, actorUserId);
  }

  // --- internals -----------------------------------------------------------

  async _requireTargetInPlan(tenantId, treatmentPlanId, targetId) {
    const target = await this.deps.plans.findTargetById(tenantId, targetId);
    if (!target || target.treatmentPlanId !== treatmentPlanId || target.status !== 'ACTIVE' || target.archivedAt) {
      throw sessionsError('TARGET_INVALID');
    }
    return target;
  }

  /**
   * Open the sealed narrative for an authorised detail response, and attach the
   * worked minutes of each WORK PERIOD.
   *
   * One logical session may have been started and stopped several times during
   * the same day (onboarding §10/§30). The periods themselves are persisted on
   * the session; the per-period duration is derived HERE rather than in the
   * browser so Session Detail, reports and exports all quote the same number
   * from the same arithmetic. A running period has no duration yet (null), and
   * a session recorded before work periods existed simply has none.
   */
  _present(session) {
    const narrative = session.sensitive ? this.deps.phi.open(session.sensitive.narrative) : null;
    const { sensitive, ...rest } = session;
    const intervals = (session.intervals ?? [])
      .filter((iv) => iv && iv.startedAt)
      .map((iv) => {
        const ms = iv.endedAt ? new Date(iv.endedAt).getTime() - new Date(iv.startedAt).getTime() : null;
        return {
          startedAt: iv.startedAt,
          endedAt: iv.endedAt ?? null,
          workedMinutes: Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60000) : null,
        };
      });
    return { ...rest, intervals, narrative: narrative ?? null };
  }
}

/** Whole years from a date of birth, or null. Used for the session-detail child. */
function ageFromDob(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
  return age >= 0 && age < 200 ? age : null;
}
