import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStaffWelcomeEmailHandler, STAFF_WELCOME_EMAIL_JOB } from '../src/modules/staff/staff-welcome.email.js';
import { generateTemporaryPassword, assertAcceptablePassword } from '../src/utils/password.js';
import { publicUser } from '../src/modules/auth/auth.service.js';

/**
 * REGRESSION — staff welcome/login email + temporary-password activation.
 * The handler runs against a fake transport (no live email). It pins that the
 * email is addressed to the exact staff login email, contains the login email,
 * the temporary password, the role and a login link, and that the temporary
 * password is delivered ONLY through this email path — never returned or logged.
 */

function fakeTransports() {
  const sent = [];
  return {
    registry: { has: (c) => c === 'email', get: () => ({ send: async (m) => { sent.push(m); } }) },
    sent,
  };
}

test('welcome email is addressed to the staff login email and contains login email + temp password + role + login link', async () => {
  const { registry, sent } = fakeTransports();
  const handler = createStaffWelcomeEmailHandler({ transports: registry, webAppUrl: 'https://app.example.com' });
  await handler({ email: 'bcba@example.com', temporaryPassword: 'Temp0RaryPass', fullName: 'Dana Cole', roleKey: 'bcba' });

  assert.equal(sent.length, 1);
  const msg = sent[0];
  assert.equal(msg.recipientEmail, 'bcba@example.com');
  assert.equal(msg.to, 'bcba@example.com');
  assert.match(msg.view.subject, /Welcome to Abstract ABA/i);
  assert.match(msg.view.body, /bcba@example\.com/); // login email
  assert.match(msg.view.body, /Temp0RaryPass/);     // temporary password
  assert.match(msg.view.body, /BCBA/);              // role label
  assert.match(msg.view.body, /https:\/\/app\.example\.com\/login/); // login link
  assert.match(msg.view.body, /required to change your password/i);  // forced-change instruction
  assert.match(msg.view.body, /Congratulations, Dana!/);
});

test('welcome email fails loudly (worker retries) when no email transport is registered — never a silent success', async () => {
  const handler = createStaffWelcomeEmailHandler({ transports: { has: () => false }, webAppUrl: 'https://app.example.com' });
  await assert.rejects(
    () => handler({ email: 'x@example.com', temporaryPassword: 'Temp0RaryPass', roleKey: 'rbt' }),
    /No email transport registered/,
  );
});

test('welcome email requires a recipient and a temporary password', async () => {
  const { registry } = fakeTransports();
  const handler = createStaffWelcomeEmailHandler({ transports: registry, webAppUrl: 'https://app.example.com' });
  await assert.rejects(() => handler({ email: '', temporaryPassword: 'x' }), /requires a recipient email and temporary password/);
  await assert.rejects(() => handler({ email: 'a@b.com', temporaryPassword: '' }), /requires a recipient email and temporary password/);
});

test('the job type is stable', () => {
  assert.equal(STAFF_WELCOME_EMAIL_JOB, 'staff.welcome_email.deliver');
});

test('generated temporary password satisfies the shared password policy', () => {
  for (let i = 0; i < 50; i += 1) {
    const pw = generateTemporaryPassword();
    assert.doesNotThrow(() => assertAcceptablePassword(pw, {}));
    assert.ok(pw.length >= 10);
  }
});

test('publicUser exposes mustChangePassword (forces first-login change) and never a secret', () => {
  const pub = publicUser({ _id: 'u1', email: 'a@b.com', fullName: 'A B', status: 'ACTIVE', mustChangePassword: true, passwordHash: 'SECRET', passwordResetTokenHash: 'SECRET2' });
  assert.equal(pub.mustChangePassword, true);
  const blob = JSON.stringify(pub);
  assert.ok(!/SECRET|passwordHash|passwordResetTokenHash/.test(blob), 'publicUser must not leak secrets');
});
