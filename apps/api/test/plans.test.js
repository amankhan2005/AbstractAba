import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlansService } from '../src/modules/plans/plans.service.js';

/**
 * DB-free tests for the clinical planning service against a fake repository and
 * fake ports. They lock in the ACTIVE gate, the ACTIVE-client and BCBA
 * validation, the archived-plan immutability guard, version forwarding, and the
 * plan → goal → program → target orchestration.
 */

function makeService({ state = 'ACTIVE', planStatus = 'DRAFT', over = {} } = {}) {
  const calls = { updatePlan: [], updateGoal: [], addGoal: [], addTarget: [], createActivePlan: [], demoted: [], deletePlan: [] };
  const repo = {
    createPlan: async (_t, doc) => ({ id: 'p-1', ...doc, version: 1 }),
    // Mirrors the real repo's supersede: creating an ACTIVE plan demotes any
    // current ACTIVE plan for that child to DRAFT in the same unit of work.
    createActivePlan: async (_t, doc, actorUserId) => {
      const prior = (over.existingActives?.[doc.clientId]) ?? [];
      for (const id of prior) calls.demoted.push({ id, to: 'DRAFT' });
      calls.createActivePlan.push({ doc, actorUserId });
      return { id: 'p-1', ...doc, version: 1 };
    },
    findPlanById: async () => ({ id: 'p-1', clientId: 'c-1', title: 'Plan', responsibleBcbaStaffId: 's-1', status: planStatus, version: 2 }),
    listPlans: async () => ({ items: [{ id: 'p-1', status: planStatus }], nextCursor: null }),
    updatePlan: async (_t, id, patch, v) => { calls.updatePlan.push({ patch, v }); return { id, ...patch, version: (v ?? 1) + 1 }; },
    archivePlan: async (_t, id) => ({ planId: id, status: 'ARCHIVED' }),
    deletePlan: async (_t, id, actorUserId) => { calls.deletePlan.push({ id, actorUserId }); return { planId: id, deleted: true }; },
    listGoals: async () => [{ id: 'g-1', treatmentPlanId: 'p-1', description: 'Goal', status: 'IN_PROGRESS' }],
    addGoal: async (_t, planId, clientId, input) => { calls.addGoal.push({ planId, clientId, input }); return { id: 'g-1', treatmentPlanId: planId, clientId, ...input }; },
    updateGoal: async (_t, _p, gid, patch, v) => { calls.updateGoal.push({ gid, patch, v }); return { id: gid, ...patch, version: (v ?? 1) + 1 }; },
    archiveGoal: async (_t, _p, gid) => ({ goalId: gid, status: 'ARCHIVED' }),
    listPrograms: async () => [{ id: 'pr-1', goalId: 'g-1' }],
    findProgram: async (_t, _p, id) => ({ id, goalId: 'g-1', treatmentPlanId: 'p-1' }),
    addProgram: async (_t, planId, goalId, input) => ({ id: 'pr-1', goalId, treatmentPlanId: planId, ...input }),
    updateProgram: async (_t, _p, id, patch, v) => ({ id, ...patch, version: (v ?? 1) + 1 }),
    archiveProgram: async (_t, _p, id) => ({ programId: id }),
    listTargets: async () => [{ id: 't-1', programId: 'pr-1' }],
    addTarget: async (_t, planId, programId, input) => { calls.addTarget.push({ planId, programId, input }); return { id: 't-1', programId, treatmentPlanId: planId, ...input }; },
    updateTarget: async (_t, programId, id, patch, v) => ({ id, programId, ...patch, version: (v ?? 1) + 1 }),
    archiveTarget: async (_t, programId, id) => ({ id, programId, status: 'INACTIVE' }),
    ...over.repo,
  };
  const service = new PlansService({
    repository: repo,
    organizations: { getById: async () => ({ state }) },
    clients: { findById: async () => ({ id: 'c-1', status: 'ACTIVE' }), ...over.clients },
    staff: { findById: async () => ({ id: 's-1', status: 'ACTIVE' }), ...over.staff },
  });
  return { service, calls };
}

const planInput = { clientId: 'c-1', title: 'Plan A', responsibleBcbaStaffId: 's-1' };

// --- ACTIVE gate + creation validation -------------------------------------

test('create refused (409) when org not ACTIVE', async () => {
  const { service } = makeService({ state: 'SUSPENDED' });
  await assert.rejects(() => service.createPlan({ tenantId: 't', actorUserId: 'u', input: planInput }), (e) => e.code === 'ORG_NOT_ACTIVE');
});

test('create refused when client is not ACTIVE', async () => {
  const { service } = makeService({ over: { clients: { findById: async () => ({ id: 'c-1', status: 'INTAKE' }) } } });
  await assert.rejects(() => service.createPlan({ tenantId: 't', actorUserId: 'u', input: planInput }), (e) => e.code === 'CLIENT_NOT_ACTIVE' && e.status === 422);
});

test('create refused when responsible BCBA is not active staff', async () => {
  const { service } = makeService({ over: { staff: { findById: async () => ({ id: 's-1', status: 'INACTIVE' }) } } });
  await assert.rejects(() => service.createPlan({ tenantId: 't', actorUserId: 'u', input: planInput }), (e) => e.code === 'BCBA_INVALID' && e.status === 422);
});

test('successful create is ACTIVE immediately (auto-activate, spec Part 1 §2)', async () => {
  const { service } = makeService();
  const plan = await service.createPlan({ tenantId: 't', actorUserId: 'u', input: planInput });
  assert.equal(plan.status, 'ACTIVE');
  assert.equal(plan.clientId, 'c-1');
});

// --- archived-plan immutability --------------------------------------------

test('an ARCHIVED plan cannot be updated', async () => {
  const { service } = makeService({ planStatus: 'ARCHIVED' });
  await assert.rejects(() => service.updatePlan({ tenantId: 't', planId: 'p-1', actorUserId: 'u', expectedVersion: 2, input: { title: 'X' } }), (e) => e.code === 'PLAN_ARCHIVED' && e.status === 409);
});

test('goals/programs/targets cannot be added under an ARCHIVED plan', async () => {
  const { service } = makeService({ planStatus: 'ARCHIVED' });
  await assert.rejects(() => service.addGoal({ tenantId: 't', planId: 'p-1', actorUserId: 'u', input: { description: 'g' } }), (e) => e.code === 'PLAN_ARCHIVED');
  await assert.rejects(() => service.addProgram({ tenantId: 't', planId: 'p-1', goalId: 'g-1', actorUserId: 'u', input: { name: 'pr' } }), (e) => e.code === 'PLAN_ARCHIVED');
  await assert.rejects(() => service.addTarget({ tenantId: 't', planId: 'p-1', programId: 'pr-1', actorUserId: 'u', input: { label: 'tg' } }), (e) => e.code === 'PLAN_ARCHIVED');
});

// --- versioning (If-Match forwarding) --------------------------------------

test('updatePlan forwards the expected version', async () => {
  const { service, calls } = makeService();
  await service.updatePlan({ tenantId: 't', planId: 'p-1', actorUserId: 'u', expectedVersion: 2, input: { title: 'New' } });
  assert.equal(calls.updatePlan[0].v, 2);
  assert.equal(calls.updatePlan[0].patch.title, 'New');
});

test('updateGoal forwards the expected version', async () => {
  const { service, calls } = makeService();
  await service.updateGoal({ tenantId: 't', planId: 'p-1', goalId: 'g-1', actorUserId: 'u', expectedVersion: 4, input: { progress: 50 } });
  assert.equal(calls.updateGoal[0].v, 4);
});

// --- hierarchy orchestration -----------------------------------------------

test('addGoal denormalises the plan clientId', async () => {
  const { service, calls } = makeService();
  await service.addGoal({ tenantId: 't', planId: 'p-1', actorUserId: 'u', input: { description: 'g' } });
  assert.equal(calls.addGoal[0].clientId, 'c-1');
});

test('addTarget requires the program to belong to the plan', async () => {
  const { service } = makeService({ over: { repo: { findPlanById: async () => ({ id: 'p-1', clientId: 'c-1', status: 'ACTIVE', version: 1 }), findProgram: async () => null } } });
  await assert.rejects(() => service.addTarget({ tenantId: 't', planId: 'p-1', programId: 'missing', actorUserId: 'u', input: { label: 'x' } }), (e) => e.code === 'PROGRAM_NOT_FOUND');
});

test('getPlan assembles the full goal → program → target tree', async () => {
  const { service } = makeService();
  const detail = await service.getPlan({ tenantId: 't', planId: 'p-1' });
  assert.equal(detail.goals.length, 1);
  assert.equal(detail.goals[0].programs.length, 1);
  assert.equal(detail.goals[0].programs[0].targets.length, 1);
});

test('archivePlan delegates (cascade handled by repository)', async () => {
  const { service } = makeService();
  const result = await service.archivePlan({ tenantId: 't', planId: 'p-1', actorUserId: 'u' });
  assert.equal(result.status, 'ARCHIVED');
});

test('deletePlan delegates to the repository soft-delete and forwards the actor', async () => {
  const { service, calls } = makeService();
  const result = await service.deletePlan({ tenantId: 't', planId: 'p-1', actorUserId: 'u-9' });
  assert.deepEqual(result, { planId: 'p-1', deleted: true });
  assert.equal(calls.deletePlan.length, 1);
  assert.equal(calls.deletePlan[0].actorUserId, 'u-9');
});

test('deletePlan refuses (404) when the plan does not exist', async () => {
  const { service } = makeService({ over: { repo: { findPlanById: async () => null } } });
  await assert.rejects(
    () => service.deletePlan({ tenantId: 't', planId: 'missing', actorUserId: 'u' }),
    (e) => e.code === 'PLAN_NOT_FOUND',
  );
});

test('deletePlan is allowed on an ARCHIVED plan (terminal removal, not a mutation)', async () => {
  const { service, calls } = makeService({ planStatus: 'ARCHIVED' });
  const result = await service.deletePlan({ tenantId: 't', planId: 'p-1', actorUserId: 'u' });
  assert.equal(result.deleted, true);
  assert.equal(calls.deletePlan.length, 1);
});

test('getPlan resolves the real child and responsible-BCBA names onto the plan', async () => {
  const { service } = makeService({ over: {
    clients: { findById: async () => ({ id: 'c-1', firstName: 'Jamie', lastName: 'Rivera', status: 'ACTIVE' }) },
    staff: { findById: async () => ({ id: 's-1', firstName: 'Jane', lastName: 'Doe', status: 'ACTIVE' }) },
  } });
  const detail = await service.getPlan({ tenantId: 't', planId: 'p-1' });
  assert.equal(detail.plan.childName, 'Jamie Rivera');
  assert.equal(detail.plan.responsibleBcbaName, 'Jane Doe');
});

test('getPlan tolerates a missing/out-of-scope child or BCBA (null name, no throw)', async () => {
  const { service } = makeService({ over: {
    clients: { findById: async () => null },
    staff: { findById: async () => null },
  } });
  const detail = await service.getPlan({ tenantId: 't', planId: 'p-1' });
  assert.equal(detail.plan.childName, null);
  assert.equal(detail.plan.responsibleBcbaName, null);
  // the goal → program → target tree is still assembled
  assert.equal(detail.goals.length, 1);
});

// --- Module 7: Responsible BCBA derivation + activation lifecycle -------------

import { PlansController } from '../src/modules/plans/plans.controller.js';

test('Module 7.1: createPlan derives responsible BCBA from the authenticated creator when not supplied', async () => {
  const { service, repo } = makeService({ over: {
    staff: { findByUserId: async () => ({ id: 'bcba-me', status: 'ACTIVE' }), findById: async () => ({ id: 'bcba-me', status: 'ACTIVE' }) },
  } });
  const plan = await service.createPlan({ tenantId: 't', actorUserId: 'u-9', input: { clientId: 'c-1', title: 'Plan' } });
  assert.equal(plan.responsibleBcbaStaffId, 'bcba-me', 'server derived the responsible BCBA from the creator');
});

test('Module 7.1: an explicit responsible BCBA is still honored (admin creating on behalf)', async () => {
  const { service } = makeService({ over: {
    staff: { findByUserId: async () => ({ id: 'bcba-me', status: 'ACTIVE' }), findById: async () => ({ id: 's-1', status: 'ACTIVE' }) },
  } });
  const plan = await service.createPlan({ tenantId: 't', actorUserId: 'u', input: { clientId: 'c-1', title: 'Plan', responsibleBcbaStaffId: 's-1' } });
  assert.equal(plan.responsibleBcbaStaffId, 's-1');
});

test('Module 7.1: creator with no staff profile and no explicit BCBA is rejected', async () => {
  const { service } = makeService({ over: { staff: { findByUserId: async () => null, findById: async () => null } } });
  await assert.rejects(
    () => service.createPlan({ tenantId: 't', actorUserId: 'ghost', input: { clientId: 'c-1', title: 'Plan' } }),
    (e) => e.code === 'BCBA_INVALID',
  );
});

test('Part 1 §2: a new plan is ACTIVE even when the client sends status:DRAFT (no spoofing draft)', async () => {
  const { service, calls } = makeService({ over: { staff: { findByUserId: async () => ({ id: 'b', status: 'ACTIVE' }), findById: async () => ({ id: 'b', status: 'ACTIVE' }) } } });
  // Default create → ACTIVE.
  const dflt = await service.createPlan({ tenantId: 't', actorUserId: 'u', input: { clientId: 'c-1', title: 'P' } });
  assert.equal(dflt.status, 'ACTIVE');
  // Client attempts to force DRAFT → server ignores it, plan is still ACTIVE.
  const spoof = await service.createPlan({ tenantId: 't', actorUserId: 'u', input: { clientId: 'c-1', title: 'P', status: 'DRAFT' } });
  assert.equal(spoof.status, 'ACTIVE');
  // Both went through the auto-activating create path.
  assert.equal(calls.createActivePlan.length, 2);
  assert.equal(calls.createActivePlan[0].doc.status, 'ACTIVE');
});

test('Part 1 §4: creating a new active plan demotes the child\u2019s current ACTIVE plan (one active per child)', async () => {
  const { service, calls } = makeService({ over: {
    staff: { findByUserId: async () => ({ id: 'b', status: 'ACTIVE' }), findById: async () => ({ id: 'b', status: 'ACTIVE' }) },
    existingActives: { 'c-1': ['p-old'] },
  } });
  const plan = await service.createPlan({ tenantId: 't', actorUserId: 'u', input: { clientId: 'c-1', title: 'New' } });
  assert.equal(plan.status, 'ACTIVE');
  // The prior active plan was superseded (demoted to DRAFT), not left active.
  assert.deepEqual(calls.demoted, [{ id: 'p-old', to: 'DRAFT' }]);
});

test('Part 1 §3: a child with no current active plan supersedes nothing (historical drafts untouched)', async () => {
  const { service, calls } = makeService({ over: {
    staff: { findByUserId: async () => ({ id: 'b', status: 'ACTIVE' }), findById: async () => ({ id: 'b', status: 'ACTIVE' }) },
    existingActives: { 'c-1': [] },
  } });
  await service.createPlan({ tenantId: 't', actorUserId: 'u', input: { clientId: 'c-1', title: 'First' } });
  assert.equal(calls.demoted.length, 0, 'no existing active plan means nothing is demoted; historical DRAFTs are never touched');
});

test('Module 7.2: DRAFT → ACTIVE is a valid guarded transition', async () => {
  const { service } = makeService({ planStatus: 'DRAFT' });
  const out = await service.updatePlan({ tenantId: 't', planId: 'p-1', actorUserId: 'u', expectedVersion: 2, input: { status: 'ACTIVE' } });
  assert.equal(out.status, 'ACTIVE');
});

test('Module 7.2: an unsupported status jump is rejected (no faking ACTIVE around the state machine)', async () => {
  const { service } = makeService({ planStatus: 'DRAFT', over: {
    // schema normally blocks non-DRAFT/ACTIVE; the service guard is the backstop.
    repo: { findPlanById: async () => ({ id: 'p-1', clientId: 'c-1', status: 'DRAFT', version: 2 }) },
  } });
  await assert.rejects(
    () => service.updatePlan({ tenantId: 't', planId: 'p-1', actorUserId: 'u', expectedVersion: 2, input: { status: 'ARCHIVED' } }),
    (e) => e.code === 'PLAN_TRANSITION_INVALID',
  );
});

test('Module 7.3: an RBT (no plans.update/create) only ever lists ACTIVE plans', async () => {
  let received = null;
  const controller = new PlansController({ listPlans: async (args) => { received = args; return { items: [], nextCursor: null }; } });
  // principal.permissions is a Set at runtime (authenticate.js). Building it as
  // a Set here is what makes this a faithful regression: the previous Array
  // shape hid the `perms.includes is not a function` crash.
  const req = { principal: { activeTenantId: 't', permissions: new Set(['plans.read']) }, dataScope: { type: 'own' }, query: { limit: 25, status: 'DRAFT' } };
  const res = { };
  // sendPaginated writes to res; stub the minimum it needs.
  const sent = {};
  res.status = () => res; res.json = (b) => { sent.body = b; return res; }; res.set = () => res;
  await controller.listPlans(req, res);
  assert.equal(received.status, 'ACTIVE', 'RBT status is forced to ACTIVE even if the query asks for DRAFT');
});

test('Module 7.3: a plan author (plans.update) may list any status they ask for', async () => {
  let received = null;
  const controller = new PlansController({ listPlans: async (args) => { received = args; return { items: [], nextCursor: null }; } });
  const req = { principal: { activeTenantId: 't', permissions: new Set(['plans.read', 'plans.update']) }, dataScope: { type: 'own' }, query: { limit: 25, status: 'DRAFT' } };
  const res = {}; res.status = () => res; res.json = () => res; res.set = () => res;
  await controller.listPlans(req, res);
  assert.equal(received.status, 'DRAFT');
});

test('regression: listPlans consumes the principal permission Set via .has() and never throws perms.includes', async () => {
  // Reproduces the exact production crash: req.principal.permissions is a Set,
  // and the controller previously called Set.prototype.includes (undefined),
  // throwing "perms.includes is not a function" for every authorised caller.
  let received = null;
  const controller = new PlansController({ listPlans: async (args) => { received = args; return { items: [], nextCursor: null }; } });
  const res = {}; res.status = () => res; res.json = () => res; res.set = () => res;

  // Authoriser (plans.create) with a Set — must not throw, honours requested status.
  const authorReq = { principal: { activeTenantId: 't', permissions: new Set(['plans.read', 'plans.create']) }, dataScope: { type: 'own' }, query: { limit: 25, status: 'ARCHIVED' } };
  await assert.doesNotReject(() => controller.listPlans(authorReq, res));
  assert.equal(received.status, 'ARCHIVED', 'an authoriser sees the status they asked for');

  // Empty Set (authenticated but permission-less shape) must also not throw; RBT view forces ACTIVE.
  const emptyReq = { principal: { activeTenantId: 't', permissions: new Set() }, dataScope: { type: 'own' }, query: { limit: 25, status: 'DRAFT' } };
  await assert.doesNotReject(() => controller.listPlans(emptyReq, res));
  assert.equal(received.status, 'ACTIVE', 'a non-author is narrowed to ACTIVE, never DRAFT');
});
