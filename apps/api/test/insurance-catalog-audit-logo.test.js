import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InsuranceCatalogService, PLATFORM_AUDIT_TENANT } from '../src/modules/insurance-catalog/insuranceCatalog.service.js';

/**
 * Spec §19 (audit) + Module 6 (logo upload). DB-free: the repository, audit
 * sink and logo uploader are all fakes, so these pin the service's contract —
 * every Super Admin write is audited on the platform chain, and a logo goes
 * through the injected uploader and is written back to the entry.
 */
function makeService({ entries = [] } = {}) {
  const store = new Map(entries.map((e) => [e.id, { ...e }]));
  let seq = entries.length;
  const audits = [];
  const repo = {
    async list({ activeOnly = false } = {}) {
      let out = [...store.values()].filter((e) => !e.deletedAt);
      if (activeOnly) out = out.filter((e) => e.active !== false);
      return out.map((e) => ({ ...e }));
    },
    async findById(id) { const e = store.get(id); return e && !e.deletedAt ? { ...e } : null; },
    async create(doc) { seq += 1; const e = { id: `ic-${seq}`, ...doc }; store.set(e.id, e); return { ...e }; },
    async update(id, patch) { const e = { ...store.get(id), ...patch }; store.set(id, e); return { ...e }; },
    async softDelete(id) { const e = store.get(id); e.deletedAt = new Date(); e.active = false; return { id, deleted: true }; },
  };
  const audit = { record: async (rec) => { audits.push(rec); } };
  const uploads = [];
  const logoUploader = async ({ publicId, buffer }) => {
    uploads.push({ publicId, size: buffer.length });
    return { url: `https://cdn.example/${publicId}.png` };
  };
  const svc = new InsuranceCatalogService({ repository: repo, organizations: {}, audit, logoUploader });
  return { svc, audits, uploads };
}

test('create records an insurance_catalog.created audit on the platform chain', async () => {
  const { svc, audits } = makeService();
  await svc.create({ actorUserId: 'op-1', input: { name: 'Aetna', states: ['CA', 'TX'] } });
  const rec = audits.find((a) => a.action === 'insurance_catalog.created');
  assert.ok(rec, 'a created audit is emitted');
  assert.equal(rec.tenantId, PLATFORM_AUDIT_TENANT);
  assert.equal(rec.entityType, 'insurance_catalog');
  assert.equal(rec.actorId, 'op-1');
});

test('deactivation emits a distinct insurance_catalog.deactivated audit (§19)', async () => {
  const { svc, audits } = makeService({ entries: [{ id: 'ic-1', name: 'Aetna', states: ['CA'], active: true }] });
  await svc.update({ id: 'ic-1', actorUserId: 'op-1', input: { active: false } });
  assert.ok(audits.some((a) => a.action === 'insurance_catalog.deactivated'));
});

test('a states change emits insurance_catalog.states_changed with before/after', async () => {
  const { svc, audits } = makeService({ entries: [{ id: 'ic-1', name: 'Aetna', states: ['CA', 'TX'], active: true }] });
  await svc.update({ id: 'ic-1', actorUserId: 'op-1', input: { states: ['FL', 'NY'] } });
  const rec = audits.find((a) => a.action === 'insurance_catalog.states_changed');
  assert.ok(rec);
  assert.deepEqual(rec.payload.before.states.sort(), ['CA', 'TX']);
  assert.deepEqual(rec.payload.after.states.sort(), ['FL', 'NY']);
});

test('uploadLogo routes bytes through the injected uploader and writes the URL back', async () => {
  const { svc, audits, uploads } = makeService({ entries: [{ id: 'ic-1', name: 'Aetna', states: ['CA'], active: true }] });
  const updated = await svc.uploadLogo({ id: 'ic-1', buffer: Buffer.from('x'.repeat(50)), actorUserId: 'op-1' });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].publicId, 'aba1on1/insurance-catalog/ic-1/logo', 'foldered per catalog entry');
  assert.equal(updated.logoUrl, 'https://cdn.example/aba1on1/insurance-catalog/ic-1/logo.png');
  assert.ok(audits.some((a) => a.action === 'insurance_catalog.logo_uploaded'));
});

test('uploadLogo on a missing entry 404s before touching the uploader', async () => {
  const { svc, uploads } = makeService();
  await assert.rejects(
    () => svc.uploadLogo({ id: 'nope', buffer: Buffer.from('x'), actorUserId: 'op-1' }),
    (e) => e.code === 'INSURANCE_CATALOG_NOT_FOUND',
  );
  assert.equal(uploads.length, 0);
});

test('listForCompany filters to active + state-intersecting entries', async () => {
  const { svc } = makeService({
    entries: [
      { id: 'ic-1', name: 'A', states: ['CA', 'FL'], active: true },
      { id: 'ic-2', name: 'B', states: ['TX', 'NY'], active: true },
      { id: 'ic-3', name: 'C', states: ['FL', 'AZ'], active: true },
      { id: 'ic-4', name: 'D', states: ['CA'], active: false },
    ],
  });
  svc.deps.organizations = { async getById() { return { serviceStates: ['CA', 'TX'] }; } };
  const out = await svc.listForCompany({ tenantId: 't-1' });
  assert.deepEqual(out.map((e) => e.name).sort(), ['A', 'B'], 'C is out-of-state, D is inactive');
});
