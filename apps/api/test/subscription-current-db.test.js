import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

/**
 * COMPANY SUBSCRIPTION PAGE data — GET /v1/billing/subscription.
 *
 * The page shows the organization's real assigned package: the subscription's
 * own price/name snapshot plus the package's descriptive details (description,
 * features, trial days, limits only when defined). Pinned against a real
 * MongoDB, with the tenant route reading the organization from the token only.
 */
const CANDIDATES = [process.env.MONGOMS_SYSTEM_BINARY, '/opt/homebrew/bin/mongod', '/usr/local/bin/mongod', '/usr/bin/mongod'].filter(Boolean);
const MONGOD = CANDIDATES.find((p) => existsSync(p)) ?? null;
const skip = MONGOD ? false : 'no local mongod binary (set MONGOMS_SYSTEM_BINARY)';
const NOW = new Date('2026-09-14T12:00:00Z');

let server; let mongoose; let M; let withPlatform; let BillingService; let createBillingRouters;
const W = {};

before(async () => {
  if (skip) return;
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  server = await MongoMemoryServer.create({ binary: { systemBinary: MONGOD } });
  mongoose = (await import('mongoose')).default;
  await mongoose.connect(server.getUri());
  M = await import('../src/models/index.js');
  ({ withPlatform } = await import('../src/tenancy/tenantContext.js'));
  ({ BillingService } = await import('../src/modules/billing/billing.service.js'));
  ({ createBillingRouters } = await import('../src/modules/billing/billing.routes.js'));
  await withPlatform(async () => {
    W.growth = (await M.SubscriptionPlan.create({ code: 'growth', name: 'Growth', description: 'For growing clinics', monthlyPrice: 34900, yearlyPrice: 349000, currency: 'usd', trialDays: 14, features: ['Scheduling', 'Insurance billing', '  '], limits: { staff: 25, clients: 'Unlimited', nested: { x: 1 }, empty: '' } }))._id;
    W.basic = (await M.SubscriptionPlan.create({ code: 'basic', name: 'Basic', monthlyPrice: 9900, yearlyPrice: 99000, currency: 'usd' }))._id;
    // Org A: snapshot taken when Growth cost 299.00; the plan price has since risen.
    await M.Subscription.create({ organizationId: 'org-a', planId: W.growth, planName: 'Growth', unitAmount: 29900, currency: 'usd', status: 'ACTIVE', billingInterval: 'MONTHLY',
      currentPeriodStart: new Date('2026-09-01T00:00:00Z'), currentPeriodEnd: new Date('2026-10-01T00:00:00Z'), cancelAtPeriodEnd: true });
    await M.Subscription.create({ organizationId: 'org-b', planId: W.basic, planName: 'Basic', unitAmount: 99000, currency: 'usd', status: 'ACTIVE', billingInterval: 'YEARLY',
      currentPeriodStart: new Date('2025-09-01T00:00:00Z'), currentPeriodEnd: new Date('2026-09-10T00:00:00Z') });
  });
});
after(async () => { if (skip) return; await mongoose?.disconnect(); await server?.stop(); });

test('current subscription: snapshot price and name, real plan details, live days remaining', { skip }, async () => {
  const svc = new BillingService({});
  const sub = await svc.getCurrentSubscription('org-a', NOW);
  assert.equal(sub.planName, 'Growth');
  assert.equal(sub.amount, 29900, 'historical snapshot, not the current plan price');
  assert.equal(sub.billingInterval, 'MONTHLY');
  assert.equal(sub.effectiveStatus, 'ACTIVE');
  assert.equal(sub.daysRemaining, 16);
  assert.equal(sub.cancelAtPeriodEnd, true);
  assert.deepEqual(sub.plan, {
    name: 'Growth', description: 'For growing clinics', monthlyPrice: 34900, yearlyPrice: 349000, currency: 'usd', trialDays: 14,
    features: ['Scheduling', 'Insurance billing'],
    limits: { staff: 25, clients: 'Unlimited' },
  });
});

test('a plan without description, features or limits returns empty values, never invented ones; expiry is derived', { skip }, async () => {
  const sub = await new BillingService({}).getCurrentSubscription('org-b', NOW);
  assert.equal(sub.effectiveStatus, 'EXPIRED');
  assert.equal(sub.daysRemaining, 0);
  assert.equal(sub.cancelAtPeriodEnd, false);
  assert.deepEqual([sub.plan.description, sub.plan.features, sub.plan.limits, sub.plan.trialDays], [null, [], {}, 0]);
  assert.equal(await new BillingService({}).getCurrentSubscription('org-none', NOW), null);
});

test('tenant route: organization comes from the token, never from params or query; needs billing.read', { skip }, async () => {
  const { tenant } = createBillingRouters(new BillingService({}));
  const layer = tenant.stack.find((l) => l.route?.path === '/subscription' && l.route.methods.get);
  let denied;
  await layer.route.stack[0].handle({ principal: { permissions: new Set() } }, {}, (e) => { denied = e; });
  assert.match(denied?.message ?? '', /Missing permission: billing\.read/);
  let body; let failure;
  const res = { status() { return this; }, json(b) { body = b; } };
  layer.route.stack[1].handle({ principal: { activeTenantId: 'org-a' }, params: { organizationId: 'org-b' }, query: { organizationId: 'org-b' } }, res, (e) => { failure = e; });
  for (let i = 0; i < 200 && !body && !failure; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(failure, undefined);
  assert.equal(body.data.planName, 'Growth', 'org-a’s own package, despite org-b in the request');
});
