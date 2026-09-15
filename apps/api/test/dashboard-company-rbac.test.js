import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DashboardsController } from '../src/modules/dashboards/dashboards.controller.js';
import { SYSTEM_ROLE_TEMPLATES } from '../src/modules/rbac/roleTemplates.js';

/**
 * GET /dashboards/company — HTTP boundary. Tenant, scope and permissions come
 * ONLY from the authenticated principal; nothing in the request can widen the
 * data. Company-wide data needs dashboards.read at ORGANIZATION scope.
 */

const grant = (role, key) => SYSTEM_ROLE_TEMPLATES[role].find((g) => g.key === key)?.scope ?? null;

function call({ principal, dataScope, query = {}, body = {} }) {
  const calls = [];
  const controller = new DashboardsController({ companyDashboard: async (args) => { calls.push(args); return { scope: 'company' }; } });
  let sent = null;
  const res = { status() { return this; }, json(payload) { sent = payload; return this; } };
  return controller.company({ principal, dataScope, query, body, params: {} }, res).then(
    () => ({ calls, sent, error: null }),
    (error) => ({ calls, sent, error }),
  );
}

const ADMIN = { userId: 'u-admin', activeTenantId: 'tenant-A', permissions: new Set(['dashboards.read', 'documents.read', 'scheduling.read']) };
const ORG = { scope: 'ORGANIZATION', staffProfileId: null, clientIds: null, staffIds: null };

test('role templates: Company Admin and Owner hold dashboards.read at ORGANIZATION; BCBA is TEAM and RBT is SELF', () => {
  assert.equal(grant('org_admin', 'dashboards.read'), 'ORGANIZATION');
  assert.equal(grant('owner', 'dashboards.read'), 'ORGANIZATION');
  assert.equal(grant('bcba', 'dashboards.read'), 'TEAM');
  assert.equal(grant('rbt', 'dashboards.read'), 'SELF');
});

test('Company Admin (organization scope) gets the dashboard for THEIR tenant; request tenant fields are ignored', async () => {
  const r = await call({ principal: ADMIN, dataScope: ORG, query: { tenantId: 'tenant-B' }, body: { tenantId: 'tenant-B' } });
  assert.equal(r.error, null);
  assert.deepEqual(r.calls, [{ tenantId: 'tenant-A', includeNotes: true }]);
});

test('BCBA (TEAM) and RBT (SELF) scopes are refused with 403 and no data is read', async () => {
  for (const dataScope of [
    { scope: 'TEAM', staffProfileId: 'st-1', clientIds: ['c-1'], staffIds: ['st-1'] },
    { scope: 'SELF', staffProfileId: 'st-2', clientIds: [], staffIds: ['st-2'] },
    { scope: 'TEAM', staffProfileId: null, clientIds: [], staffIds: [] },
  ]) {
    const r = await call({ principal: { ...ADMIN, permissions: new Set(['dashboards.read']) }, dataScope });
    assert.equal(r.error?.status, 403, dataScope.scope);
    assert.equal(r.calls.length, 0);
  }
});

test('the notes section is requested only for a caller who can read appointment notes', async () => {
  const withoutNotes = await call({ principal: { ...ADMIN, permissions: ['dashboards.read'] }, dataScope: ORG });
  assert.deepEqual(withoutNotes.calls, [{ tenantId: 'tenant-A', includeNotes: false }]);
  const schedulingOnly = await call({ principal: { ...ADMIN, permissions: ['dashboards.read', 'scheduling.read'] }, dataScope: ORG });
  assert.equal(schedulingOnly.calls[0].includeNotes, true);
});

test('no principal → 401; no tenant context → error, never a tenant-less query', async () => {
  const anon = await call({ principal: null, dataScope: ORG });
  assert.equal(anon.error?.status, 401);
  const noTenant = await call({ principal: { ...ADMIN, activeTenantId: null }, dataScope: ORG });
  assert.ok(noTenant.error);
  assert.equal(noTenant.calls.length, 0);
});

test('route: GET /company is mounted behind authentication, tenant context and dashboards.read', async () => {
  const { createDashboardsRouter } = await import('../src/modules/dashboards/dashboards.routes.js');
  const router = createDashboardsRouter({});
  const layer = router.stack.find((l) => l.route?.path === '/company');
  assert.ok(layer, 'mounted');
  assert.deepEqual(Object.keys(layer.route.methods), ['get']);
  assert.equal(layer.route.stack.length, 2, 'requirePermission guard + handler');
  const middleware = router.stack.filter((l) => !l.route).map((l) => l.name);
  assert.ok(middleware.length >= 2, 'authenticate + enterTenantContext run first');
  assert.ok(!router.stack.some((l) => l.route?.path === '/company-overview'), 'retired route removed');
});
