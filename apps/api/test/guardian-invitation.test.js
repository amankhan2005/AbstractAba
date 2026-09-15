import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivedStatus, toInvitation } from '../src/modules/clients/guardian-invitation.service.js';
import { guardianInvitationEmail } from '../src/modules/clients/guardian-invitation.email.js';
import { guardianSubmissionSchema, guardianTokenParamsSchema } from '../src/modules/clients/clients.schemas.js';

/**
 * ---------------------------------------------------------------------------
 * GUARDIAN INVITATION — blueprint §2.6 / §6.2.
 *
 * A guardian supplies information about ONE child, once, without an account.
 * §2.6 excludes a family portal; §5.1 records that the underlying need —
 * visibility and signature — is met without one.
 *
 * The link is the only bearer credential in the product held by someone who is
 * not a user, so these tests concentrate on the ways it could leak or be
 * abused rather than on the happy path alone.
 * ---------------------------------------------------------------------------
 */

const HOUR = 60 * 60 * 1000;

// --- PHI in the email -------------------------------------------------------

test('the email carries a first name and nothing else about the child', () => {
  const view = guardianInvitationEmail({
    organizationName: 'Bright Steps ABA',
    childFirstName: 'Mia',
    guardianFirstName: 'Priya',
    link: 'https://portal.example.com/guardian/tok_abc',
    expiresAt: new Date(Date.now() + 14 * 24 * HOUR),
  });

  const everything = `${view.subject}\n${view.body}\n${view.html}`;

  assert.match(everything, /Mia/);
  // Mail travels to an address the clinic cannot control. A surname, a date of
  // birth, a diagnosis or an insurer in the inbox is a disclosure to whoever
  // reads it.
  for (const leak of ['Demo', '2018', 'autism', 'diagnosis', 'Medicaid', 'insurance', 'member']) {
    assert.doesNotMatch(everything, new RegExp(leak, 'i'), `must not mention ${leak}`);
  }
});

test('REGRESSION — the email never says why the child is receiving care', () => {
  // That a named child receives ABA therapy is itself sensitive.
  const view = guardianInvitationEmail({
    organizationName: 'Bright Steps ABA',
    childFirstName: 'Mia',
    link: 'https://portal.example.com/guardian/tok_abc',
    expiresAt: new Date(),
  });
  const everything = `${view.subject}\n${view.body}\n${view.html}`;
  for (const word of ['therapy', 'behaviou?ral', 'treatment', 'session', 'clinical']) {
    assert.doesNotMatch(everything, new RegExp(word, 'i'), `must not mention ${word}`);
  }
});

test('the email escapes names rather than interpolating them into HTML', () => {
  const view = guardianInvitationEmail({
    organizationName: '<script>alert(1)</script>',
    childFirstName: 'A & B',
    link: 'https://portal.example.com/guardian/t',
    expiresAt: new Date(),
  });
  assert.doesNotMatch(view.html, /<script>/);
  assert.match(view.html, /&lt;script&gt;/);
  assert.match(view.html, /A &amp; B/);
});

test('the email tells the family the link is single-use', () => {
  const view = guardianInvitationEmail({
    organizationName: 'Bright Steps ABA',
    childFirstName: 'Mia',
    link: 'https://portal.example.com/guardian/t',
    expiresAt: new Date('2026-09-01'),
  });
  assert.match(view.body, /only be used once/i);
  assert.match(view.body, /ignore it/i, 'an unexpected recipient needs to be told to do nothing');
});

// --- delivery honesty -------------------------------------------------------

test('REGRESSION — a failed send is never reported as sent', () => {
  // The blueprint requirement: never show "Sent successfully" when the
  // transport actually failed.
  const failed = toInvitation({
    _id: 'inv-1', clientId: 'c-1', guardianId: 'g-1', email: 'a@b.co',
    expiresAt: new Date(Date.now() + HOUR),
    deliveryStatus: 'FAILED', deliveryError: 'Invalid sender domain',
  });
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.deliveryError, 'Invalid sender domain');
  assert.notEqual(failed.status, 'SENT');
});

test('delivery state is distinguishable across every outcome', () => {
  const base = { expiresAt: new Date(Date.now() + HOUR) };
  assert.equal(derivedStatus({ ...base, deliveryStatus: 'PENDING' }), 'PENDING');
  assert.equal(derivedStatus({ ...base, deliveryStatus: 'SENT' }), 'SENT');
  assert.equal(derivedStatus({ ...base, deliveryStatus: 'FAILED' }), 'FAILED');
  assert.equal(derivedStatus({ ...base, consumedAt: new Date() }), 'COMPLETED');
  assert.equal(derivedStatus({ ...base, revokedAt: new Date() }), 'REVOKED');
  assert.equal(derivedStatus({ expiresAt: new Date(Date.now() - HOUR) }), 'EXPIRED');
});

test('a completed invitation outranks its delivery state', () => {
  // Once the family has submitted, "sent" is no longer the interesting fact.
  assert.equal(derivedStatus({
    expiresAt: new Date(Date.now() + HOUR),
    deliveryStatus: 'SENT',
    consumedAt: new Date(),
  }), 'COMPLETED');
});

test('an expired-but-unconsumed invitation reads as expired, not pending', () => {
  assert.equal(derivedStatus({
    expiresAt: new Date(Date.now() - HOUR),
    deliveryStatus: 'SENT',
  }), 'EXPIRED');
});

// --- the token never leaves the server --------------------------------------

test('REGRESSION — no response shape ever carries the token or its digest', () => {
  const shaped = toInvitation({
    _id: 'inv-1', clientId: 'c-1', guardianId: 'g-1', email: 'a@b.co',
    tokenHash: 'deadbeef'.repeat(8),
    organizationId: 'org-secret',
    tenantId: 'org-secret',
    expiresAt: new Date(),
  });
  assert.equal(shaped.tokenHash, undefined, 'the digest must not leave the server');
  assert.equal(shaped.token, undefined);
  // A tenant identifier is never handed to a client (blueprint 11.6).
  assert.equal(shaped.tenantId, undefined);
  assert.equal(shaped.organizationId, undefined);
  assert.equal(shaped._id, undefined);
  assert.equal(shaped.id, 'inv-1');
});

// --- the guardian submission is an allowlist --------------------------------

test('REGRESSION — a guardian cannot assert an insurance verification', () => {
  // Recording a verification is a staff act guarded by
  // clients.verify_insurance. If a family could assert it through their own
  // submission, the scheduling gate would be in the hands of the people it
  // exists to protect.
  assert.equal(guardianSubmissionSchema.safeParse({
    phone: '555-0100', verificationStatus: 'VERIFIED',
  }).success, false);
});

test('REGRESSION — a guardian cannot reach clinical or child-record fields', () => {
  for (const forbidden of [
    { diagnosis: 'F84.0' },
    { clientId: 'another-child' },
    { status: 'ACTIVE' },
    { tenantId: 'another-org' },
    { isPrimary: true },
  ]) {
    assert.equal(
      guardianSubmissionSchema.safeParse({ phone: '555-0100', ...forbidden }).success,
      false,
      `${Object.keys(forbidden)[0]} must be rejected`,
    );
  }
});

test('a guardian may correct their own contact details', () => {
  const result = guardianSubmissionSchema.safeParse({
    phone: '555-0100',
    email: 'parent@example.com',
    addressLine1: '12 Oak Street',
    city: 'Springfield',
    state: 'IL',
    postalCode: '62704',
  });
  assert.equal(result.success, true, result.success ? '' : JSON.stringify(result.error.issues));
});

test('an empty submission is refused rather than consuming the link for nothing', () => {
  assert.equal(guardianSubmissionSchema.safeParse({}).success, false);
});

// --- token shape ------------------------------------------------------------

test('an implausibly short token is rejected before any lookup', () => {
  assert.equal(guardianTokenParamsSchema.safeParse({ token: 'abc' }).success, false);
  assert.equal(guardianTokenParamsSchema.safeParse({ token: '' }).success, false);
  assert.equal(
    guardianTokenParamsSchema.safeParse({ token: 'a'.repeat(43) }).success,
    true,
    'a 32-byte base64url token is 43 characters',
  );
});
