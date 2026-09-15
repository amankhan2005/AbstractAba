import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupervisionService } from '../src/modules/supervision/supervision.service.js';

// DI fakes — the service is dependency-injected, so this runs without a database.
function makeDeps(overrides = {}) {
  const observations = new Map();
  const hourLogs = [];
  let seq = 0;
  const repository = {
    _observations: observations, _hourLogs: hourLogs,
    async staffExists() { return true; },
    async findActiveLink() { return { id: 'link-1' }; },
    async createObservation(_t, doc) { const id = `obs-${++seq}`; const row = { id, ...doc }; observations.set(id, row); return { ...row }; },
    async findObservationById(_t, id) { const r = observations.get(id); return r ? { ...r } : null; },
    async listObservations(_t) { return [...observations.values()]; },
    async updateDraftObservation(_t, id, patch) { const r = observations.get(id); if (!r || r.status !== 'DRAFT') return null; Object.assign(r, patch); return { ...r }; },
    async transitionObservation(_t, id, fromStatus, patch) { const r = observations.get(id); if (!r || r.status !== fromStatus) return null; Object.assign(r, patch); return { ...r }; },
    async linkSupersession(_t, oldId, newId) { const r = observations.get(oldId); if (r) { r.status = 'SUPERSEDED'; r.supersededByObservationId = newId; } },
    async createHourLog(_t, doc) {
      if (doc.observationId && hourLogs.some((h) => h.observationId === doc.observationId)) { const e = new Error('dup'); e.code = 11000; throw e; }
      const id = `hl-${++seq}`; const row = { id, ...doc }; hourLogs.push(row); return { ...row };
    },
    async listHourLogs(_t, f = {}) {
      return hourLogs.filter((h) => (!f.superviseeStaffId || h.superviseeStaffId === f.superviseeStaffId));
    },
  };
  return {
    repository,
    organizations: { getById: async () => ({ state: 'ACTIVE' }) },
    ...overrides,
  };
}

const baseInput = { supervisorStaffId: 's-sup', superviseeStaffId: 's-sue', observedAt: '2026-02-01T10:00:00.000Z', durationMinutes: 60, method: 'IN_PERSON', summary: 'Good session' };
const svc = (deps) => new SupervisionService(deps);

test('happy path: create observation as DRAFT with server-set attribution', async () => {
  const deps = makeDeps();
  const obs = await svc(deps).createObservation({ tenantId: 't1', actorUserId: 'u1', input: baseInput });
  assert.equal(obs.status, 'DRAFT');
  assert.equal(obs.createdBy, 'u1');
  assert.equal(obs.supervisionLinkId, 'link-1');
  assert.equal(obs.durationMinutes, 60);
});

test('create rejects self-supervision and invalid duration', async () => {
  const deps = makeDeps();
  await assert.rejects(() => svc(deps).createObservation({ tenantId: 't1', actorUserId: 'u1', input: { ...baseInput, superviseeStaffId: 's-sup' } }), /themselves/);
  await assert.rejects(() => svc(deps).createObservation({ tenantId: 't1', actorUserId: 'u1', input: { ...baseInput, durationMinutes: 0 } }), /positive/);
});

test('edit allowed while DRAFT, blocked once SUBMITTED/SIGNED', async () => {
  const deps = makeDeps();
  const s = svc(deps);
  const obs = await s.createObservation({ tenantId: 't1', actorUserId: 'u1', input: baseInput });
  const edited = await s.updateObservation({ tenantId: 't1', observationId: obs.id, actorUserId: 'u1', input: { summary: 'Revised' } });
  assert.equal(edited.summary, 'Revised');
  await s.submitObservation({ tenantId: 't1', observationId: obs.id, actorUserId: 'u1' });
  await assert.rejects(() => s.updateObservation({ tenantId: 't1', observationId: obs.id, actorUserId: 'u1', input: { summary: 'no' } }), /DRAFT/);
});

test('valid workflow: DRAFT → SUBMITTED → SIGNED', async () => {
  const deps = makeDeps();
  const s = svc(deps);
  const obs = await s.createObservation({ tenantId: 't1', actorUserId: 'u1', input: baseInput });
  await s.submitObservation({ tenantId: 't1', observationId: obs.id, actorUserId: 'u1' });
  const signed = await s.signObservation({ tenantId: 't1', observationId: obs.id, actorUserId: 'bcba-9' });
  assert.equal(signed.status, 'SIGNED');
});

test('invalid workflow: cannot sign a DRAFT directly', async () => {
  const deps = makeDeps();
  const s = svc(deps);
  const obs = await s.createObservation({ tenantId: 't1', actorUserId: 'u1', input: baseInput });
  await assert.rejects(() => s.signObservation({ tenantId: 't1', observationId: obs.id, actorUserId: 'u1' }), /Illegal/);
});

test('sign-off is server-authoritative (signedBy = actor, signedAt set by server)', async () => {
  const deps = makeDeps();
  const s = svc(deps);
  const obs = await s.createObservation({ tenantId: 't1', actorUserId: 'u1', input: baseInput });
  await s.submitObservation({ tenantId: 't1', observationId: obs.id, actorUserId: 'u1' });
  const signed = await s.signObservation({ tenantId: 't1', observationId: obs.id, actorUserId: 'bcba-9' });
  assert.equal(signed.signedBy, 'bcba-9');
  assert.ok(signed.signedAt instanceof Date);
});

test('signing posts supervision hours exactly once (idempotent)', async () => {
  const deps = makeDeps();
  const s = svc(deps);
  const obs = await s.createObservation({ tenantId: 't1', actorUserId: 'u1', input: baseInput });
  await s.submitObservation({ tenantId: 't1', observationId: obs.id, actorUserId: 'u1' });
  await s.signObservation({ tenantId: 't1', observationId: obs.id, actorUserId: 'bcba-9' });
  assert.equal(deps.repository._hourLogs.filter((h) => h.observationId === obs.id).length, 1);
  assert.equal(deps.repository._hourLogs[0].minutes, 60);
});

test('finalized (SIGNED) immutability: edit refused, only supersede allowed', async () => {
  const deps = makeDeps();
  const s = svc(deps);
  const obs = await s.createObservation({ tenantId: 't1', actorUserId: 'u1', input: baseInput });
  await s.submitObservation({ tenantId: 't1', observationId: obs.id, actorUserId: 'u1' });
  await s.signObservation({ tenantId: 't1', observationId: obs.id, actorUserId: 'bcba-9' });
  await assert.rejects(() => s.updateObservation({ tenantId: 't1', observationId: obs.id, actorUserId: 'u1', input: { summary: 'x' } }), /DRAFT/);
  const draft = await s.supersedeObservation({ tenantId: 't1', observationId: obs.id, actorUserId: 'bcba-9', input: { summary: 'corrected' } });
  assert.equal(draft.status, 'DRAFT');
  assert.equal(draft.supersedesObservationId, obs.id);
  assert.equal(deps.repository._observations.get(obs.id).status, 'SUPERSEDED');
});

test('cannot supersede a non-SIGNED observation', async () => {
  const deps = makeDeps();
  const s = svc(deps);
  const obs = await s.createObservation({ tenantId: 't1', actorUserId: 'u1', input: baseInput });
  await assert.rejects(() => s.supersedeObservation({ tenantId: 't1', observationId: obs.id, actorUserId: 'bcba-9', input: {} }), /SIGNED/);
});

test('recordHours validates duration and computes totals/summary', async () => {
  const deps = makeDeps();
  const s = svc(deps);
  await s.recordHours({ tenantId: 't1', actorUserId: 'u1', input: { supervisorStaffId: 's-sup', superviseeStaffId: 's-sue', date: '2026-02-01', minutes: 90 } });
  await s.recordHours({ tenantId: 't1', actorUserId: 'u1', input: { supervisorStaffId: 's-sup', superviseeStaffId: 's-sue', date: '2026-02-02', minutes: 30 } });
  await assert.rejects(() => s.recordHours({ tenantId: 't1', actorUserId: 'u1', input: { supervisorStaffId: 's-sup', superviseeStaffId: 's-sue', date: '2026-02-03', minutes: -1 } }), /positive/);
  const summary = await s.hoursSummary({ tenantId: 't1', filters: { superviseeStaffId: 's-sue' } });
  assert.equal(summary.totalMinutes, 120);
  assert.equal(summary.totalHours, 2);
  assert.equal(summary.bySupervisee[0].superviseeStaffId, 's-sue');
});

test('org not ACTIVE blocks all writes', async () => {
  const deps = makeDeps({ organizations: { getById: async () => ({ state: 'SUSPENDED' }) } });
  await assert.rejects(() => svc(deps).createObservation({ tenantId: 't1', actorUserId: 'u1', input: baseInput }), /not active/);
});

test('not found is a 404 for unknown observation', async () => {
  const deps = makeDeps();
  await assert.rejects(() => svc(deps).getObservation({ tenantId: 't1', observationId: 'nope' }), /not found/i);
});
