import { test } from 'node:test';
import assert from 'node:assert/strict';
import { US_STATES, US_STATE_CODES, usStateName, isUsStateCode } from '@aba1on1/schemas';
import { US_STATE_CODES as ENUM_CODES } from '../src/models/enums.js';
import { createOrganizationSchema, updateProfileSchema } from '../src/modules/organization/organization.schemas.js';

/**
 * Spec Module 5.2 — ONE canonical US-state source, full names in selectors. The
 * API enums re-export the shared list, so there is a single set both the server
 * and both front-ends validate/display against.
 */

test('canonical source has the 50 states + DC and full display names', () => {
  assert.equal(US_STATES.length, 51);
  assert.equal(usStateName('CA'), 'California');
  assert.equal(usStateName('NJ'), 'New Jersey');
  assert.equal(usStateName('ny'), 'New York', 'case-insensitive');
});

test('the API enums re-export the exact canonical set (no divergent copy)', () => {
  assert.deepEqual([...ENUM_CODES].sort(), [...US_STATE_CODES].sort());
});

test('isUsStateCode accepts canonical codes and rejects junk', () => {
  assert.equal(isUsStateCode('tx'), true);
  assert.equal(isUsStateCode('ZZ'), false);
  assert.equal(isUsStateCode(''), false);
});

test('onboarding accepts multiple operating states and de-duplicates + uppercases', () => {
  const parsed = createOrganizationSchema.parse({
    slug: 'acme-aba', legalName: 'Acme ABA', tradingName: 'Acme',
    countryCode: 'US', timezone: 'America/Los_Angeles',
    primaryContactName: 'Jo Owner', primaryContactEmail: 'jo@acme.test',
    serviceStates: ['ca', 'CA', 'tx'],
  });
  assert.deepEqual(parsed.serviceStates.sort(), ['CA', 'TX']);
});

test('company settings can update operating states; an invalid code is rejected', () => {
  const ok = updateProfileSchema.parse({ serviceStates: ['FL', 'ny'] });
  assert.deepEqual(ok.serviceStates.sort(), ['FL', 'NY']);
  assert.equal(updateProfileSchema.safeParse({ serviceStates: ['ZZ'] }).success, false);
});
