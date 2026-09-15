import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changePasswordSchema } from '../src/modules/auth/auth.controller.js';

test('changePasswordSchema requires a current password and a >=10 char new password', () => {
  assert.equal(changePasswordSchema.safeParse({ currentPassword: 'x', newPassword: 'short' }).success, false);
  assert.equal(changePasswordSchema.safeParse({ currentPassword: '', newPassword: 'longenough10' }).success, false);
  assert.equal(changePasswordSchema.safeParse({ currentPassword: 'x', newPassword: 'longenough10' }).success, true);
});
