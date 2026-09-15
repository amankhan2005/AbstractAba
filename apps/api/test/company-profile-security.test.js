import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrganizationService } from '../src/modules/organization/organization.service.js';
import { updateProfileSchema } from '../src/modules/organization/organization.schemas.js';

/**
 * Company Profile security — Parts 19, 23, 32.
 *
 * These are code-verified invariants (no DB): the profile projection sent to the
 * browser must not leak platform/config secrets, and the update contract must
 * make it impossible for the browser to target a different tenant.
 */

const ORG_WITH_SECRETS = {
  id: 'org-1',
  slug: 'bright-aba',
  tradingName: 'Bright ABA',
  legalName: 'Bright ABA LLC',
  state: 'ACTIVE',
  countryCode: 'US',
  stateCode: 'TX',
  timezone: 'America/Chicago',
  locale: 'en-US',
  primaryContactName: 'Dana Lee',
  primaryContactEmail: 'dana@bright.test',
  contactPhone: '555-0100',
  contactEmail: 'hello@bright.test',
  websiteUrl: 'https://bright.test',
  addressLine1: '12 Oak St',
  addressLine2: null,
  city: 'Austin',
  postalCode: '78701',
  version: 4,
  // Sensitive platform/config that must never reach a tenant client:
  kmsKeyArn: 'arn:aws:kms:us-east-1:secret',
  storagePrefix: 'tenants/org-1/private',
  agreementId: 'agr-123',
  customDomain: 'secret.internal',
  parentOrganizationId: 'org-parent',
  createdBy: 'user-9',
  updatedBy: 'user-9',
};

test('company profile projection exposes display fields and omits sensitive config (Parts 23/32)', () => {
  const profile = OrganizationService.toProfile(ORG_WITH_SECRETS);

  // Display fields the Company Profile page needs are present.
  for (const key of ['tradingName', 'legalName', 'primaryContactName', 'primaryContactEmail', 'contactPhone', 'contactEmail', 'websiteUrl', 'addressLine1', 'city', 'postalCode', 'state', 'version']) {
    assert.ok(key in profile, `expected profile to expose ${key}`);
  }

  // Secrets and internal wiring must be absent.
  for (const secret of ['kmsKeyArn', 'storagePrefix', 'agreementId', 'customDomain', 'parentOrganizationId', 'createdBy', 'updatedBy']) {
    assert.equal(secret in profile, false, `profile must NOT expose ${secret}`);
  }
});

test('profile update contract cannot be pointed at another tenant (Part 19)', () => {
  // Even if a malicious browser sends organizationId/id/tenantId in the body,
  // the schema strips unknown keys, so only whitelisted display fields survive.
  const parsed = updateProfileSchema.parse({
    tradingName: 'Renamed',
    organizationId: 'some-other-org',
    id: 'another-org',
    tenantId: 'x',
    state: 'DESTROYED',
    kmsKeyArn: 'inject',
  });
  assert.deepEqual(parsed, { tradingName: 'Renamed' });
});

test('profile update contract cannot change the primary (login) email (Part 12/22)', () => {
  // Even if a crafted request includes primaryContactEmail, it is not part of
  // the schema and zod strips it — the login identity can never be changed here.
  const parsed = updateProfileSchema.parse({
    tradingName: 'Renamed',
    primaryContactEmail: 'attacker@evil.test',
    contactEmail: 'public@bright.test', // the editable public address survives
  });
  assert.equal('primaryContactEmail' in parsed, false);
  assert.equal(parsed.contactEmail, 'public@bright.test');
  assert.equal(parsed.tradingName, 'Renamed');
});

test('profile update requires at least one field', () => {
  assert.throws(() => updateProfileSchema.parse({}));
});
