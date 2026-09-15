import { AppError } from '../../common/errors/AppError.js';
import { assertObservationTransition } from './supervision.state.js';
import { assertValidMinutes, sumMinutes, minutesToHours, summariseBySupervisee } from './supervision.hours.js';
import { recordSafely } from '../audit/audit.service.js';

/**
 * Supervision workflow business rules. The organization ACTIVE gate and staff
 * existence are validated through injected ports (no cross-module reach-in).
 *
 * Server-authoritative invariants:
 *   - tenantId always comes from the authenticated principal, never the client.
 *   - actorUserId (createdBy/updatedBy) and signer identity (signedBy/signedAt)
 *     are set from the principal here — client-supplied values are ignored.
 *   - Only DRAFT observations are editable; SIGNED/SUPERSEDED are immutable.
 *   - Signing an observation posts its hours exactly once (idempotent via the
 *     unique (tenant, observationId) index), keeping hour tracking reliable.
 *   - Every workflow transition emits an audit event.
 */
export class SupervisionService {
  constructor(deps) {
    this.deps = deps;
  }

  async _assertActive(tenantId) {
    const org = await this.deps.organizations.getById(tenantId);
    if (!org || org.state !== 'ACTIVE') throw AppError.conflict('SUPERVISION-409', 'Organization is not active.');
  }

  async _assertStaff(tenantId, staffId, label) {
    const ok = await this.deps.repository.staffExists(tenantId, staffId);
    if (!ok) throw AppError.validation(`Unknown ${label}.`);
  }

  // --- observations --------------------------------------------------------

  async createObservation({ tenantId, actorUserId, input }) {
    await this._assertActive(tenantId);
    await this._assertStaff(tenantId, input.supervisorStaffId, 'supervisor');
    await this._assertStaff(tenantId, input.superviseeStaffId, 'supervisee');
    if (input.supervisorStaffId === input.superviseeStaffId) {
      throw AppError.validation('A supervisor cannot supervise themselves.');
    }
    assertValidMinutes(input.durationMinutes);
    const link = await this.deps.repository.findActiveLink(tenantId, input.supervisorStaffId, input.superviseeStaffId);

    const doc = {
      supervisorStaffId: input.supervisorStaffId,
      superviseeStaffId: input.superviseeStaffId,
      supervisionLinkId: link?.id ?? null,
      clientId: input.clientId ?? null,
      sessionId: input.sessionId ?? null,
      observedAt: new Date(input.observedAt),
      durationMinutes: input.durationMinutes,
      method: input.method ?? 'IN_PERSON',
      summary: input.summary ?? '',
      findings: input.findings ?? '',
      status: 'DRAFT',
      createdBy: actorUserId,
      updatedBy: actorUserId,
      ...(input.supersedesObservationId ? { supersedesObservationId: input.supersedesObservationId } : {}),
    };
    const created = await this.deps.repository.createObservation(tenantId, doc);
    recordSafely({
      tenantId, actorId: actorUserId, action: 'supervision.observation_created',
      entityType: 'supervision_observation', entityId: created.id, outcome: 'success',
      payload: { superviseeStaffId: created.superviseeStaffId, durationMinutes: created.durationMinutes },
    });
    return created;
  }

  async getObservation({ tenantId, observationId }) {
    const obs = await this.deps.repository.findObservationById(tenantId, observationId);
    if (!obs) throw AppError.notFound('SUPERVISION-404', 'Observation not found.');
    return obs;
  }

  async listObservations({ tenantId, filters }) {
    return this.deps.repository.listObservations(tenantId, filters);
  }

  async updateObservation({ tenantId, observationId, actorUserId, input }) {
    await this._assertActive(tenantId);
    const obs = await this.deps.repository.findObservationById(tenantId, observationId);
    if (!obs) throw AppError.notFound('SUPERVISION-404', 'Observation not found.');
    if (obs.status !== 'DRAFT') throw AppError.conflict('SUPERVISION-409', 'Only a DRAFT observation can be edited.');
    if (input.durationMinutes !== undefined) assertValidMinutes(input.durationMinutes);

    const patch = { updatedBy: actorUserId };
    for (const k of ['clientId', 'sessionId', 'method', 'summary', 'findings']) {
      if (input[k] !== undefined) patch[k] = input[k];
    }
    if (input.observedAt !== undefined) patch.observedAt = new Date(input.observedAt);
    if (input.durationMinutes !== undefined) patch.durationMinutes = input.durationMinutes;

    const updated = await this.deps.repository.updateDraftObservation(tenantId, observationId, patch);
    if (!updated) throw AppError.conflict('SUPERVISION-409', 'Only a DRAFT observation can be edited.');
    return updated;
  }

  async submitObservation({ tenantId, observationId, actorUserId }) {
    return this._transition({ tenantId, observationId, actorUserId, target: 'SUBMITTED' });
  }

  async reopenObservation({ tenantId, observationId, actorUserId }) {
    return this._transition({ tenantId, observationId, actorUserId, target: 'DRAFT' });
  }

  /**
   * Sign off an observation. Signer identity + timestamp are server-authoritative
   * (taken from actorUserId / server clock). On success, the observation's hours
   * are posted to the hour log exactly once (idempotent).
   */
  async signObservation({ tenantId, observationId, actorUserId }) {
    const signedAt = new Date();
    const obs = await this._transition({
      tenantId, observationId, actorUserId, target: 'SIGNED',
      extraPatch: { signedBy: actorUserId, signedAt },
    });
    // Post hours idempotently — the unique (tenant, observationId) index makes a
    // repeated sign (shouldn't happen: SIGNED is terminal) a no-op if it ever did.
    try {
      await this.deps.repository.createHourLog(tenantId, {
        supervisorStaffId: obs.supervisorStaffId,
        superviseeStaffId: obs.superviseeStaffId,
        observationId: obs.id,
        date: obs.observedAt,
        minutes: obs.durationMinutes,
        note: 'Auto-posted from signed observation',
        createdBy: actorUserId,
        updatedBy: actorUserId,
      });
    } catch (err) {
      if (err?.code !== 11000) throw err; // ignore duplicate (already posted)
    }
    recordSafely({
      tenantId, actorId: actorUserId, action: 'supervision.hours_posted',
      entityType: 'supervision_hour_log', entityId: obs.id, outcome: 'success',
      payload: { superviseeStaffId: obs.superviseeStaffId, minutes: obs.durationMinutes },
    });
    return obs;
  }

  /**
   * Correct a SIGNED observation by superseding it: files a new DRAFT linked to
   * the original and marks the original SUPERSEDED. Immutability is preserved —
   * the signed record is never edited in place.
   */
  async supersedeObservation({ tenantId, observationId, actorUserId, input }) {
    await this._assertActive(tenantId);
    const source = await this.deps.repository.findObservationById(tenantId, observationId);
    if (!source) throw AppError.notFound('SUPERVISION-404', 'Observation not found.');
    if (source.status !== 'SIGNED') throw AppError.conflict('SUPERVISION-409', 'Only a SIGNED observation can be superseded.');
    if (source.supersededByObservationId) throw AppError.conflict('SUPERVISION-409', 'Observation already superseded.');

    const draft = await this.createObservation({
      tenantId, actorUserId,
      input: {
        supervisorStaffId: source.supervisorStaffId,
        superviseeStaffId: source.superviseeStaffId,
        clientId: input?.clientId ?? source.clientId,
        sessionId: input?.sessionId ?? source.sessionId,
        observedAt: input?.observedAt ?? source.observedAt,
        durationMinutes: input?.durationMinutes ?? source.durationMinutes,
        method: input?.method ?? source.method,
        summary: input?.summary ?? source.summary,
        findings: input?.findings ?? source.findings,
        supersedesObservationId: source.id,
      },
    });
    await this.deps.repository.linkSupersession(tenantId, source.id, draft.id);
    recordSafely({
      tenantId, actorId: actorUserId, action: 'supervision.observation_superseded',
      entityType: 'supervision_observation', entityId: source.id, outcome: 'success',
      payload: { replacedBy: draft.id },
    });
    return draft;
  }

  async _transition({ tenantId, observationId, actorUserId, target, extraPatch = {} }) {
    await this._assertActive(tenantId);
    const obs = await this.deps.repository.findObservationById(tenantId, observationId);
    if (!obs) throw AppError.notFound('SUPERVISION-404', 'Observation not found.');
    assertObservationTransition(obs.status, target);
    const patch = { status: target, updatedBy: actorUserId, ...extraPatch };
    if (target === 'SUBMITTED') patch.submittedAt = new Date();
    if (target === 'DRAFT') { patch.submittedAt = null; patch.signedAt = null; patch.signedBy = null; }
    const updated = await this.deps.repository.transitionObservation(tenantId, observationId, obs.status, patch);
    if (!updated) throw AppError.conflict('SUPERVISION-409', `Observation is no longer in ${obs.status}.`);
    recordSafely({
      tenantId, actorId: actorUserId, action: 'supervision.observation_transitioned',
      entityType: 'supervision_observation', entityId: observationId, outcome: 'success',
      payload: { from: obs.status, to: target },
    });
    return updated;
  }

  // --- hours ---------------------------------------------------------------

  async recordHours({ tenantId, actorUserId, input }) {
    await this._assertActive(tenantId);
    await this._assertStaff(tenantId, input.supervisorStaffId, 'supervisor');
    await this._assertStaff(tenantId, input.superviseeStaffId, 'supervisee');
    assertValidMinutes(input.minutes);
    const created = await this.deps.repository.createHourLog(tenantId, {
      supervisorStaffId: input.supervisorStaffId,
      superviseeStaffId: input.superviseeStaffId,
      observationId: null,
      date: new Date(input.date),
      minutes: input.minutes,
      note: input.note ?? '',
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });
    recordSafely({
      tenantId, actorId: actorUserId, action: 'supervision.hours_recorded',
      entityType: 'supervision_hour_log', entityId: created.id, outcome: 'success',
      payload: { superviseeStaffId: created.superviseeStaffId, minutes: created.minutes },
    });
    return created;
  }

  async hoursSummary({ tenantId, filters }) {
    const rows = await this.deps.repository.listHourLogs(tenantId, filters);
    const totalMinutes = sumMinutes(rows);
    return {
      totalMinutes,
      totalHours: minutesToHours(totalMinutes),
      bySupervisee: summariseBySupervisee(rows),
      entries: rows,
    };
  }
}
