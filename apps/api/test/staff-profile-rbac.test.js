import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StaffController } from '../src/modules/staff/staff.controller.js';
import { createStaffRouter } from '../src/modules/staff/staff.routes.js';
import { SYSTEM_ROLE_TEMPLATES } from '../src/modules/rbac/roleTemplates.js';

/**
 * GET /staff/:staffId — HTTP boundary. Scope and visibility come ONLY from the
 * authenticated principal (permissions + their scopes + the resolved dataScope).
 */

const grants = (role) => SYSTEM_ROLE_TEMPLATES[role];
const principalFor = (role) => ({
  userId: `u-${role}`, activeTenantId: 'tenant-A',
  permissions: new Set(grants(role).map((g) => g.key)),
  permissionScopes: new Map(grants(role).map((g) => [g.key, g.scope])),
});

async function get({ principal, dataScope, staffId = 's-1', query = {} }) {
  const calls = [];
  const controller = new StaffController({ getStaff: async (args) => { calls.push(args); return { staff: { id: args.staffId } }; } });
  const res = { status() { return this; }, json() { return this; } };
  let error = null;
  try { await controller.get({ principal, dataScope, params: { staffId }, query, body: {} }, res); } catch (e) { error = e; }
  return { calls, error };
}

test('Company Admin: org scope, pay + caseload visible, tenant from the principal (query tenantId ignored)', async () => {
  const dataScope = { scope: 'ORGANIZATION', staffIds: null, clientIds: null };
  const { calls } = await get({ principal: principalFor('org_admin'), dataScope, query: { tenantId: 'tenant-B' } });
  assert.deepEqual(calls, [{ tenantId: 'tenant-A', staffId: 's-1', dataScope, viewer: { canViewPay: true, canViewCaseload: true } }]);
});

test('BCBA (TEAM) and RBT (SELF): the narrowing dataScope is forwarded; no pay, no caseload', async () => {
  for (const role of ['bcba', 'rbt']) {
    const dataScope = { scope: role === 'bcba' ? 'TEAM' : 'SELF', staffIds: ['s-own'], clientIds: [] };
    const { calls } = await get({ principal: principalFor(role), dataScope });
    assert.deepEqual(calls[0].dataScope, dataScope, role);
    assert.deepEqual(calls[0].viewer, { canViewPay: false, canViewCaseload: false }, role);
  }
});

test('org-scope roles without payroll/staff management (scheduler, receptionist) do not see pay', async () => {
  for (const role of ['scheduler', 'receptionist']) {
    const { calls } = await get({ principal: principalFor(role), dataScope: { scope: 'ORGANIZATION', staffIds: null, clientIds: null } });
    assert.equal(calls[0].viewer.canViewPay, false, role);
  }
});

test('no principal → 401 before any read', async () => {
  const { calls, error } = await get({ principal: null, dataScope: null });
  assert.equal(error?.status, 401);
  assert.equal(calls.length, 0);
});

test('routes keep their guards: GET staff.read, PATCH staff.manage with validation', () => {
  const router = createStaffRouter({});
  const layer = (path, method) => router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  const getLayer = layer('/:staffId', 'get');
  const patchLayer = layer('/:staffId', 'patch');
  assert.ok(getLayer && patchLayer);
  assert.ok(getLayer.route.stack.length >= 3, 'permission + params validation + handler');
  assert.ok(patchLayer.route.stack.length >= 4, 'permission + params + body validation + handler');
  assert.ok(!grants('rbt').some((g) => g.key === 'staff.manage'));
  assert.ok(!grants('bcba').some((g) => g.key === 'staff.manage'));
});
