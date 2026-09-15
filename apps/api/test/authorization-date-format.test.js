import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toServiceAuth, toDateOnly } from '../src/modules/clients/clients.repository.js';
import { serviceAuthToBookable } from '../src/modules/scheduling/authAdapter.js';
import { formatDate } from '../../web/src/lib/format.js';

/**
 * ---------------------------------------------------------------------------
 * AUTHORIZATION / DOB DATE FORMAT — spec Bugs #3 & #4 (Parts 18–26, 34 #24–28).
 *
 * Root cause of the reported bug: ABA/FBA authorization dates were emitted as
 * raw Date objects, so the API serialized them as full ISO datetimes
 * (2026-08-01T00:00:00.000Z). The web formatDate then read LOCAL calendar parts,
 * which shift a day west of UTC — an authorization stored 08/01/2026 rendered
 * 07/31/2026 in every US timezone. DOB was already correct (date-only), so the
 * two were inconsistent.
 *
 * Fix: every calendar date the API emits (DOB via toClient, authorization
 * start/end via toServiceAuth and the scheduling authAdapter) goes through the
 * SINGLE canonical toDateOnly serializer -> a date-only YYYY-MM-DD string the web
 * formatter renders as MM/DD/YYYY, identically in every timezone.
 *
 * These assertions are timezone-independent by construction: toDateOnly reads
 * UTC parts and formatDate's date-only fast-path reads the string's own digits,
 * so neither depends on the process TZ. The values below are exactly what a US
 * clinic would have seen shifted before the fix.
 * ---------------------------------------------------------------------------
 */

// A calendar date is stored at UTC midnight (the create service does
// `new Date('2026-08-01')`), which is what these Date objects represent.
const AUG_1 = new Date('2026-08-01T00:00:00.000Z');
const SEP_15 = new Date('2026-09-15T00:00:00.000Z');
const DOB = new Date('2015-08-27T00:00:00.000Z');

test('toServiceAuth emits authorization dates as date-only YYYY-MM-DD (never a shiftable datetime)', () => {
  const out = toServiceAuth({
    _id: 'sa-1', clientId: 'c-1', serviceType: 'ABA', status: 'APPROVED',
    authorizationNumber: 'ABA-001', units: 160, usedUnits: 0,
    startDate: AUG_1, endDate: SEP_15, history: [],
  });
  assert.equal(out.startDate, '2026-08-01');
  assert.equal(out.endDate, '2026-09-15');
  // Not a full ISO datetime — that is the exact shape that shifted the day.
  assert.ok(!String(out.startDate).includes('T'));
  assert.ok(!String(out.endDate).includes('T'));
});

test('toServiceAuth leaves missing dates null (UI renders a placeholder, never Invalid Date)', () => {
  const out = toServiceAuth({
    _id: 'sa-2', clientId: 'c-1', serviceType: 'FBA', status: 'NOT_SENT',
    startDate: null, endDate: null, history: [],
  });
  assert.equal(out.startDate, null);
  assert.equal(out.endDate, null);
});

test('scheduling serviceAuthToBookable emits the same date-only window', () => {
  const b = serviceAuthToBookable({
    _id: 'sa-3', clientId: 'c-1', serviceType: 'ABA', status: 'APPROVED',
    units: 160, usedUnits: 0, startDate: AUG_1, endDate: SEP_15,
  });
  assert.equal(b.startDate, '2026-08-01');
  assert.equal(b.endDate, '2026-09-15');
});

test('web formatDate renders the API date-only string as MM/DD/YYYY, timezone-safe', () => {
  const out = toServiceAuth({
    _id: 'sa-4', clientId: 'c-1', serviceType: 'ABA', status: 'APPROVED',
    startDate: AUG_1, endDate: SEP_15, units: 100, usedUnits: 0, history: [],
  });
  assert.equal(formatDate(out.startDate), '08/01/2026');
  assert.equal(formatDate(out.endDate), '09/15/2026');
  // The pre-fix shape (full ISO) is what produced 07/31/2026 in US timezones.
  assert.equal(formatDate(DOB), '08/27/2015'); // and DOB stays consistent
});

test('toDateOnly is the single serializer and is UTC-parts (no day shift for any zone)', () => {
  // Same instant, phrased with a +05:30 offset: still the same UTC calendar day.
  assert.equal(toDateOnly(new Date('2015-01-01T05:30:00.000Z')), '2015-01-01');
  assert.equal(toDateOnly(new Date('2026-08-01T00:00:00.000Z')), '2026-08-01');
  assert.equal(toDateOnly(null), null);
  assert.equal(toDateOnly('not-a-date'), null);
});
