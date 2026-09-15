import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBrandedEmail, escapeHtml, formatDate } from '../src/common/email/layout.js';
import { createStaffWelcomeEmailHandler } from '../src/modules/staff/staff-welcome.email.js';

/**
 * Email system — Part 24. The shared layout and each redesigned transactional
 * template must be structurally email-safe (table layout, preheader, no JS/no
 * external fonts), carry a real CTA, use MM/DD/YYYY for any date, and never leak
 * secrets. Delivery runs against a fake transport — no live email.
 */

function fakeTransports() {
  const sent = [];
  return { registry: { has: (c) => c === 'email', get: () => ({ send: async (m) => { sent.push(m); } }) }, sent };
}

// ---- shared layout --------------------------------------------------------

test('branded layout produces email-client-safe HTML (table, preheader, no JS/webfonts)', () => {
  const html = renderBrandedEmail({
    preheader: 'Preview line',
    heading: 'Welcome',
    intro: ['Line one.'],
    cta: { label: 'Do it', url: 'https://app.aba1on1.test/go' },
    infoRows: [{ label: 'Role', value: 'BCBA' }],
    noticeTitle: 'Note',
    notice: ['Be careful.'],
  });
  assert.match(html, /role="presentation"/); // table-based
  assert.match(html, /Preview line/);        // preheader present
  assert.match(html, /https:\/\/app\.aba1on1\.test\/go/); // CTA url
  assert.match(html, /Do it/);               // CTA label
  assert.doesNotMatch(html, /<script/i);     // no JS
  assert.doesNotMatch(html, /<style/i);      // no embedded CSS block
  assert.doesNotMatch(html, /fonts\.googleapis|@import|href="https:\/\/fonts/); // no external fonts
});

test('layout escapes caller content and refuses non-http(s) CTA URLs (XSS-safe)', () => {
  const html = renderBrandedEmail({
    heading: '<script>alert(1)</script> & friends',
    intro: ['<b>hi</b>'],
    cta: { label: 'Click', url: 'javascript:alert(1)' },
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp; friends/);
  assert.doesNotMatch(html, /href="javascript:/i); // dangerous scheme collapsed to '#'
});

test('layout omits empty info rows rather than rendering blanks', () => {
  const html = renderBrandedEmail({ heading: 'X', infoRows: [{ label: 'Phone', value: '' }, { label: 'Role', value: 'RBT' }] });
  assert.doesNotMatch(html, /Phone/);
  assert.match(html, /Role/);
});

test('escapeHtml and formatDate helpers behave', () => {
  assert.equal(escapeHtml('<a>&"\''), '&lt;a&gt;&amp;&quot;&#39;');
  assert.equal(formatDate('2026-08-27T12:00:00Z'), '08/27/2026');
  assert.equal(formatDate(null), '');
});

// ---- staff welcome (redesigned) ------------------------------------------

test('staff welcome email is branded, carries the CTA, and leaks no secrets', async () => {
  const { registry, sent } = fakeTransports();
  const handler = createStaffWelcomeEmailHandler({ transports: registry, webAppUrl: 'https://app.example.com' });
  await handler({ email: 'bcba@example.com', temporaryPassword: 'Temp0RaryPass', fullName: 'Dana Cole', roleKey: 'bcba' });

  const { view } = sent[0];
  // Branded HTML present (redesign) with the login CTA and required structure.
  assert.match(view.html, /role="presentation"/);
  assert.match(view.html, /https:\/\/app\.example\.com\/login/);
  assert.match(view.html, /Temp0RaryPass/); // intentional temporary credential
  // Plain-text fallback retained.
  assert.ok(view.body && view.body.length > 0);
  // No hashes/tokens/keys/db-ish internals leak into either representation.
  const blob = `${view.subject}\n${view.body}\n${view.html}`;
  assert.doesNotMatch(blob, /passwordHash|tokenHash|apiKey|RESEND_|mongodb:\/\/|Bearer\s/i);
});

// ---- Abstract ABA rebrand --------------------------------------------------

test('every branded email uses Abstract ABA with the provider and support footer — never ABA1ON1', async () => {
  const html = renderBrandedEmail({ heading: 'Hello' });
  assert.match(html, /Abstract ABA/);
  assert.match(html, /Product of WebieApp Solutions LLC/);
  assert.match(html, /mailto:info@abstractaba\.com/);
  assert.doesNotMatch(html, /ABA1ON1/i);

  const { registry, sent } = fakeTransports();
  const handler = createStaffWelcomeEmailHandler({ transports: registry, webAppUrl: 'https://app.example.com' });
  await handler({ email: 'rbt@example.com', temporaryPassword: 'Temp0RaryPass', fullName: 'Nia Patel', roleKey: 'rbt' });
  const { view } = sent[0];
  assert.equal(view.subject, 'Welcome to Abstract ABA — Your Staff Account Is Ready');
  assert.match(view.html, /Sign in to Abstract ABA/);
  assert.doesNotMatch(`${view.subject}\n${view.body}\n${view.html}`, /ABA1ON1/i);
});

test('company invitation email without a company name falls back to the Abstract ABA subject', async () => {
  const { createCompanyInvitationDeliveryHandler } = await import('../src/modules/company-invitations/company-invitation.routes.js');
  const { registry, sent } = fakeTransports();
  const handler = createCompanyInvitationDeliveryHandler({ transports: registry, webAppUrl: 'https://app.example.com' });
  await handler({ email: 'owner@example.com', token: 'tok-1234567890', expiresAt: new Date(Date.now() + 3600_000) });
  const { view } = sent[0];
  assert.equal(view.subject, 'Welcome to Abstract ABA — Complete Your Setup');
  assert.match(view.html, /Welcome to Abstract ABA/);
  assert.match(view.body, /created on Abstract ABA/);
  assert.doesNotMatch(`${view.subject}\n${view.body}\n${view.html}`, /ABA1ON1/i);
});

test('Resend sender display name defaults to Abstract ABA when RESEND_FROM_NAME is not set', async () => {
  const saved = process.env.RESEND_FROM_NAME;
  delete process.env.RESEND_FROM_NAME;
  try {
    const { env } = await import(`../src/config/env.js?brand=${Date.now()}`);
    assert.equal(env.email?.fromName ?? env.resend?.fromName, 'Abstract ABA');
  } finally {
    if (saved !== undefined) process.env.RESEND_FROM_NAME = saved;
  }
});
