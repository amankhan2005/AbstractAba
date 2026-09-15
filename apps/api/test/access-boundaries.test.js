import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scopeToClients,
  scopeToStaff,
  scopeToClientsOrStaff,
  IMPOSSIBLE,
} from '../src/modules/rbac/scopeFilters.js';
import { requireClientInScope, requireStaffInScope, requireRecordInScope } from '../src/middleware/scopeGuard.js';

/**
 * ---------------------------------------------------------------------------
 * ACCESS BOUNDARIES — the three scenarios the platform is judged on.
 *
 *   1. An RBT cannot reach another RBT's clients, sessions or hours.
 *   2. A BCBA cannot reach children outside their caseload.
 *   3. The company (Owner / Organization Admin) retains organization-wide
 *      management access — the boundary must not be so tight it breaks the
 *      role the clinic actually runs on.
 *
 * These test the enforcement layer directly: the filter builder that every
 * repository calls, and the by-id guards every detail route mounts. That is
 * where the boundary lives, so that is where it is pinned.
 *
 * SCOPE FIXTURES, mirroring what dataScope.js resolves from the real
 * assignment and supervision tables:
 * ---------------------------------------------------------------------------
 */

// Technician Ann: assigned to two children, supervised by BCBA Ben.
const RBT_ANN = { scope: 'SELF', staffProfileId: 'rbt-ann', clientIds: ['child-1', 'child-2'], staffIds: ['rbt-ann'] };
// Technician Raj: a different caseload entirely.
const RBT_RAJ = { scope: 'SELF', staffProfileId: 'rbt-raj', clientIds: ['child-9'], staffIds: ['rbt-raj'] };
// BCBA Ben: supervises Ann; caseload is Ann's children plus one he leads alone.
const BCBA_BEN = { scope: 'TEAM', staffProfileId: 'bcba-ben', clientIds: ['child-1', 'child-2', 'child-3'], staffIds: ['bcba-ben', 'rbt-ann'] };
// BCBA Cara: an unrelated caseload in the same clinic.
const BCBA_CARA = { scope: 'TEAM', staffProfileId: 'bcba-cara', clientIds: ['child-9'], staffIds: ['bcba-cara', 'rbt-raj'] };
// The company: Owner / Organization Admin, tenant-wide.
const COMPANY = { scope: 'ORGANIZATION', staffProfileId: null, clientIds: null, staffIds: null };
// A technician with no assignments yet — the fail-closed case.
const UNASSIGNED = { scope: 'SELF', staffProfileId: 'rbt-new', clientIds: [], staffIds: ['rbt-new'] };

const run = (mw, req) => new Promise((resolve) => mw(req, {}, (err) => resolve(err ?? null)));

// ===========================================================================
// 1 · AN RBT CANNOT REACH ANOTHER RBT'S DATA
// ===========================================================================

test('RBT: a client list is narrowed to their own assigned children', () => {
  const filter = scopeToClients({ deletedAt: null }, RBT_ANN);
  assert.deepEqual(filter.clientId, { $in: ['child-1', 'child-2'] });
  assert.equal(filter.deletedAt, null, 'existing filter conditions survive');
});

test('REGRESSION — RBT cannot widen scope by naming another technician\u2019s child', () => {
  // The probe: GET /v1/sessions?clientId=child-9 from Ann. A filter that let a
  // caller-supplied value REPLACE the scope would hand over Raj's child.
  const filter = scopeToClients({ clientId: 'child-9' }, RBT_ANN);
  assert.deepEqual(filter.clientId, IMPOSSIBLE, 'must intersect to nothing, not override the scope');
});

test('RBT: naming a child they ARE assigned to still works', () => {
  const filter = scopeToClients({ clientId: 'child-2' }, RBT_ANN);
  assert.equal(filter.clientId, 'child-2');
});

test('REGRESSION — RBT cannot read another technician\u2019s timesheet by staff filter', () => {
  // Blueprint 4.5: "No financial visibility beyond their own hours."
  const filter = scopeToStaff({ staffProfileId: 'rbt-raj' }, RBT_ANN);
  assert.deepEqual(filter.staffProfileId, IMPOSSIBLE);

  const own = scopeToStaff({}, RBT_ANN);
  assert.deepEqual(own.staffProfileId, { $in: ['rbt-ann'] });
});

test('REGRESSION — RBT cannot open another technician\u2019s session by identifier', async () => {
  // A correct list filter does not protect GET /sessions/:id.
  const guard = requireRecordInScope(async () => ({ clientId: 'child-9', staffProfileId: 'rbt-raj' }));
  const err = await run(guard, { dataScope: RBT_ANN, params: { sessionId: 's-raj' } });
  assert.ok(err, 'the request must be refused');
  assert.equal(err.status ?? err.statusCode, 404, 'a 403 would confirm the record exists');
});

test('RBT: their own session by identifier is reachable', async () => {
  const guard = requireRecordInScope(async () => ({ clientId: 'child-1', staffProfileId: 'rbt-ann' }));
  const req = { dataScope: RBT_ANN, params: { sessionId: 's-ann' } };
  assert.equal(await run(guard, req), null);
  assert.deepEqual(req.scopedRecord, { clientId: 'child-1', staffProfileId: 'rbt-ann' });
});

test('RBT: two technicians\u2019 scopes never intersect', () => {
  const ann = scopeToClients({}, RBT_ANN).clientId.$in;
  const raj = scopeToClients({}, RBT_RAJ).clientId.$in;
  assert.deepEqual(ann.filter((c) => raj.includes(c)), []);
});

// ===========================================================================
// 2 · A BCBA CANNOT REACH CHILDREN OUTSIDE THEIR CASELOAD
// ===========================================================================

test('BCBA: the client list is the caseload, not the roster', () => {
  const filter = scopeToClients({}, BCBA_BEN);
  assert.deepEqual(filter.clientId, { $in: ['child-1', 'child-2', 'child-3'] });
});

test('REGRESSION — BCBA cannot open a child on another analyst\u2019s caseload', async () => {
  const err = await run(requireClientInScope('clientId'), { dataScope: BCBA_BEN, params: { clientId: 'child-9' } });
  assert.ok(err);
  assert.equal(err.status ?? err.statusCode, 404);
  // Blueprint: never surface a code or an internal field name to a user.
  assert.match(err.message, /couldn\u2019t find that client/i);
  assert.doesNotMatch(err.message, /tenantId|caseload|403|Mongo/);
});

test('BCBA: reaches a session because the CLIENT is on their caseload', async () => {
  // Delivered by a technician they do not supervise, for a child they lead.
  const guard = requireRecordInScope(async () => ({ clientId: 'child-3', staffProfileId: 'rbt-raj' }));
  assert.equal(await run(guard, { dataScope: BCBA_BEN, params: {} }), null);
});

test('BCBA: reaches a session because a SUPERVISEE delivered it', async () => {
  const guard = requireRecordInScope(async () => ({ clientId: 'child-1', staffProfileId: 'rbt-ann' }));
  assert.equal(await run(guard, { dataScope: BCBA_BEN, params: {} }), null);
});

test('BCBA: reaches neither dimension of an unrelated session', async () => {
  const guard = requireRecordInScope(async () => ({ clientId: 'child-9', staffProfileId: 'rbt-raj' }));
  const err = await run(guard, { dataScope: BCBA_BEN, params: {} });
  assert.ok(err);
  assert.equal(err.status ?? err.statusCode, 404);
});

test('BCBA: supervision reaches supervisees only, never a peer analyst', async () => {
  assert.equal(await run(requireStaffInScope('staffId'), { dataScope: BCBA_BEN, params: { staffId: 'rbt-ann' } }), null);
  const err = await run(requireStaffInScope('staffId'), { dataScope: BCBA_BEN, params: { staffId: 'bcba-cara' } });
  assert.ok(err);
  assert.equal(err.status ?? err.statusCode, 404);
});

test('two BCBAs in one clinic cannot see each other\u2019s children', () => {
  const ben = scopeToClients({}, BCBA_BEN).clientId.$in;
  const cara = scopeToClients({}, BCBA_CARA).clientId.$in;
  assert.deepEqual(ben.filter((c) => cara.includes(c)), []);
});

// ===========================================================================
// 3 · THE COMPANY RETAINS ORGANIZATION-WIDE ACCESS
// ===========================================================================

test('COMPANY: no client narrowing is applied at all', () => {
  const filter = scopeToClients({ deletedAt: null }, COMPANY);
  assert.deepEqual(filter, { deletedAt: null }, 'tenant-wide scope must add no condition');
});

test('COMPANY: no staff narrowing is applied at all', () => {
  const filter = scopeToStaff({ status: 'ACTIVE' }, COMPANY);
  assert.deepEqual(filter, { status: 'ACTIVE' });
});

test('COMPANY: an explicit filter is honoured rather than intersected away', () => {
  const filter = scopeToClients({ clientId: 'child-9' }, COMPANY);
  assert.equal(filter.clientId, 'child-9');
});

test('COMPANY: reaches any client, staff member and record by identifier', async () => {
  assert.equal(await run(requireClientInScope('clientId'), { dataScope: COMPANY, params: { clientId: 'child-9' } }), null);
  assert.equal(await run(requireStaffInScope('staffId'), { dataScope: COMPANY, params: { staffId: 'rbt-raj' } }), null);
  const guard = requireRecordInScope(async () => ({ clientId: 'child-9', staffProfileId: 'rbt-raj' }));
  assert.equal(await run(guard, { dataScope: COMPANY, params: {} }), null);
});

test('COMPANY: a record that genuinely does not exist is still a 404', async () => {
  const guard = requireRecordInScope(async () => null);
  const err = await run(guard, { dataScope: COMPANY, params: {} });
  assert.ok(err);
  assert.equal(err.status ?? err.statusCode, 404);
});

// ===========================================================================
// FAIL-CLOSED — the direction the defect ran last time
// ===========================================================================

test('FAIL CLOSED: an empty scope returns nothing, never everything', () => {
  // The original defect in one line. `if (ids.length) filter.x = ...` reads
  // naturally and is exactly backwards: a technician with no assignments falls
  // through to an unfiltered query and receives the entire clinic.
  const filter = scopeToClients({ deletedAt: null }, UNASSIGNED);
  assert.deepEqual(filter.clientId, { $in: [] }, 'empty scope must be a query that matches nothing');
  assert.notDeepEqual(filter, { deletedAt: null }, 'empty must never be treated as unrestricted');
});

test('FAIL CLOSED: a missing scope object is refused, not waved through', async () => {
  // A route that forgot requirePermission must not serve the tenant.
  assert.deepEqual(scopeToClients({}, undefined).clientId, IMPOSSIBLE);
  assert.deepEqual(scopeToStaff({}, null).staffProfileId, IMPOSSIBLE);

  for (const guard of [requireClientInScope('clientId'), requireStaffInScope('staffId')]) {
    const err = await run(guard, { dataScope: undefined, params: { clientId: 'c-1', staffId: 's-1' } });
    assert.ok(err, 'a request with no resolved scope must be refused');
  }
});

test('FAIL CLOSED: an unrecognised filter shape intersects to nothing', () => {
  // Rather than guessing at an operator it does not understand.
  const filter = scopeToClients({ clientId: { $ne: 'child-1' } }, RBT_ANN);
  assert.deepEqual(filter.clientId, IMPOSSIBLE);
});

test('client-or-staff narrowing preserves an existing $and rather than clobbering it', () => {
  const filter = scopeToClientsOrStaff({ $and: [{ status: 'ACTIVE' }] }, RBT_ANN);
  assert.equal(filter.$and.length, 2);
  assert.deepEqual(filter.$and[0], { status: 'ACTIVE' });
  assert.deepEqual(filter.$and[1], {
    $or: [{ clientId: { $in: ['child-1', 'child-2'] } }, { staffProfileId: { $in: ['rbt-ann'] } }],
  });
});

test('client-or-staff narrowing adds nothing for a tenant-wide caller', () => {
  const filter = scopeToClientsOrStaff({ deletedAt: null }, COMPANY);
  assert.deepEqual(filter, { deletedAt: null });
});
