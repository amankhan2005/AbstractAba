import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCoverageSchema,
  updateCoverageSchema,
  verifyCoverageSchema,
} from '../src/modules/clients/clients.schemas.js';
import { SYSTEM_ROLE_TEMPLATES } from '../src/modules/rbac/roleTemplates.js';
import { PERMISSION_CATALOGUE } from '../src/modules/rbac/permissionCatalogue.js';
import { toCoverage } from '../src/modules/clients/insurance.service.js';

/**
 * ---------------------------------------------------------------------------
 * INSURANCE COVERAGE — API CONTRACT AND AUTHORIZATION.
 *
 * The gate was enforced in scheduling but unreachable: there was no way to
 * record or verify coverage, so every booking was refused with no path to
 * clear the refusal. These tests pin the contract of the endpoints that close
 * that loop, and — more importantly — the two ways the gate could be defeated
 * through them.
 * ---------------------------------------------------------------------------
 */

// --- the gate cannot be defeated through the write path ---------------------

test('REGRESSION — verificationStatus cannot be set when creating coverage', () => {
  // If a client could post `verificationStatus: 'VERIFIED'`, the entire
  // scheduling gate would be defeated by one field in a request body.
  const result = createCoverageSchema.safeParse({
    payerName: 'Blue Cross',
    memberId: 'M123456',
    verificationStatus: 'VERIFIED',
  });
  assert.equal(result.success, false, 'a status on create must be rejected outright');
});

test('REGRESSION — verificationStatus cannot be set when updating coverage', () => {
  const result = updateCoverageSchema.safeParse({ verificationStatus: 'VERIFIED' });
  assert.equal(result.success, false);
});

test('REGRESSION — verifiedAt and verifiedBy cannot be forged through the API', () => {
  // Attribution is recorded by the server from the authenticated principal.
  // Accepting it from the body would let anyone claim someone else checked.
  assert.equal(createCoverageSchema.safeParse({
    payerName: 'X', memberId: 'M1', verifiedBy: 'someone-else',
  }).success, false);
  assert.equal(createCoverageSchema.safeParse({
    payerName: 'X', memberId: 'M1', verifiedAt: new Date().toISOString(),
  }).success, false);
});

test('a well-formed coverage record is accepted', () => {
  const result = createCoverageSchema.safeParse({
    payerName: 'Blue Cross',
    memberId: 'M123456',
    groupNumber: 'G99',
    subscriberRelationship: 'PARENT',
    subscriberName: 'A Guardian',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: '2026-12-31T00:00:00.000Z',
  });
  assert.equal(result.success, true, result.success ? '' : JSON.stringify(result.error.issues));
});

// --- Bug #2: an edit must be able to CLEAR an optional field ----------------
// The editor sends `groupNumber`/`subscriberName` as trimmed value OR null so an
// edit can both set and clear them. The schema must accept null and coerce an
// empty string to null so a cleared field is stored as null, not ''.

test('Bug #2 — update accepts null groupNumber / subscriberName (clearing an optional field)', () => {
  const r = updateCoverageSchema.safeParse({ groupNumber: null, subscriberName: null });
  assert.equal(r.success, true, r.success ? '' : JSON.stringify(r.error.issues));
  assert.equal(r.data.groupNumber, null);
  assert.equal(r.data.subscriberName, null);
});

test('Bug #2 — an empty-string optional field is coerced to null on update', () => {
  const r = updateCoverageSchema.safeParse({ groupNumber: '' });
  assert.equal(r.success, true, r.success ? '' : JSON.stringify(r.error.issues));
  assert.equal(r.data.groupNumber, null, 'empty string must persist as null, not ""');
});

test('Bug #2 — a real groupNumber value still passes through unchanged', () => {
  const r = updateCoverageSchema.safeParse({ groupNumber: 'G-77' });
  assert.equal(r.success, true, r.success ? '' : JSON.stringify(r.error.issues));
  assert.equal(r.data.groupNumber, 'G-77');
});

// --- Fix 2: Plan Name / Benefit Order / Funding Source removed from the form -
// The client insurance form no longer collects these. The schemas are strict, so
// a stray value from an old client is rejected rather than silently written.

test('Fix 2 — planName is no longer accepted on create or update', () => {
  assert.equal(createCoverageSchema.safeParse({ payerName: 'X', memberId: 'M1', planName: 'PPO Gold' }).success, false);
  assert.equal(updateCoverageSchema.safeParse({ planName: 'PPO Gold' }).success, false);
});

test('Fix 2 — benefitOrder is no longer accepted on create or update', () => {
  assert.equal(createCoverageSchema.safeParse({ payerName: 'X', memberId: 'M1', benefitOrder: 'PRIMARY' }).success, false);
  assert.equal(updateCoverageSchema.safeParse({ benefitOrder: 'SECONDARY' }).success, false);
});

test('Fix 2 — fundingSource is no longer accepted on create or update', () => {
  assert.equal(createCoverageSchema.safeParse({ payerName: 'X', memberId: 'M1', fundingSource: 'COMMERCIAL' }).success, false);
  assert.equal(updateCoverageSchema.safeParse({ fundingSource: 'MEDICAID' }).success, false);
});

test('Fix 2 — a create payload with none of the removed fields still succeeds', () => {
  // Proves the removed fields are not REQUIRED — the minimal payload is valid.
  assert.equal(createCoverageSchema.safeParse({ payerName: 'Blue Cross', memberId: 'M1' }).success, true);
});

test('payer and member id are mandatory — coverage without them cannot be billed', () => {
  assert.equal(createCoverageSchema.safeParse({ memberId: 'M1' }).success, false);
  assert.equal(createCoverageSchema.safeParse({ payerName: 'Blue Cross' }).success, false);
});

test('an empty update is refused rather than silently doing nothing', () => {
  assert.equal(updateCoverageSchema.safeParse({}).success, false);
});

// --- the verification endpoint ---------------------------------------------

test('only a real verification outcome may be recorded', () => {
  for (const status of ['PENDING', 'VERIFIED', 'NEEDS_CORRECTION', 'FAILED']) {
    assert.equal(verifyCoverageSchema.safeParse({ status }).success, true, status);
  }
});

test('REGRESSION — states the system derives cannot be asserted by a user', () => {
  // UNVERIFIED is the creation default and EXPIRED is derived from dates.
  // Letting a user assert either would let them rewrite history or fake a
  // reset without attribution.
  assert.equal(verifyCoverageSchema.safeParse({ status: 'EXPIRED' }).success, false);
  assert.equal(verifyCoverageSchema.safeParse({ status: 'UNVERIFIED' }).success, false);
  assert.equal(verifyCoverageSchema.safeParse({ status: 'definitely-verified' }).success, false);
});

// --- authorization ----------------------------------------------------------

test('verifying insurance is a distinct permission from editing it', () => {
  // Recording a verification creates the fact the scheduling gate trusts.
  // Anyone who can type a member id should not thereby be able to assert that
  // a payer confirmed it.
  const keys = PERMISSION_CATALOGUE.map((p) => p.key ?? p);
  assert.ok(keys.includes('clients.verify_insurance'));
  assert.notEqual('clients.verify_insurance', 'clients.update');
});

test('REGRESSION — neither BCBA nor RBT may assert a verification', () => {
  // Blueprint 4.11 gives coverage administration to the operational and
  // billing roles, not the clinical ones. A technician who could verify
  // insurance could open their own scheduling gate.
  for (const role of ['bcba', 'rbt']) {
    const keys = SYSTEM_ROLE_TEMPLATES[role].map((g) => g.key);
    assert.equal(keys.includes('clients.verify_insurance'), false, `${role} must not verify insurance`);
  }
});

test('the company roles retain coverage administration', () => {
  for (const role of ['owner', 'org_admin']) {
    const keys = SYSTEM_ROLE_TEMPLATES[role].map((g) => g.key);
    assert.ok(keys.includes('clients.verify_insurance'), `${role} must be able to verify insurance`);
    assert.ok(keys.includes('clients.update'));
  }
});

// --- response shape ---------------------------------------------------------

test('the response never returns undefined for a collection field', () => {
  // React Query rejects undefined outright. A record with no checks yet must
  // read as an empty history, not as a broken query.
  const shaped = toCoverage({
    _id: 'cov-1', clientId: 'c-1', payerName: 'X', memberId: 'M1',
    benefitOrder: 'PRIMARY', fundingSource: 'COMMERCIAL',
    subscriberRelationship: 'SELF', verificationStatus: 'UNVERIFIED',
  });
  assert.deepEqual(shaped.verificationHistory, []);
  for (const [key, value] of Object.entries(shaped)) {
    assert.notEqual(value, undefined, `${key} is undefined`);
  }
});

test('the shaped response exposes no internal mongo fields', () => {
  const shaped = toCoverage({
    _id: 'cov-1', clientId: 'c-1', payerName: 'X', memberId: 'M1',
    benefitOrder: 'PRIMARY', fundingSource: 'COMMERCIAL',
    subscriberRelationship: 'SELF', verificationStatus: 'UNVERIFIED',
    tenantId: 'org-secret', deletedAt: null, __v: 3,
  });
  assert.equal(shaped.id, 'cov-1');
  assert.equal(shaped._id, undefined);
  // Never hand a tenant identifier to a client — blueprint 11.6.
  assert.equal(shaped.tenantId, undefined);
  assert.equal(shaped.__v, undefined);
});
