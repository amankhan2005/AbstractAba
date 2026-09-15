import { describe, it, expect } from 'vitest';
import { buildEmailPayload } from './emailPayload.js';

/**
 * 12 & 13 — the frontend cannot spoof recipient or sender. The only thing the
 * browser is permitted to send is templateId + edited subject/body; everything
 * authoritative (to, fromEmail, fromName, tenantId, organizationId, companyId)
 * is resolved server-side and must never leave the client.
 */
describe('buildEmailPayload', () => {
  it('returns exactly templateId, subject, body', () => {
    const payload = buildEmailPayload({ templateId: 'child_approved', subject: 'Hi', body: 'Body' });
    expect(Object.keys(payload).sort()).toEqual(['body', 'subject', 'templateId']);
  });

  it('drops any attempt to inject authoritative fields', () => {
    const payload = buildEmailPayload({
      templateId: 't', subject: 's', body: 'b',
      to: 'attacker@evil.com', fromEmail: 'spoof@evil.com', fromName: 'Spoof',
      tenantId: 'other-tenant', organizationId: 'other-org', companyId: 'x',
    });
    expect(payload).toEqual({ templateId: 't', subject: 's', body: 'b' });
    for (const forbidden of ['to', 'fromEmail', 'fromName', 'tenantId', 'organizationId', 'companyId']) {
      expect(payload).not.toHaveProperty(forbidden);
    }
  });
});
