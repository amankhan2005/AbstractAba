import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BulkService } from '../src/modules/bulk/bulk.service.js';
import { EXPORT_ENTITIES, FORBIDDEN_EXPORT_FIELDS } from '../src/modules/bulk/export.engine.js';
import { buildExportKey, exportKeyBelongsToTenant } from '../src/modules/bulk/exportKey.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function makeService(over = {}) {
  const createdClients = [];
  const storage = new Map();
  const exports = new Map();
  let seq = 0;
  const deps = {
    clients: { createClient: async ({ input }) => { if (input.clientNumber === 'BOOM') { const e = new Error('x'); e.code = 11000; throw e; } const rec = { id: `c-${++seq}`, ...input }; createdClients.push(rec); return rec; } },
    staff: { createStaff: async ({ input }) => ({ id: `s-${++seq}`, ...input }) },
    repositories: {
      existingKeys: async () => over.existing ?? new Set(),
      exportRows: async (_t, entity) => (over.exportRows?.[entity] ?? []),
    },
    exportRepo: {
      createExport: async (_t, doc) => { const r = { id: `e-${++seq}`, ...doc }; exports.set(r.id, r); return r; },
      completeExport: async (_t, id, patch) => { Object.assign(exports.get(id), patch); return { ...exports.get(id) }; },
      failExport: async (_t, id, failure) => { Object.assign(exports.get(id), { state: 'FAILED', failure }); },
      findExportById: async (_t, id) => (exports.has(id) ? { ...exports.get(id) } : null),
      listExports: async () => [...exports.values()],
      markDownloaded: async () => {},
    },
    storage: { put: async (k, buf) => storage.set(k, buf), get: async (k) => { if (!storage.has(k)) { const e = new Error('missing'); throw e; } return { buffer: storage.get(k) }; }, remove: async () => {} },
    buildExportKey,
    keyBelongsToTenant: exportKeyBelongsToTenant,
    ...over.deps,
  };
  return { service: new BulkService(deps), createdClients, storage, exports };
}

const CLIENTS_CSV = 'firstName,lastName,clientNumber\nAda,Lovelace,C-1\nGrace,Hopper,C-2';

test('previewImport (dry-run) validates without persisting', async () => {
  const { service, createdClients } = makeService();
  const res = await service.previewImport({ tenantId: 't1', entity: 'clients', csvText: CLIENTS_CSV });
  assert.equal(res.dryRun, true);
  assert.equal(res.summary.valid, 2);
  assert.equal(createdClients.length, 0); // nothing created
});

test('commitImport creates valid rows through the entity service', async () => {
  const { service, createdClients } = makeService();
  const res = await service.commitImport({ tenantId: 't1', actorUserId: 'u1', entity: 'clients', csvText: CLIENTS_CSV });
  assert.equal(res.created, 2);
  assert.equal(createdClients.length, 2);
});

test('a failing row does not stop the rest (partial failure isolation)', async () => {
  const { service, createdClients } = makeService();
  const csv = 'firstName,lastName,clientNumber\nA,B,C-1\nX,Y,BOOM\nP,Q,C-3';
  const res = await service.commitImport({ tenantId: 't1', actorUserId: 'u1', entity: 'clients', csvText: csv });
  assert.equal(res.created, 2); // C-1 and C-3
  assert.equal(res.failed, 1);  // BOOM
  assert.ok(res.failedRows.some((r) => r.errors[0].includes('already exists')));
  assert.equal(createdClients.length, 2);
});

test('DB duplicate detection moves existing rows to invalid (tenant-scoped)', async () => {
  const { service } = makeService({ existing: new Set(['c-1']) });
  const res = await service.previewImport({ tenantId: 't1', entity: 'clients', csvText: CLIENTS_CSV });
  // C-1 already exists → 1 valid, 1 invalid-duplicate.
  assert.equal(res.summary.valid, 1);
  assert.ok(res.invalid.some((r) => r.errors[0].includes('already exists')));
});

test('malformed CSV surfaces a validation error', async () => {
  const { service } = makeService();
  await assert.rejects(() => service.previewImport({ tenantId: 't1', entity: 'clients', csvText: 'a,b\n"unterminated' }), /unterminated|Malformed/);
});

test('generateExport writes an allowlisted, tenant-keyed artifact and audits', async () => {
  const { service, storage } = makeService({ exportRows: { clients: [{ _id: 'c1', clientNumber: 'C-1', firstName: 'Ada', lastName: 'Lovelace', status: 'ACTIVE', sensitive: { ssn: 'SECRET' }, createdAt: new Date() }] } });
  const rec = await service.generateExport({ tenantId: 't1', actorUserId: 'u1' });
  assert.equal(rec.state, 'AVAILABLE');
  assert.match(rec.artifactRef, /^exports\/t1\//);
  // Stored bytes must NOT contain the PHI/secret.
  const bytes = [...storage.values()][0].toString('utf8');
  assert.ok(!bytes.includes('SECRET'));
  assert.ok(bytes.includes('Ada'));
});

test('downloadExport refuses an artifact key from another tenant (IDOR)', async () => {
  const { service, exports } = makeService();
  // Seed an export whose artifactRef belongs to a different tenant.
  const rec = await service.generateExport({ tenantId: 't1', actorUserId: 'u1' });
  exports.get(rec.id).artifactRef = 'exports/OTHER/e-x/deadbeef';
  await assert.rejects(() => service.downloadExport({ tenantId: 't1', exportId: rec.id, actorUserId: 'u1' }), /not found/i);
});

test('export mappers never emit forbidden fields', () => {
  for (const [entity, spec] of Object.entries(EXPORT_ENTITIES)) {
    const sample = { _id: 'x', sensitive: { ssn: '1' }, passwordHash: 'h', tokenHash: 't', storageRef: 'r', checksum: 'c', mfaSecret: 'm' };
    const mapped = spec.map(sample);
    for (const forbidden of FORBIDDEN_EXPORT_FIELDS) {
      assert.equal(mapped[forbidden], undefined, `${entity} export must not emit ${forbidden}`);
    }
    // Only declared headers are present.
    for (const key of Object.keys(mapped)) assert.ok(spec.headers.includes(key), `${entity} emitted undeclared field ${key}`);
  }
});

test('export CSV is formula-injection safe for dangerous values', async () => {
  const { service, storage } = makeService({ exportRows: { clients: [{ _id: 'c1', clientNumber: '=cmd|calc', firstName: '@x', lastName: 'B', status: 'ACTIVE', createdAt: new Date() }] } });
  await service.generateExport({ tenantId: 't1', actorUserId: 'u1' });
  const bytes = [...storage.values()][0].toString('utf8');
  assert.ok(bytes.includes("'=cmd|calc") || bytes.includes(`"'=cmd|calc"`));
  assert.ok(bytes.includes("'@x"));
});
