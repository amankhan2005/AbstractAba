import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { tenantPlugin } from '../src/tenancy/tenantPlugin.js';
import { withTenant, currentScope, TenantContextError } from '../src/tenancy/tenantContext.js';
import { onboardingRepository } from '../src/modules/onboarding/onboarding.repository.js';
import { newId } from '../src/utils/id.js';

/**
 * ============================================================================
 * REGRESSION — onboarding accept: "Refused a tenant-scoped updateOne: no tenant
 * context is active."  (POST /public/company-invitations/:token/accept → 409)
 *
 * ROOT CAUSE. The provisioning writes wrapped the query in a NON-async callback:
 *
 *     withTenant(orgId, () => ProvisioningStep.updateOne(...))   // BUG
 *
 * A Mongoose call is lazy — it builds a Query and returns it WITHOUT executing.
 * AsyncLocalStorage.run() (inside withTenant) keeps the tenant scope only for
 * the synchronous body of the callback plus async work STARTED inside it. The
 * lazy Query starts nothing; run() returns it and the scope is popped. When the
 * caller later awaits the Query, the tenant plugin's pre('updateOne') hook runs
 * with getStore() === undefined and fails closed — the reported 409.
 *
 * FIX. Make the callback async so the Query is awaited INSIDE the scope:
 *
 *     withTenant(orgId, async () => ProvisioningStep.updateOne(...))   // FIXED
 *
 * These tests need no MongoDB: Mongoose query pre-hooks run before any network
 * I/O, so the tenant guard fires (or passes) exactly as it would in production.
 * bufferCommands is disabled so a query that PASSES the guard rejects promptly
 * on "not connected" instead of hanging — a rejection that is NOT the tenant
 * violation proves the context survived to query-execution time.
 * ============================================================================
 */

mongoose.set('bufferCommands', false);

const ORG_A = '11111111-1111-7111-8111-111111111111';
const ORG_B = '22222222-2222-7222-8222-222222222222';

// A faithful stand-in for a tenant-owned model: the REAL tenant plugin, applied
// exactly as every tenant model applies it. A sentinel pre-hook (registered
// AFTER the plugin, so the plugin's guard runs first) records the scope that
// was active when the updateOne hook fired — undefined if the guard threw.
const schema = new mongoose.Schema({
  _id: String, organizationId: String, stepKey: String, state: String, attempts: Number,
});
schema.plugin(tenantPlugin);
let scopeAtHook;
schema.pre('updateOne', function recordScope() { scopeAtHook = currentScope(); });
const Probe = mongoose.model('TenantContextProbe', schema);

const updateArgs = [
  { organizationId: ORG_A, stepKey: 'encryption_key' },
  { $setOnInsert: { _id: 'x', state: 'PENDING', attempts: 0 } },
  { upsert: true },
];

async function runCallback(cb) {
  scopeAtHook = undefined;
  let error;
  try { await withTenant(ORG_A, cb); } catch (e) { error = e; }
  return { scopeAtHook, error };
}

test('TEST 2 — the OLD lazy callback loses tenant context (reproduces the exact 409 violation)', async () => {
  const { scopeAtHook: seen, error } = await runCallback(() => Probe.updateOne(...updateArgs));
  assert.ok(error instanceof TenantContextError, 'lazy form must throw a TenantContextError');
  assert.match(error.message, /no tenant context is active/);
  assert.match(error.message, /tenant-scoped updateOne/); // the precise operation named in the terminal error
  assert.equal(seen, undefined, 'the update hook ran with NO active scope');
});

test('TEST 2 — the FIXED async callback preserves tenant context through updateOne execution', async () => {
  const { scopeAtHook: seen, error } = await runCallback(async () => Probe.updateOne(...updateArgs));
  // The guard PASSED: the sentinel saw the active tenant scope.
  assert.ok(seen, 'the update hook ran WITH an active scope');
  assert.equal(seen.tenantId, ORG_A);
  assert.equal(seen.platform, false);
  // Any resulting error is the absent-DB connection error, never the violation.
  if (error) assert.doesNotMatch(error.message, /no tenant context is active/);
});

test('TEST 2 — the REAL repository.upsertProvisioningStep no longer loses context', async () => {
  let error;
  try {
    await onboardingRepository.upsertProvisioningStep({ id: newId(), organizationId: ORG_A, stepKey: 'encryption_key' });
  } catch (e) { error = e; }
  // Without a DB it rejects on connection; it must NEVER reject with the tenant
  // violation the way the lazy form did.
  if (error) assert.doesNotMatch(error.message, /no tenant context is active/, 'fixed repository must keep tenant context');
});

test('TEST 2 — the REAL repository.markProvisioningStep no longer loses context', async () => {
  let error;
  try {
    await onboardingRepository.markProvisioningStep({ organizationId: ORG_A, stepKey: 'encryption_key', state: 'RUNNING', detail: null, incrementAttempts: true });
  } catch (e) { error = e; }
  if (error) assert.doesNotMatch(error.message, /no tenant context is active/, 'fixed repository must keep tenant context');
});

test('TEST 5 — the tenant plugin fails closed: a cross-tenant probe with no context cannot update another company', async () => {
  // With no withTenant()/withPlatform() at all, the plugin refuses the write —
  // the onboarding route can never become an unscoped cross-tenant write path.
  let error;
  try { await Probe.updateOne({ organizationId: ORG_B }, { $set: { state: 'X' } }); }
  catch (e) { error = e; }
  assert.ok(error instanceof TenantContextError, 'an unscoped tenant write must be refused');
});

test('TEST 4/5 — a caller-supplied tenantId in the filter cannot widen scope (context is authoritative)', async () => {
  // Under withTenant(ORG_A), even a filter that explicitly names ORG_B is
  // overwritten to ORG_A by the plugin — Company A can never touch Company B.
  let filterSeen;
  const s = new mongoose.Schema({ _id: String, v: String });
  s.plugin(tenantPlugin);
  s.pre('updateOne', function () { filterSeen = this.getQuery(); });
  const M = mongoose.model('TenantScopeAuthority', s);
  try {
    await withTenant(ORG_A, async () => M.updateOne({ tenantId: ORG_B, _id: 'z' }, { $set: { v: '1' } }));
  } catch { /* connection error after the hook is fine */ }
  assert.equal(filterSeen.tenantId, ORG_A, 'the context tenant overrides a client-supplied tenantId');
});
