import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_ROLE_TEMPLATES } from '../src/modules/rbac/roleTemplates.js';

/**
 * Insurance claim generation 403 — root cause + fix. POST /claims/billing/generate
 * previously required `claims.write`, which per the role templates ONLY
 * billing_staff holds. The Company Admin (org_admin) and Owner insurance-billing
 * roles hold `claims.read` + `claims.manage` but NOT `claims.write`, so the
 * Company Admin workflow 403'd. The route now requires `claims.manage`, an
 * existing permission those admins already have — no migration, least privilege
 * preserved (clinicians/schedulers still cannot generate).
 */
const keysOf = (role) => new Set((SYSTEM_ROLE_TEMPLATES[role] ?? []).map((p) => p.key));

test('root cause — org_admin and owner do NOT have claims.write (only billing_staff does)', () => {
  assert.equal(keysOf('org_admin').has('claims.write'), false);
  assert.equal(keysOf('owner').has('claims.write'), false);
  assert.equal(keysOf('billing_staff').has('claims.write'), true);
});

test('fix — org_admin, owner and billing_staff all hold claims.manage (the new gate)', () => {
  assert.equal(keysOf('org_admin').has('claims.manage'), true);
  assert.equal(keysOf('owner').has('claims.manage'), true);
  assert.equal(keysOf('billing_staff').has('claims.manage'), true);
});

test('least privilege — clinicians and scheduler cannot generate claims', () => {
  for (const role of ['bcba', 'rbt', 'scheduler', 'receptionist']) {
    assert.equal(keysOf(role).has('claims.manage'), false, `${role} must not have claims.manage`);
    assert.equal(keysOf(role).has('claims.write'), false, `${role} must not have claims.write`);
  }
});

test('the generate route is declared with requirePermission(claims.manage)', async () => {
  // Guard against a silent regression back to claims.write on this route.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('../src/modules/claims/claims.routes.js', import.meta.url)), 'utf8');
  const line = src.split('\n').find((l) => l.includes("'/billing/generate'"));
  assert.ok(line && /requirePermission\('claims\.manage'\)/.test(line), 'billing/generate must require claims.manage');
});
