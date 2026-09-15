import { describe, it, expect } from 'vitest';
import { buildInvitePayload } from './InviteCompanyWizard.jsx';

/**
 * The Invite Company flow must send only the human fields the backend invite
 * endpoint accepts ({ companyName, contactName, email }) — no slug, legalName,
 * countryCode or timezone. The owner supplies those during onboarding.
 */
describe('buildInvitePayload', () => {
  it('maps owner first+last into a single contactName', () => {
    const p = buildInvitePayload({ companyName: 'ABC Health', ownerFirst: 'Aman', ownerLast: 'Khan', ownerEmail: 'Aman@Company.com' });
    expect(p).toEqual({ companyName: 'ABC Health', contactName: 'Aman Khan', email: 'aman@company.com' });
  });
  it('trims and lowercases the email', () => {
    expect(buildInvitePayload({ companyName: ' X ', ownerFirst: ' A ', ownerLast: ' B ', ownerEmail: '  Owner@X.COM ' }))
      .toEqual({ companyName: 'X', contactName: 'A B', email: 'owner@x.com' });
  });
  it('never includes technical fields', () => {
    const p = buildInvitePayload({ companyName: 'X', ownerFirst: 'A', ownerLast: 'B', ownerEmail: 'a@b.co' });
    for (const k of ['slug', 'legalName', 'countryCode', 'timezone']) expect(p).not.toHaveProperty(k);
  });
});
