import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDate } from '../src/utils/format.js';

// The server renders user-facing dates in emails (company invitation expiry,
// etc.). They must match the web app: MM/DD/YYYY, with safe fallbacks — never a
// raw ISO string, "Invalid Date", null, undefined, or NaN.

test('formats a date value as MM/DD/YYYY', () => {
  assert.equal(formatDate(new Date('2026-08-27T12:00:00Z')), '08/27/2026');
  assert.equal(formatDate(new Date('2026-01-05T09:30:00Z')), '01/05/2026');
});

test('formats an ISO string, not passing it through raw', () => {
  const out = formatDate('2026-12-31T23:59:59.000Z');
  assert.equal(out, '12/31/2026');
  assert.ok(!out.includes('T'));
  assert.ok(!out.includes('-'));
});

test('nullish / unparseable input yields a safe empty fallback (never Invalid Date / NaN)', () => {
  for (const bad of [null, undefined, '', 'not-a-date']) {
    const out = formatDate(bad);
    assert.equal(out, '');
    assert.ok(!/Invalid Date|NaN|null|undefined/.test(out));
  }
});
