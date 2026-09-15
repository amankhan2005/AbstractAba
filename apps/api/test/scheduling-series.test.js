import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SchedulingService } from '../src/modules/scheduling/scheduling.service.js';

/**
 * Recurring-series orchestration, DB-free via DI fakes. Availability is open on
 * all weekdays here so the recurrence math is what's under test; individual
 * tests override to force validation failures (skipped exceptions).
 */
function makeService({ state = 'ACTIVE', over = {} } = {}) {
  const appts = [];
  const series = new Map();
  let seq = 0;
  const repo = {
    // booking-path deps (open availability every day)
    listAvailability: async () => Array.from({ length: 7 }, (_, d) => ({ dayOfWeek: d, startMinute: 0, endMinute: 1440, effectiveFrom: null, effectiveTo: null })),
    findAuthorizationById: async () => ({ id: 'a-1', clientId: 'c-1', status: 'ACTIVE', startDate: '2026-01-01', endDate: '2026-12-31', authorizedUnits: 10000, usedUnits: 0, serviceCode: '97153' }),
    findOverlaps: async () => [],
    createAppointment: async (_t, doc) => { const a = { id: `ap-${++seq}`, ...doc, version: 1 }; appts.push(a); return a; },
    findAppointmentById: async (_t, id) => appts.find((a) => a.id === id) ?? null,
    cancelAppointment: async (_t, id) => { const a = appts.find((x) => x.id === id); if (a) a.status = 'CANCELLED'; return a ? { ...a } : null; },
    // series deps
    createSeries: async (_t, doc) => { const s = { id: `se-${++seq}`, ...doc, version: 1, lastMaterializedDate: null }; series.set(s.id, s); return { ...s }; },
    findSeriesById: async (_t, id) => (series.has(id) ? { ...series.get(id) } : null),
    listSeries: async () => [...series.values()],
    setSeriesLastMaterialized: async (_t, id, date) => { if (series.has(id)) series.get(id).lastMaterializedDate = date; },
    cancelSeries: async (_t, id, actor) => { const s = series.get(id); if (!s) return null; s.status = 'CANCELLED'; s.updatedBy = actor; return { ...s }; },
    listAppointmentsBySeries: async (_t, id) => appts.filter((a) => a.seriesId === id),
    listFutureScheduledBySeries: async (_t, id, from) => appts.filter((a) => a.seriesId === id && a.status === 'SCHEDULED' && a.startAt > from),
    ...over.repo,
  };
  const service = new SchedulingService({
    repository: repo,
    // The insurance gate is stubbed open by default here so these tests keep
    // exercising what they are about — units, credentials, availability,
    // double-booking. The gate's own behaviour is proven in
    // insurance-gate.test.js, and `over.insuranceGate` lets a case close it.
    insuranceGate: { assertVerified: async () => ({ satisfied: true }) },
    organizations: { getById: async () => ({ state }) },
    clients: { findById: async () => ({ id: 'c-1', status: 'ACTIVE' }), ...over.clients },
    staff: { findById: async () => ({ id: 's-1', status: 'ACTIVE' }), listCredentials: async () => [{ status: 'ACTIVE' }], ...over.staff },
  });
  return { service, appts, series, repo };
}

const seriesInput = {
  clientId: 'c-1', staffProfileId: 's-1', authorizationId: 'a-1',
  startMinute: 9 * 60, endMinute: 10 * 60,
  frequency: 'DAILY', interval: 1, startDate: '2026-03-02T00:00:00Z', count: 3,
};

test('createSeries materializes every valid occurrence and links seriesId', async () => {
  const { service, appts } = makeService();
  const res = await service.createSeries({ tenantId: 't1', actorUserId: 'u1', input: seriesInput });
  assert.equal(res.booked.length, 3);
  assert.equal(res.skipped.length, 0);
  assert.ok(appts.every((a) => a.seriesId === res.series.id));
  assert.ok(appts.every((a) => a.status === 'SCHEDULED'));
});

test('materialization records skipped exceptions instead of aborting the series', async () => {
  // Force a double-booking on the 2nd occurrence only.
  let call = 0;
  const { service } = makeService({ over: { repo: {
    findOverlaps: async () => { call += 1; return call === 2 ? [{ id: 'clash' }] : []; },
  } } });
  const res = await service.createSeries({ tenantId: 't1', actorUserId: 'u1', input: seriesInput });
  assert.equal(res.booked.length, 2);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /overlap|DOUBLE/i);
});

test('createSeries refused when org not ACTIVE', async () => {
  const { service } = makeService({ state: 'SUSPENDED' });
  await assert.rejects(() => service.createSeries({ tenantId: 't1', actorUserId: 'u1', input: seriesInput }), (e) => e.code === 'ORG_NOT_ACTIVE');
});

test('invalid recurrence rule (unbounded) is rejected before persistence', async () => {
  const { service, series } = makeService();
  const bad = { ...seriesInput, count: undefined, untilDate: undefined };
  await assert.rejects(() => service.createSeries({ tenantId: 't1', actorUserId: 'u1', input: bad }), /bounded/);
  assert.equal(series.size, 0); // nothing persisted
});

test('cancelSeries cancels future occurrences and marks the series CANCELLED', async () => {
  const { service, appts } = makeService();
  // Materialize a future daily series.
  const future = { ...seriesInput, startDate: new Date(Date.now() + 86400000).toISOString(), count: 3 };
  const res = await service.createSeries({ tenantId: 't1', actorUserId: 'u1', input: future });
  const out = await service.cancelSeries({ tenantId: 't1', seriesId: res.series.id, actorUserId: 'u1' });
  assert.equal(out.series.status, 'CANCELLED');
  assert.equal(out.cancelledOccurrences, 3);
  assert.ok(appts.filter((a) => a.seriesId === res.series.id).every((a) => a.status === 'CANCELLED'));
});

test('cancelSeries refuses an already-cancelled series', async () => {
  const { service } = makeService();
  const res = await service.createSeries({ tenantId: 't1', actorUserId: 'u1', input: { ...seriesInput, startDate: new Date(Date.now() + 86400000).toISOString() } });
  await service.cancelSeries({ tenantId: 't1', seriesId: res.series.id, actorUserId: 'u1' });
  await assert.rejects(() => service.cancelSeries({ tenantId: 't1', seriesId: res.series.id, actorUserId: 'u1' }), (e) => e.code === 'SERIES_ALREADY_CANCELLED');
});

test('cancelOccurrence cancels one appointment within its series', async () => {
  const { service, appts } = makeService();
  const res = await service.createSeries({ tenantId: 't1', actorUserId: 'u1', input: seriesInput });
  const target = appts[0];
  await service.cancelOccurrence({ tenantId: 't1', seriesId: res.series.id, appointmentId: target.id, actorUserId: 'u1' });
  assert.equal(appts.find((a) => a.id === target.id).status, 'CANCELLED');
});

test('IDOR guard: cancelOccurrence rejects an appointment not in the named series', async () => {
  const { service, appts, repo } = makeService();
  const res = await service.createSeries({ tenantId: 't1', actorUserId: 'u1', input: seriesInput });
  // Fabricate an appointment belonging to a DIFFERENT series.
  appts.push({ id: 'foreign', seriesId: 'other-series', status: 'SCHEDULED' });
  await assert.rejects(
    () => service.cancelOccurrence({ tenantId: 't1', seriesId: res.series.id, appointmentId: 'foreign', actorUserId: 'u1' }),
    (e) => e.code === 'APPOINTMENT_NOT_FOUND',
  );
});

test('getSeries / cancelSeries reject an unknown series (tenant-scoped lookup)', async () => {
  const { service } = makeService();
  await assert.rejects(() => service.getSeries({ tenantId: 't1', seriesId: 'nope' }), (e) => e.code === 'SERIES_NOT_FOUND');
  await assert.rejects(() => service.cancelSeries({ tenantId: 't1', seriesId: 'nope', actorUserId: 'u1' }), (e) => e.code === 'SERIES_NOT_FOUND');
});

test('WEEKLY series materializes only selected weekdays', async () => {
  const { service, appts } = makeService();
  // 2026-03-02 is Monday; select Mon(1)+Wed(3), 2 weeks.
  const res = await service.createSeries({ tenantId: 't1', actorUserId: 'u1', input: {
    ...seriesInput, frequency: 'WEEKLY', interval: 1, byWeekday: [1, 3], count: 4,
  } });
  assert.equal(res.booked.length, 4);
  const days = appts.map((a) => a.startAt.toISOString().slice(0, 10));
  assert.deepEqual(days, ['2026-03-02', '2026-03-04', '2026-03-09', '2026-03-11']);
});
