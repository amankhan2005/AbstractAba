import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { forgotPasswordSchema, resetPasswordSchema } from '../src/modules/auth/auth.controller.js';
import { hashResetToken, isResetExpired } from '../src/modules/auth/passwordReset.js';
import { assertAcceptablePassword } from '../src/utils/password.js';
import { authorizationService } from '../src/modules/rbac/authorization.service.js';

/**
 * Phase 6 — password management. Self change-password already exists for all
 * roles; here we add the public forgot/reset flow and admin-initiated staff reset.
 * These tests lock the security guarantees that don't need a database.
 */

// --- schemas ----------------------------------------------------------------
test('forgot-password requires a valid email; reset requires a token + >=10 char password', () => {
  assert.equal(forgotPasswordSchema.safeParse({ email: 'not-an-email' }).success, false);
  assert.equal(forgotPasswordSchema.safeParse({ email: 'a@b.com' }).success, true);
  assert.equal(resetPasswordSchema.safeParse({ token: 'short', newPassword: 'longenough10' }).success, false); // token too short
  assert.equal(resetPasswordSchema.safeParse({ token: 'x'.repeat(40), newPassword: 'short' }).success, false); // pw too short
  assert.equal(resetPasswordSchema.safeParse({ token: 'x'.repeat(40), newPassword: 'longenough10' }).success, true);
});

// --- token hygiene: only a hash is ever stored -----------------------------
test('the reset token is stored only as its sha256 hash (raw token never persisted)', () => {
  const raw = crypto.randomBytes(32).toString('base64url');
  const hash = hashResetToken(raw);
  assert.notEqual(hash, raw);                 // never the raw token
  assert.equal(hash.length, 64);              // sha256 hex
  assert.equal(hash, crypto.createHash('sha256').update(raw).digest('hex'));
  assert.equal(hashResetToken(raw), hash);    // deterministic → lookups match
});

// --- expiry / single-use ----------------------------------------------------
test('expiry is enforced: a past expiry is expired, a future one is not, a missing one is expired', () => {
  assert.equal(isResetExpired(new Date(Date.now() - 1000)), true);
  assert.equal(isResetExpired(new Date(Date.now() + 60_000)), false);
  assert.equal(isResetExpired(null), true);   // no token issued → nothing to consume
});

// --- password policy (no weak passwords; policy shared with change-password) -
test('the new password must satisfy the shared policy', () => {
  const ctx = { email: 'jordan@clinic.com', fullName: 'Jordan Vale' };
  assert.throws(() => assertAcceptablePassword('short', ctx));
  assert.doesNotThrow(() => assertAcceptablePassword('brisk-tundra-parcel-90', ctx));
});

// --- RBAC: only Company/Admin can initiate a staff reset --------------------
const perms = (r) => authorizationService.resolvePermissions({ roleKeys: [r], isPlatformOperator: false });
test('admin staff reset is gated by staff.manage — Company/Admin only; BCBA/RBT cannot', () => {
  assert.equal(perms('owner').get('staff.manage'), 'ORGANIZATION');
  assert.equal(perms('org_admin').get('staff.manage'), 'ORGANIZATION');
  assert.equal(perms('bcba').has('staff.manage'), false);  // a BCBA cannot reset another staff member
  assert.equal(perms('rbt').has('staff.manage'), false);   // an RBT cannot reset another staff member
});

// --- regression: the route handlers must actually exist (not undefined) ------
// A Phase-6 refactor once dropped these handler bodies while leaving the schemas
// and route wiring in place, so the endpoints registered but 500'd at request
// time. This locks their presence as exported functions.
import * as authCtrl from '../src/modules/auth/auth.controller.js';

test('the forgot/reset route handlers are exported functions (not undefined)', () => {
  assert.equal(typeof authCtrl.requestPasswordReset, 'function');
  assert.equal(typeof authCtrl.resetPassword, 'function');
  assert.equal(typeof authCtrl.changePassword, 'function');
});
