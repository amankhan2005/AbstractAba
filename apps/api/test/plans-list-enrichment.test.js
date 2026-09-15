import test from 'node:test';
import assert from 'node:assert/strict';
import { PlansService } from '../src/modules/plans/plans.service.js';

/**
 * ---------------------------------------------------------------------------
 * THE PLAN ROSTER CARRIES ITS DISPLAY FIELDS.
 *
 * `toPlan` returns `clientId` and `responsibleBcbaStaffId` — never names — and
 * no content counts at all, so the /plans roster could only render a title,
 * status and dates. The cards render each field conditionally, so nothing broke;
 * those rows simply never appeared.
 *
 * The enrichment must be BATCHED. Resolving per row would be an N+1: 25 plans
 * would mean 25 client lookups, 25 staff lookups and 50 content queries. These
 * tests count the calls, so a future change back to per-row resolution fails.
 * ---------------------------------------------------------------------------
 */

const TENANT = 't1';

function makeService({ items }) {
  const calls = { clients: [], staff: [], counts: 0 };
  const service = new PlansService({
    repository: {
      listPlans: async () => ({ items, nextCursor: null }),
      countPlanContent: async (_t, planIds) => {
        calls.counts += 1;
        return new Map(planIds.map((id, i) => [id, { goalCount: i + 1, programCount: i }]));
      },
    },
    clients: {
      findById: async (_t, id) => { calls.clients.push(id); return { id, firstName: 'Raymond', lastName: 'K' }; },
    },
    staff: {
      findById: async (_t, id) => { calls.staff.push(id); return { id, firstName: 'Ben', lastName: 'Carter' }; },
    },
    organizations: { getById: async () => ({ state: 'ACTIVE' }) },
  });
  return { service, calls };
}

const plan = (over = {}) => ({
  id: 'p1', clientId: 'c1', responsibleBcbaStaffId: 's1',
  title: 'Behavior Support', status: 'ACTIVE', effectiveDate: '2026-09-12', ...over,
});

test('the roster carries clientName, bcbaName, goalCount and programCount', async () => {
  const { service } = makeService({ items: [plan()] });
  const { items } = await service.listPlans({ tenantId: TENANT, limit: 25 });

  assert.equal(items[0].clientName, 'Raymond K');
  assert.equal(items[0].bcbaName, 'Ben Carter');
  assert.equal(items[0].goalCount, 1);
  assert.equal(items[0].programCount, 0);
  // effectiveDate was already returned by toPlan and must be untouched.
  assert.equal(items[0].effectiveDate, '2026-09-12');
});

test('lookups are DE-DUPLICATED — one client with several plans is fetched once', async () => {
  const { service, calls } = makeService({
    items: [plan({ id: 'p1' }), plan({ id: 'p2' }), plan({ id: 'p3' })],
  });
  const { items } = await service.listPlans({ tenantId: TENANT, limit: 25 });

  assert.equal(items.length, 3);
  assert.equal(calls.clients.length, 1, 'three plans, one distinct client → one lookup');
  assert.equal(calls.staff.length, 1, 'three plans, one distinct BCBA → one lookup');
  assert.equal(calls.counts, 1, 'content counts are ONE grouped query for the whole page');
});

test('an unresolved client or BCBA omits the field rather than leaking an id', async () => {
  const calls = [];
  const service = new PlansService({
    repository: {
      listPlans: async () => ({ items: [plan()], nextCursor: null }),
      countPlanContent: async () => new Map(),
    },
    // Out of scope / missing: the port throws, exactly as a cross-tenant or
    // deleted record would.
    clients: { findById: async () => { calls.push('c'); throw new Error('not found'); } },
    staff: { findById: async () => null },
    organizations: { getById: async () => ({ state: 'ACTIVE' }) },
  });

  const { items } = await service.listPlans({ tenantId: TENANT, limit: 25 });
  assert.equal('clientName' in items[0], false, 'no key at all, so the card omits the row');
  assert.equal('bcbaName' in items[0], false);
  // The raw ids must never be presented as a name.
  assert.notEqual(items[0].clientName, 'c1');
  assert.equal(items[0].clientId, 'c1', 'the id itself is still returned for linking');
});

test('an empty page does no lookups at all', async () => {
  const { service, calls } = makeService({ items: [] });
  const { items } = await service.listPlans({ tenantId: TENANT, limit: 25 });
  assert.deepEqual(items, []);
  assert.equal(calls.clients.length, 0);
  assert.equal(calls.staff.length, 0);
  assert.equal(calls.counts, 0);
});

test('the scope filter is still passed through to the query', async () => {
  let seen = null;
  const service = new PlansService({
    repository: {
      listPlans: async (_t, q) => { seen = q; return { items: [], nextCursor: null }; },
      countPlanContent: async () => new Map(),
    },
    clients: { findById: async () => null },
    staff: { findById: async () => null },
    organizations: { getById: async () => ({ state: 'ACTIVE' }) },
  });

  await service.listPlans({ tenantId: TENANT, limit: 10, status: 'ACTIVE', dataScope: { scope: 'TEAM', clientIds: ['c1'] } });
  assert.deepEqual(seen.dataScope, { scope: 'TEAM', clientIds: ['c1'] }, 'enrichment must not widen scope');
  assert.equal(seen.status, 'ACTIVE');
});
