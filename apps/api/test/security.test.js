import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { tenantPlugin } from '../src/tenancy/tenantPlugin.js';
import { withTenant, withPlatform } from '../src/tenancy/tenantContext.js';
import { AUDIT_CATALOGUE } from '../src/middleware/auditRecorder.js';

/** Locks in the cross-cutting security pass. DB-free: exercises the plugin hooks
 *  and middleware logic directly, without a live MongoDB. */

const TID = '11111111-1111-7111-8111-111111111111';

function model(name) {
  const schema = new mongoose.Schema({ name: String });
  schema.plugin(tenantPlugin);
  return mongoose.model(name, schema);
}

// --- bulkWrite tenant enforcement -----------------------------------------

test('bulkWrite fails closed with no tenant context', async () => {
  const M = model('SecBulkA');
  await assert.rejects(
    () => M.bulkWrite([{ insertOne: { document: { name: 'x' } } }]),
    (e) => e.name === 'TenantContextError',
  );
});

test('bulkWrite stamps inserts and scopes op filters to the active tenant', async () => {
  const M = model('SecBulkB');
  const ops = [
    { insertOne: { document: { name: 'y' } } },
    { updateOne: { filter: { name: 'y' }, update: { $set: { name: 'z' } } } },
    { deleteOne: { filter: { name: 'z' } } },
  ];
  try { await withTenant(TID, () => M.bulkWrite(ops)); } catch { /* no DB; hook already mutated ops */ }
  assert.equal(ops[0].insertOne.document.tenantId, TID);
  assert.equal(ops[1].updateOne.filter.tenantId, TID);
  assert.equal(ops[2].deleteOne.filter.tenantId, TID);
});

test('bulkWrite under platform requires an explicit tenantId on inserts', async () => {
  const M = model('SecBulkC');
  await assert.rejects(
    () => withPlatform(() => M.bulkWrite([{ insertOne: { document: { name: 'x' } } }])),
    (e) => e.name === 'TenantContextError',
  );
});

// --- $lookup sub-pipeline isolation ---------------------------------------

test('aggregate injects a tenant $match at the top and into $lookup sub-pipelines', async () => {
  const M = model('SecAggA');
  const agg = M.aggregate([
    { $lookup: { from: 'other', pipeline: [{ $match: { a: 1 } }], as: 'joined' } },
  ]);
  const pipelineRef = agg.pipeline();
  try { await withTenant(TID, () => agg.exec()); } catch { /* no DB; pre-hook already ran */ }
  // top-level tenant match prepended
  assert.deepEqual(pipelineRef[0], { $match: { tenantId: TID } });
  // $lookup sub-pipeline also tenant-filtered
  const lookup = pipelineRef.find((s) => s.$lookup);
  assert.deepEqual(lookup.$lookup.pipeline[0], { $match: { tenantId: TID } });
});

test('aggregate fails closed with no context', async () => {
  const M = model('SecAggB');
  await assert.rejects(() => M.aggregate([{ $match: { a: 1 } }]).exec(), (e) => e.name === 'TenantContextError');
});

// --- audit recorder catalogue ---------------------------------------------

test('audit catalogue covers the protected write endpoints and is read-free', () => {
  // sampling of writes that must be audited
  const musts = [
    ['POST', '/api/v1/platform/organizations'],
    ['POST', '/api/v1/platform/organizations/:id/transitions'],
    ['PATCH', '/api/v1/organization'],
    ['POST', '/api/v1/users'],
    ['PATCH', '/api/v1/users/:membershipId/status'],
    ['DELETE', '/api/v1/users/:membershipId'],
    ['PUT', '/api/v1/organization/settings/:namespace'],
    ['PUT', '/api/v1/organization/branding'],
    ['POST', '/api/v1/clients'],
    ['PATCH', '/api/v1/clients/:clientId'],
    ['POST', '/api/v1/clients/:clientId/archive'],
    ['POST', '/api/v1/clients/:clientId/guardians'],
    ['PUT', '/api/v1/clients/:clientId/intake'],
    ['POST', '/api/v1/staff'],
    ['PATCH', '/api/v1/staff/:staffId'],
    ['POST', '/api/v1/staff/:staffId/deactivate'],
    ['POST', '/api/v1/staff/:staffId/credentials'],
    ['POST', '/api/v1/staff/:staffId/supervisees'],
    ['POST', '/api/v1/scheduling/appointments'],
    ['PATCH', '/api/v1/scheduling/appointments/:appointmentId'],
    ['POST', '/api/v1/scheduling/appointments/:appointmentId/cancel'],
    ['POST', '/api/v1/scheduling/authorizations'],
    ['POST', '/api/v1/plans'],
    ['PATCH', '/api/v1/plans/:planId'],
    ['POST', '/api/v1/plans/:planId/archive'],
    ['POST', '/api/v1/plans/:planId/goals'],
    ['POST', '/api/v1/plans/:planId/goals/:goalId/programs'],
    ['POST', '/api/v1/plans/:planId/programs/:programId/targets'],
    ['POST', '/api/v1/sessions'],
    ['POST', '/api/v1/sessions/:sessionId/freeze'],
    ['POST', '/api/v1/sessions/:sessionId/data-points'],
    ['POST', '/api/v1/documents'],
    ['POST', '/api/v1/documents/:documentId/finalize'],
    ['POST', '/api/v1/documents/:documentId/supersede'],
  ];
  for (const [method, pattern] of musts) {
    assert.ok(AUDIT_CATALOGUE.some((e) => e.method === method && e.pattern === pattern), `${method} ${pattern} must be catalogued`);
  }
  // no GET (reads) in the catalogue — Level A records writes only
  assert.equal(AUDIT_CATALOGUE.some((e) => e.method === 'GET'), false);
});

// --- clients audit entries are metadata-only (Phase 2) ---------------------

test('client audit catalogue entries are writes anchored to the client entity', () => {
  const clientEntries = AUDIT_CATALOGUE.filter((e) => e.pattern.startsWith('/api/v1/clients'));
  assert.ok(clientEntries.length >= 10, 'all client write endpoints are catalogued');
  for (const e of clientEntries) {
    assert.equal(e.entityType, 'client', 'client writes audit against the client entity');
    assert.notEqual(e.method, 'GET', 'reads are never catalogued');
    // The catalogue carries no request/response bodies — only method + pattern +
    // action + entityType — so no PHI can enter the audit trail through it.
    assert.deepEqual(Object.keys(e).sort(), ['action', 'entityType', 'method', 'pattern']);
  }
});

// --- clinical plans audit entries are metadata-only (Phase 2) --------------

test('plan audit catalogue entries are writes anchored to treatment_plan, no PHI', () => {
  const entries = AUDIT_CATALOGUE.filter((e) => e.pattern.startsWith('/api/v1/plans'));
  assert.ok(entries.length >= 12, 'all plan/goal/program/target write endpoints are catalogued');
  for (const e of entries) {
    assert.equal(e.entityType, 'treatment_plan');
    assert.notEqual(e.method, 'GET');
    assert.deepEqual(Object.keys(e).sort(), ['action', 'entityType', 'method', 'pattern']);
  }
});

// --- session audit entries are metadata-only (Phase 2) ---------------------

test('session audit catalogue entries are writes anchored to the session entity, no PHI', () => {
  const entries = AUDIT_CATALOGUE.filter((e) => e.pattern.startsWith('/api/v1/sessions'));
  assert.ok(entries.length >= 6, 'all session write endpoints (incl. freeze) are catalogued');
  for (const e of entries) {
    assert.equal(e.entityType, 'session', 'session writes audit against the session entity');
    assert.notEqual(e.method, 'GET', 'reads are never catalogued');
    // method + pattern + action + entityType only — the sealed narrative can
    // never enter the audit trail through the catalogue.
    assert.deepEqual(Object.keys(e).sort(), ['action', 'entityType', 'method', 'pattern']);
  }
});

// --- clinical-document audit entries are metadata-only (Phase 2) -----------

test('document audit catalogue entries are writes anchored to clinical_document, no PHI', () => {
  const entries = AUDIT_CATALOGUE.filter((e) => e.pattern.startsWith('/api/v1/documents'));
  assert.ok(entries.length >= 5, 'all document write endpoints (incl. finalize/supersede) are catalogued');
  for (const e of entries) {
    assert.equal(e.entityType, 'clinical_document');
    assert.notEqual(e.method, 'GET');
    assert.deepEqual(Object.keys(e).sort(), ['action', 'entityType', 'method', 'pattern']);
  }
});
