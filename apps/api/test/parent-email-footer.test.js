import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompanyFooter,
  appendCompanyFooter,
  resolveCompanyFooterLines,
} from '../src/modules/clients/company-footer.js';
import { formatPersonName, formatDate } from '../src/utils/format.js';

/**
 * Company email footer — the single, server-side, tenant-resolved signature.
 * These pin the footer-composition contract without a database: the helper is
 * pure and is fed an already-resolved organization document.
 */

const ORG_A = {
  tradingName: 'ABC Behavioral Health',
  legalName: 'ABC Behavioral Health LLC',
  contactPhone: '(555) 123-4567',
  contactEmail: 'support@abcbehavioralhealth.com',
  addressLine1: '123 Main Street',
  city: 'Boston',
  stateCode: 'MA',
  postalCode: '02110',
  countryCode: 'US',
  websiteUrl: 'www.abcbehavioralhealth.com',
};

const ORG_B = {
  tradingName: 'Sunrise ABA',
  contactPhone: '(212) 555-0199',
  contactEmail: 'hello@sunriseaba.example',
};

test('14 — company name appears in the footer', () => {
  const f = buildCompanyFooter(ORG_A);
  assert.equal(f.name, 'ABC Behavioral Health');
  assert.match(f.text, /ABC Behavioral Health/);
  assert.match(f.html, /ABC Behavioral Health/);
});

test('15 — company phone appears when available', () => {
  assert.match(buildCompanyFooter(ORG_A).text, /\(555\) 123-4567/);
});

test('16 — company email appears when available', () => {
  assert.match(buildCompanyFooter(ORG_A).text, /support@abcbehavioralhealth\.com/);
});

test('17 — company address appears when available (single tidy line)', () => {
  const line = resolveCompanyFooterLines(ORG_A).contact.find((l) => l.includes('Main Street'));
  assert.equal(line, '123 Main Street, Boston, MA 02110');
});

test('18 — company website appears when available', () => {
  assert.match(buildCompanyFooter(ORG_A).text, /www\.abcbehavioralhealth\.com/);
});

test('19 — missing fields are omitted cleanly (no empty labels)', () => {
  const f = buildCompanyFooter(ORG_B);
  // Has name + phone + email only; no address/website lines, and crucially no
  // stray "Phone:", "Address:", empty commas, undefined/null.
  assert.match(f.text, /Sunrise ABA/);
  assert.match(f.text, /\(212\) 555-0199/);
  assert.doesNotMatch(f.text, /Address|Website|Phone:|Email:|undefined|null|NaN/);
  // email fallback: ORG_B has no primaryContactEmail, uses contactEmail
  assert.match(f.text, /hello@sunriseaba\.example/);
  // Only name + 2 contact lines.
  assert.equal(resolveCompanyFooterLines(ORG_B).contact.length, 2);
});

test('19b — a bare org (name only) still renders just the name, never undefined', () => {
  const f = buildCompanyFooter({ tradingName: 'Tiny Clinic' });
  assert.equal(resolveCompanyFooterLines({ tradingName: 'Tiny Clinic' }).contact.length, 0);
  assert.match(f.text, /Tiny Clinic/);
  assert.doesNotMatch(f.text, /undefined|null|NaN/);
});

test('20 — company A footer is never company B (tenant isolation at the source)', () => {
  const a = buildCompanyFooter(ORG_A).text;
  const b = buildCompanyFooter(ORG_B).text;
  assert.match(a, /ABC Behavioral Health/);
  assert.doesNotMatch(a, /Sunrise ABA/);
  assert.match(b, /Sunrise ABA/);
  assert.doesNotMatch(b, /ABC Behavioral Health/);
});

test('21 — empty org resolves to a neutral label, not a specific tenant', () => {
  // Platform/Super-Admin emails never call this helper; if ever handed nothing,
  // it must not leak or invent a company identity.
  assert.equal(resolveCompanyFooterLines({}).name, 'Your provider');
});

test('footer values are HTML-escaped (no markup injection)', () => {
  const f = buildCompanyFooter({ tradingName: 'Evil <script>alert(1)</script> Co' });
  assert.doesNotMatch(f.html, /<script>/);
  assert.match(f.html, /&lt;script&gt;/);
});

test('appendCompanyFooter keeps body and adds footer to text AND html (preview == send)', () => {
  const rendered = { subject: 'Hi', text: 'Hello there.', html: '<div>Hello there.</div>', unavailable: [] };
  const out = appendCompanyFooter(rendered, ORG_A);
  assert.match(out.text, /Hello there\./);
  assert.match(out.text, /ABC Behavioral Health/);
  assert.match(out.html, /Hello there\./);
  assert.match(out.html, /ABC Behavioral Health/);
  assert.ok(out.footer && out.footer.name === 'ABC Behavioral Health');
});

/** Part 3 — email presentation follows the product-wide rules. */
test('23 — email names are properly capitalized', () => {
  assert.equal(formatPersonName('aman khan'), 'Aman Khan');
  assert.equal(formatPersonName('AMAN KHAN'), 'Aman Khan');
  assert.equal(formatPersonName('aMAN kHaN'), 'Aman Khan');
});

test('24 — email dates use MM/DD/YYYY', () => {
  assert.equal(formatDate(new Date(2026, 7, 27)), '08/27/2026');
  assert.equal(formatDate(new Date(2026, 8, 8)), '09/08/2026');
  assert.equal(formatDate(null), '');
  assert.equal(formatDate('not-a-date'), '');
});
