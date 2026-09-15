import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Spec §1 — Subscription is its own page; Billing is insurance/clinical billing
 * only. Both read the SAME real fetchMySubscription data source (no hardcoding).
 */
const sub = vi.hoisted(() => ({ value: null }));
vi.mock('@/api/client', () => ({
  fetchMySubscription: vi.fn(() => Promise.resolve(sub.value)),
  fetchMyInvoices: vi.fn(() => Promise.resolve([])),
  fetchMyPayments: vi.fn(() => Promise.resolve([])),
  fetchMyBalance: vi.fn(() => Promise.resolve({ outstanding: 0, openInvoiceCount: 0 })),
}));

import { SubscriptionPage } from './SubscriptionPage.jsx';
import { BillingPage } from './BillingPage.jsx';

let container; let root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); });
afterEach(() => { act(() => root?.unmount()); container?.remove(); root = undefined; });

async function mount(Comp) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  await act(async () => {
    root.render(<QueryClientProvider client={qc}><MemoryRouter><Comp /></MemoryRouter></QueryClientProvider>);
    await Promise.resolve();
  });
  for (let i = 0; i < 10; i += 1) { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
}

describe('Subscription page (spec §1)', () => {
  it('shows the real assigned package (name, price, status) from fetchMySubscription', async () => {
    sub.value = { planName: 'Growth', amount: 29900, currency: 'usd', billingInterval: 'MONTHLY', effectiveStatus: 'ACTIVE', startDate: '2026-01-01', renewalDate: '2027-01-01' };
    await mount(SubscriptionPage);
    expect(container.textContent).toContain('Subscription');
    expect(container.textContent).toContain('Growth');
    expect(container.textContent).toContain('Active');
  });

  it('shows an empty state (no fake package) when there is no subscription', async () => {
    sub.value = null;
    await mount(SubscriptionPage);
    expect(container.textContent).toMatch(/No active subscription/i);
  });
});

const DAY = 86400000;
const facts = (c) => Object.fromEntries([...c.querySelectorAll('.rx-sub__fact')].map((f) => [f.querySelector('dt').textContent, f.querySelector('dd').textContent]));
const rows = (c, label) => Object.fromEntries([...c.querySelectorAll(`dl[aria-label="${label}"] .rx-sub__row`)].map((r) => [r.querySelector('dt').textContent, r.querySelector('dd').textContent]));
const NO_CURRENCY_WORDS = /USD|US\$|US Dollar|Dollars?\b/i;

describe('Subscription page — sections in the Staff / Client / Sessions design language', () => {
  it('Current plan: package, billing cycle, price, status, renewal date and remaining days from the API', async () => {
    const now = Date.now();
    sub.value = { planName: 'Growth', amount: 29900, currency: 'usd', billingInterval: 'MONTHLY', effectiveStatus: 'ACTIVE', status: 'ACTIVE',
      startDate: new Date(now - 10 * DAY).toISOString(), renewalDate: new Date(now + 20 * DAY + 3600000).toISOString(), cancelAtPeriodEnd: false,
      plan: { name: 'Growth', description: 'For growing clinics', monthlyPrice: 34900, yearlyPrice: 349000, currency: 'usd', trialDays: 14, features: ['Scheduling', 'Insurance billing'], limits: { maxStaff: 25 } } };
    await mount(SubscriptionPage);
    // Same page header as Staff / Client.
    expect(container.querySelector('.rx-st__head .rx-st__title').textContent).toBe('Subscription');
    expect(container.querySelector('.rx-sub__plan-name').textContent).toBe('Growth');
    expect(container.textContent).toContain('For growing clinics');
    expect(container.querySelector('.rx-sub__price').textContent).toBe('$299/ month'); // the subscription's own snapshot price
    expect(facts(container)).toEqual({
      'Current package': 'Growth', 'Billing cycle': 'Monthly', Price: '$299 / month', Status: 'Active',
      'Renewal date': expect.stringMatching(/^\d{2}\/\d{2}\/\d{4}$/), 'Remaining days': '20 days',
    });
    const billing = rows(container, 'Billing details');
    expect(billing.Amount).toBe('$299 / month');
    expect(billing['Package trial period']).toBe('14 days');
    expect(container.textContent).toMatch(/Renews in 20 days/);
    expect(container.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')).toBe('33');
    expect(container.querySelector('ul[aria-label="Plan features"]').textContent).toContain('Insurance billing');
    expect(rows(container, 'Plan limits')).toEqual({ 'Max staff': '25' });
    expect(container.textContent).not.toMatch(/Upgrade|Buy now|Choose plan/i); // management page, not marketing
  });

  it('money shows the dollar sign only — never a currency code or name', async () => {
    const now = Date.now();
    sub.value = { planName: 'Professional', amount: 49950, currency: 'usd', billingInterval: 'YEARLY', effectiveStatus: 'ACTIVE',
      startDate: new Date(now - DAY).toISOString(), renewalDate: new Date(now + 300 * DAY).toISOString(), plan: { name: 'Professional', features: [], limits: {} } };
    await mount(SubscriptionPage);
    expect(container.querySelector('.rx-sub__price').textContent).toBe('$499.50/ year');
    expect(facts(container).Price).toBe('$499.50 / year');
    expect(container.textContent).not.toMatch(NO_CURRENCY_WORDS);
    const { formatSubscriptionPrice } = await import('./subscription.jsx');
    expect([formatSubscriptionPrice(9900), formatSubscriptionPrice(120000), formatSubscriptionPrice(49999), formatSubscriptionPrice(null)]).toEqual(['$99', '$1,200', '$499.99', null]);
  });

  it('shows only sections the data supports: no invented features or limits; annual cycle', async () => {
    const now = Date.now();
    sub.value = { planName: 'Basic', amount: 99000, currency: 'usd', billingInterval: 'YEARLY', effectiveStatus: 'EXPIRING_SOON', status: 'ACTIVE',
      startDate: new Date(now - 360 * DAY).toISOString(), renewalDate: new Date(now + 2 * DAY + 60000).toISOString(),
      plan: { name: 'Basic', description: null, features: [], limits: {}, trialDays: 0 } };
    await mount(SubscriptionPage);
    expect(facts(container)['Billing cycle']).toBe('Annual');
    expect(facts(container).Status).toBe('Expiring soon');
    expect(container.querySelector('.rx-sub__price').textContent).toBe('$990/ year');
    expect(container.textContent).not.toMatch(/Plan limits|Plan details/);
    expect(rows(container, 'Billing details')['Package trial period']).toBeUndefined();
    expect(container.textContent).not.toMatch(NO_CURRENCY_WORDS);
  });

  it('expired subscription: Expired badge, end date, 0 remaining days, no countdown', async () => {
    const now = Date.now();
    sub.value = { planName: 'Growth', amount: 29900, currency: 'usd', billingInterval: 'MONTHLY', effectiveStatus: 'EXPIRED', expired: true,
      startDate: new Date(now - 40 * DAY).toISOString(), renewalDate: new Date(now - 10 * DAY).toISOString(), plan: null };
    await mount(SubscriptionPage);
    const f = facts(container);
    expect(f.Status).toBe('Expired');
    expect(f['End date']).toMatch(/\d{4}$/);
    expect(f['Remaining days']).toBe('0 days');
    expect(container.textContent).toContain('This subscription has expired.');
    expect(container.textContent).not.toMatch(/Renews in/);
  });

  it('shows when the subscription will not renew (cancel at period end)', async () => {
    const now = Date.now();
    sub.value = { planName: 'Growth', amount: 29900, billingInterval: 'MONTHLY', effectiveStatus: 'ACTIVE', cancelAtPeriodEnd: true,
      startDate: new Date(now - DAY).toISOString(), renewalDate: new Date(now + 29 * DAY).toISOString(), plan: null };
    await mount(SubscriptionPage);
    expect(container.textContent).toMatch(/will not renew/);
  });

  it('error state offers a retry', async () => {
    const api = await import('@/api/client');
    api.fetchMySubscription.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    await mount(SubscriptionPage);
    expect(container.textContent).toMatch(/couldn’t load your subscription/);
    expect([...container.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Retry')).toBe(true);
  });
});

describe('Billing page no longer owns Subscription (spec §1/§92)', () => {
  it('renders insurance/clinical billing without the Subscription card', async () => {
    sub.value = { planName: 'Growth', amount: 29900, effectiveStatus: 'ACTIVE' };
    await mount(BillingPage);
    expect(container.textContent).toContain('Billing');
    expect(container.textContent).toContain('Outstanding balance');
    // The Subscription card/plan must not appear on Billing anymore.
    expect(container.textContent).not.toContain('Subscription');
    expect(container.textContent).not.toContain('Growth');
  });
});
