import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThemingService } from '../src/modules/theming/theming.service.js';

/**
 * Phase 2 — backend-derived company branding.
 * getBranding merges the caller's tenant brand tokens (logo/colours) with the
 * organization's name, resolved server-side by tenantId. The frontend never
 * supplies name/logo/tenant. Per-tenant isolation: each tenant gets its own.
 */

function makeService({ tokensByTenant, namesByTenant, orgThrows = false }) {
  return new ThemingService({
    preferences: {},
    branding: { getBrandTokens: async (t) => tokensByTenant[t] ?? {} },
    organizations: { getName: async (t) => { if (orgThrows) throw new Error('down'); return namesByTenant[t] ?? null; } },
  });
}

test('branding includes the tenant company name + logo, resolved by tenantId', async () => {
  const svc = makeService({
    tokensByTenant: { 't-A': { logoUrl: 'https://cdn/a.png', primary: '#A47DAB' } },
    namesByTenant: { 't-A': 'Company A Behavioral' },
  });
  const b = await svc.getBranding('t-A');
  assert.equal(b.name, 'Company A Behavioral');
  assert.equal(b.logoUrl, 'https://cdn/a.png');
});

test('multi-tenant: A and B never mix; each resolves its own name/logo', async () => {
  const svc = makeService({
    tokensByTenant: { 't-A': { logoUrl: 'a.png' }, 't-B': { logoUrl: 'b.png' } },
    namesByTenant: { 't-A': 'Company A', 't-B': 'Company B' },
  });
  const a = await svc.getBranding('t-A');
  const b = await svc.getBranding('t-B');
  assert.equal(a.name, 'Company A'); assert.equal(a.logoUrl, 'a.png');
  assert.equal(b.name, 'Company B'); assert.equal(b.logoUrl, 'b.png');
});

test('fallback: no name and no logo returns nulls (never undefined) so the UI shows the Abstract ABA product mark', async () => {
  const svc = makeService({ tokensByTenant: { 't-C': {} }, namesByTenant: {} });
  const b = await svc.getBranding('t-C');
  assert.equal(b.name, null);
  assert.equal(b.logoUrl ?? null, null);
  assert.ok(!('undefined' in b));
});

test('a name-lookup failure still returns usable branding (no crash)', async () => {
  const svc = makeService({ tokensByTenant: { 't-D': { logoUrl: 'd.png' } }, namesByTenant: {}, orgThrows: true });
  const b = await svc.getBranding('t-D');
  assert.equal(b.name, null);
  assert.equal(b.logoUrl, 'd.png');
});
