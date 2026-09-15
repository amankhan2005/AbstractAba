import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InsuranceCatalogService } from '../src/modules/insurance-catalog/insuranceCatalog.service.js';
import { createCatalogSchema, updateCatalogSchema } from '../src/modules/insurance-catalog/insuranceCatalog.schemas.js';

/**
 * Spec Module 5.1-5.5 — the Super Admin insurance master catalog.
 * Platform operators do full CRUD; a company reads ONLY the active entries whose
 * states intersect its own service states. Company identity + states come from
 * the server (the org), never the request. DB-free: the repository + org port
 * are fakes, so these prove the service contract without Mongo.
 */
function makeService({ entries = [], org = { id: 't-1', serviceStates: [], stateCode: null } } = {}) {
  const store = new Map(entries.map((e) => [e.id, e]));
  let seq = entries.length;
  const repo = {
    async list({ activeOnly = false, state = null } = {}) {
      let out = [...store.values()].filter((e) => !e.deletedAt);
      if (activeOnly) out = out.filter((e) => e.active !== false);
      if (state) out = out.filter((e) => (e.states || []).includes(state));
      return out.map((e) => ({ ...e }));
    },
    async findById(id) { const e = store.get(id); return e && !e.deletedAt ? { ...e } : null; },
    async create(doc) { seq += 1; const e = { id: `ic-${seq}`, ...doc }; store.set(e.id, e); return { ...e }; },
    async update(id, patch) { const e = { ...store.get(id), ...patch }; store.set(id, e); return { ...e }; },
    async softDelete(id) { const e = store.get(id); e.deletedAt = new Date(); e.active = false; return { id, deleted: true }; },
  };
  const organizations = { async getById() { return org; } };
  return { svc: new InsuranceCatalogService({ repository: repo, organizations }), repo };
}

test('platform create normalizes states (dedupe + uppercase) and defaults active', async () => {
  const { svc } = makeService();
  const e = await svc.create({ actorUserId: 'op-1', input: { name: 'Aetna', states: ['ca', 'CA', 'tx'] } });
  assert.deepEqual(e.states.sort(), ['CA', 'TX']);
  assert.equal(e.active, true);
});

test('platform update + soft-delete; a missing id 404s', async () => {
  const { svc } = makeService({ entries: [{ id: 'ic-1', name: 'Aetna', states: ['CA'], active: true }] });
  const upd = await svc.update({ id: 'ic-1', actorUserId: 'op', input: { name: 'Aetna PPO', active: false } });
  assert.equal(upd.name, 'Aetna PPO');
  assert.equal(upd.active, false);
  await svc.remove({ id: 'ic-1', actorUserId: 'op' });
  await assert.rejects(() => svc.get('ic-1'), (e) => e.code === 'INSURANCE_CATALOG_NOT_FOUND');
  await assert.rejects(() => svc.update({ id: 'nope', actorUserId: 'op', input: { name: 'x' } }), (e) => e.code === 'INSURANCE_CATALOG_NOT_FOUND');
});

test('company sees ONLY active entries whose states intersect its service states', async () => {
  const entries = [
    { id: 'a', name: 'CA Ins', states: ['CA'], active: true },
    { id: 'b', name: 'TX Ins', states: ['TX'], active: true },
    { id: 'c', name: 'Multi', states: ['CA', 'NY'], active: true },
    { id: 'd', name: 'Inactive CA', states: ['CA'], active: false },
  ];
  const { svc } = makeService({ entries, org: { id: 't-1', serviceStates: ['CA'], stateCode: null } });
  const out = await svc.listForCompany({ tenantId: 't-1' });
  assert.deepEqual(out.map((e) => e.id).sort(), ['a', 'c']); // CA + Multi(CA); not TX, not inactive
});

test('company with no serviceStates falls back to its stateCode', async () => {
  const entries = [
    { id: 'a', name: 'CA', states: ['CA'], active: true },
    { id: 'b', name: 'TX', states: ['TX'], active: true },
  ];
  const { svc } = makeService({ entries, org: { id: 't-1', serviceStates: [], stateCode: 'TX' } });
  const out = await svc.listForCompany({ tenantId: 't-1' });
  assert.deepEqual(out.map((e) => e.id), ['b']);
});

test('a company cannot influence filtering via the request — states come from the org only', async () => {
  // The service takes only { tenantId }; there is no request-supplied state.
  // Two companies with different states get different slices of the SAME catalog.
  const entries = [
    { id: 'a', name: 'CA', states: ['CA'], active: true },
    { id: 'b', name: 'TX', states: ['TX'], active: true },
  ];
  const caCo = makeService({ entries, org: { id: 't-ca', serviceStates: ['CA'] } });
  const txCo = makeService({ entries, org: { id: 't-tx', serviceStates: ['TX'] } });
  assert.deepEqual((await caCo.svc.listForCompany({ tenantId: 't-ca' })).map((e) => e.id), ['a']);
  assert.deepEqual((await txCo.svc.listForCompany({ tenantId: 't-tx' })).map((e) => e.id), ['b']);
});

test('schemas: valid create passes; junk state + missing name are rejected; update needs a field', () => {
  assert.equal(createCatalogSchema.safeParse({ name: 'Aetna', states: ['CA', 'TX'], logoUrl: 'https://x/y.png' }).success, true);
  assert.equal(createCatalogSchema.safeParse({ name: 'Aetna', states: ['ZZ'] }).success, false); // not a real state
  assert.equal(createCatalogSchema.safeParse({ states: ['CA'] }).success, false); // no name
  assert.equal(createCatalogSchema.safeParse({ name: 'X', logoUrl: 'not-a-url' }).success, false);
  assert.equal(updateCatalogSchema.safeParse({}).success, false); // must provide something
});

// --- Fix 2: state filtering edges, logo passthrough, empty state -------------

test('the logo (logoUrl) is returned to the company for display', () => {
  const entries = [{ id: 'a', name: 'CA Health', states: ['CA'], logoUrl: 'https://cdn/logo.png', active: true }];
  const { svc } = makeService({ entries, org: { id: 't-1', serviceStates: ['CA'], stateCode: null } });
  return svc.listForCompany({ tenantId: 't-1' }).then((out) => {
    assert.equal(out.length, 1);
    assert.equal(out[0].logoUrl, 'https://cdn/logo.png', 'the Super-Admin logo must be returned for display');
  });
});

test('a company with states but NO matching active catalog entry gets an empty list (drives the empty-state message)', async () => {
  const entries = [
    { id: 'a', name: 'CA Health', states: ['CA'], active: true },
    { id: 'b', name: 'Inactive TX', states: ['TX'], active: false },
  ];
  const { svc } = makeService({ entries, org: { id: 't-1', serviceStates: ['TX'], stateCode: null } });
  const out = await svc.listForCompany({ tenantId: 't-1' });
  assert.deepEqual(out, [], 'no active TX entry → empty list, not the CA entry or a broken dropdown');
});

test('inactive catalog entries are never offered to a company even for a matching state', async () => {
  const entries = [
    { id: 'a', name: 'CA Active', states: ['CA'], active: true },
    { id: 'b', name: 'CA Inactive', states: ['CA'], active: false },
  ];
  const { svc } = makeService({ entries, org: { id: 't-1', serviceStates: ['CA'], stateCode: null } });
  const out = await svc.listForCompany({ tenantId: 't-1' });
  assert.deepEqual(out.map((e) => e.id), ['a']);
});

test('a company serving multiple states sees the union of matching active entries', async () => {
  const entries = [
    { id: 'a', name: 'CA', states: ['CA'], active: true },
    { id: 'b', name: 'TX', states: ['TX'], active: true },
    { id: 'c', name: 'NY', states: ['NY'], active: true },
  ];
  const { svc } = makeService({ entries, org: { id: 't-1', serviceStates: ['CA', 'TX'], stateCode: null } });
  const out = await svc.listForCompany({ tenantId: 't-1' });
  assert.deepEqual(out.map((e) => e.id).sort(), ['a', 'b']); // CA + TX, not NY
});
