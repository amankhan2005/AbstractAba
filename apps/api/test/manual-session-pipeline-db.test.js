import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * MANUAL SESSION PIPELINE — against a REAL MongoDB.
 *
 * Drives the production singletons (bcbaSessionService, sessionsService,
 * payrollService, claimsService) over real Mongoose models, so every index,
 * repository mapping and aggregation is the one production runs:
 *
 *   exact From/To → Session + SessionTimeRecord → Sessions page / Review Queue
 *   → Session Detail → My Hours → Payroll → Insurance Billing
 *
 * Needs a local `mongod` (mongodb-memory-server cannot download one in a
 * sandbox). Set MONGOMS_SYSTEM_BINARY or install mongod in a standard location;
 * without one the suite is SKIPPED, never silently passed.
 */

const CANDIDATES = [process.env.MONGOMS_SYSTEM_BINARY, '/opt/homebrew/bin/mongod', '/usr/local/bin/mongod', '/usr/bin/mongod'].filter(Boolean);
const MONGOD = CANDIDATES.find((p) => existsSync(p)) ?? null;
const skip = MONGOD ? false : 'no local mongod binary (set MONGOMS_SYSTEM_BINARY)';

const TZ = 'America/New_York';
const DATE = '2026-09-13';
const org = (instant) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(instant));

let server; let mongoose; let M; let withTenant; let zonedWallTimeToUtc;
let bcbaSessionService; let sessionsService; let payrollService; let claimsService;
const W = {}; // seeded world

before(async () => {
  if (skip) return;
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  server = await MongoMemoryServer.create({ binary: { systemBinary: MONGOD } });
  mongoose = (await import('mongoose')).default;
  await mongoose.connect(server.getUri());
  M = await import('../src/models/index.js');
  ({ withTenant } = await import('../src/tenancy/tenantContext.js'));
  ({ zonedWallTimeToUtc } = await import('../src/domain/businessDate.js'));
  ({ bcbaSessionService } = await import('../src/modules/bcba-session/index.js'));
  ({ sessionsService } = await import('../src/modules/sessions/index.js'));
  ({ payrollService } = await import('../src/modules/payroll/index.js'));
  ({ claimsService } = await import('../src/modules/claims/index.js'));
  await Promise.all(Object.values(M).filter((m) => m?.syncIndexes).map((m) => m.syncIndexes()));

  const makeOrg = (slug) => M.Organization.create({
    slug, legalName: slug, tradingName: slug, state: 'ACTIVE', countryCode: 'US', timezone: TZ,
    primaryContactName: 'Owner', primaryContactEmail: `${slug}@example.com`,
  });
  const o1 = await makeOrg('acme-manual');
  const o2 = await makeOrg('other-manual');
  W.T = o1._id; W.T2 = o2._id;
  await withTenant(W.T, async () => {
    const bcba = await M.StaffProfile.create({ userId: randomUUID(), firstName: 'Test1', lastName: 'J' });
    const rbt = await M.StaffProfile.create({ userId: randomUUID(), firstName: 'Nia', lastName: 'Patel' });
    const a = await M.Client.create({ clientNumber: 'C-A', firstName: 'Client', lastName: 'A', status: 'ACTIVE' });
    const b = await M.Client.create({ clientNumber: 'C-B', firstName: 'Client', lastName: 'B', status: 'ACTIVE' });
    for (const c of [a, b]) {
      await M.ClientAssignment.create({ clientId: c._id, staffProfileId: bcba._id, role: 'BCBA', status: 'ACTIVE' });
      await M.ClientAssignment.create({ clientId: c._id, staffProfileId: rbt._id, role: 'RBT', status: 'ACTIVE' });
    }
    const auth = (client, number) => M.ServiceAuthorization.create({
      clientId: client._id, serviceType: 'ABA', status: 'APPROVED', authorizationNumber: number, billingCode: '97153',
      startDate: new Date('2026-09-01T00:00:00Z'), endDate: new Date('2026-09-30T00:00:00Z'), units: 400,
    });
    const authA = await auth(a, 'AUTH-A');
    const authB = await auth(b, 'AUTH-B');
    await M.PayRate.create({ staffProfileId: bcba._id, rateType: 'HOURLY', amount: 6000, effectiveFrom: new Date('2026-01-01') });
    await M.PayRate.create({ staffProfileId: rbt._id, rateType: 'HOURLY', amount: 2500, effectiveFrom: new Date('2026-01-01') });
    for (const c of [a, b]) await M.InsuranceCoverage.create({ clientId: c._id, payerName: 'Acme Health', memberId: `M-${c._id}`, verificationStatus: 'VERIFIED' });
    Object.assign(W, { bcba: bcba._id, rbt: rbt._id, a: a._id, b: b._id, authA: `svc:${authA._id}`, authB: `svc:${authB._id}` });
  });

  // THE ACCEPTANCE DATA — three independent manual sessions on one business day.
  const add = (staff, role, input) => bcbaSessionService.createManualSession({
    tenantId: W.T, actorUserId: randomUUID(), bcbaStaffProfileId: staff, role, input: { date: DATE, ...input },
  });
  W.add = add;
  W.bcba1 = await add(W.bcba, 'BCBA', { clientId: W.a, startTime: '10:15', endTime: '11:45', authorizationIds: [W.authA], memo: 'BCBA session with Client A' });
  W.bcba2 = await add(W.bcba, 'BCBA', { clientId: W.b, startTime: '13:00', endTime: '14:15', authorizationIds: [W.authB], memo: 'BCBA session with Client B' });
  W.rbt1 = await add(W.rbt, 'RBT', { clientId: W.a, startTime: '10:30', endTime: '12:00', authorizationIds: [W.authA], memo: 'RBT session with Client A' });
});

after(async () => {
  if (skip) return;
  await mongoose?.disconnect();
  await server?.stop();
});

const wall = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return zonedWallTimeToUtc(2026, 9, 13, h, m, 0, TZ); };

test('multiple BCBA and RBT manual sessions on the SAME day are created independently', { skip }, async () => {
  for (const r of [W.bcba1, W.bcba2, W.rbt1]) assert.equal(r.alreadyExists, false);
  const ids = new Set([W.bcba1.session.id, W.bcba2.session.id, W.rbt1.session.id]);
  assert.equal(ids.size, 3, 'nothing merged or overwritten');
  await withTenant(W.T, async () => {
    assert.equal(await M.Session.countDocuments({ source: 'MANUAL' }), 3);
    assert.equal(await M.SessionTimeRecord.countDocuments({}), 3);
    assert.equal(await M.Appointment.countDocuments({ status: 'COMPLETED' }), 3);
  });
});

test('EXACT time round trip: selected From/To → DB → API → org-timezone display, with server-computed workedMinutes', { skip }, async () => {
  const cases = [
    [W.bcba1, '10:15', '11:45', 90, '10:15 AM', '11:45 AM'],
    [W.bcba2, '13:00', '14:15', 75, '1:00 PM', '2:15 PM'],
    [W.rbt1, '10:30', '12:00', 90, '10:30 AM', '12:00 PM'],
  ];
  for (const [res, from, to, minutes, inText, outText] of cases) {
    const stored = await withTenant(W.T, async () => await M.Session.findById(res.session.id).lean());
    // DB: the exact instants of the selected wall-clock times in the org timezone.
    for (const f of ['startedAt', 'clockInAt']) assert.equal(stored[f].toISOString(), wall(from).toISOString(), `${f} for ${from}`);
    for (const f of ['endedAt', 'clockOutAt']) assert.equal(stored[f].toISOString(), wall(to).toISOString(), `${f} for ${to}`);
    assert.equal(stored.status, 'FROZEN');
    assert.equal(stored.source, 'MANUAL');
    const record = await withTenant(W.T, async () => await M.SessionTimeRecord.findOne({ sessionId: res.session.id }).lean());
    assert.equal(record.workedMinutes, minutes);
    assert.equal(record.startedAt.toISOString(), wall(from).toISOString());

    // API: Session Detail returns the same clock, and it reads back exactly.
    const detail = await sessionsService.getSession({ tenantId: W.T, sessionId: res.session.id });
    assert.equal(org(detail.session.clockInAt), inText);
    assert.equal(org(detail.session.clockOutAt), outText);
    assert.equal(detail.payroll.workedMinutes, minutes);
    assert.equal(org(detail.appointment.startAt), inText, 'the manual appointment carries the same window (no 12:00 AM / now fallback)');
    assert.equal(detail.appointment.timeSet, true);
  }
  // 10:15 AM New York is 14:15Z — never 9:30 AM, midnight or the creation time.
  assert.equal(W.bcba1.session.startedAt ? new Date(W.bcba1.session.startedAt).toISOString() : null, '2026-09-13T14:15:00.000Z');
});

test('memo and authorizations persist in the normal session fields', { skip }, async () => {
  const detail = await sessionsService.getSession({ tenantId: W.T, sessionId: W.bcba1.session.id });
  assert.equal(detail.session.narrative, 'BCBA session with Client A');
  assert.deepEqual(detail.session.selectedAuthorizationIds, [W.authA]);
  assert.equal(detail.appointment.selectedAuthorization.authorizationNumber, 'AUTH-A');
  const record = await withTenant(W.T, async () => await M.SessionTimeRecord.findOne({ sessionId: W.bcba1.session.id }).lean());
  assert.deepEqual(record.authorizationIds, [W.authA]);
});

test('Sessions page / Review Queue: scoped lists include the manual sessions (BCBA caseload, RBT own only)', { skip }, async () => {
  const all = await sessionsService.listSessions({ tenantId: W.T, limit: 50, dataScope: { clientIds: null, staffIds: null } });
  assert.equal(all.items.filter((s) => s.source === 'MANUAL').length, 3);
  const byId = Object.fromEntries(all.items.map((s) => [s.id, s]));
  assert.equal(byId[W.bcba1.session.id].workedMinutes, 90);
  assert.equal(byId[W.bcba1.session.id].clinicianName, 'Test1 J');
  assert.equal(byId[W.bcba1.session.id].childName, 'Client A');

  const bcbaView = await sessionsService.listSessions({ tenantId: W.T, limit: 50, dataScope: { clientIds: [W.a, W.b], staffIds: [W.bcba] } });
  assert.equal(bcbaView.items.length, 3, 'a BCBA sees their caseload, including the RBT session');
  const rbtView = await sessionsService.listSessions({ tenantId: W.T, limit: 50, dataScope: { clientIds: [], staffIds: [W.rbt] } });
  assert.deepEqual(rbtView.items.map((s) => s.id), [W.rbt1.session.id], 'an RBT sees only their own session');
});

test('My Hours: BCBA 165 minutes, RBT 90 minutes from SessionTimeRecord.workedMinutes', { skip }, async () => {
  const now = new Date('2026-09-13T20:00:00Z');
  const bcba = await bcbaSessionService.getMyHours({ tenantId: W.T, bcbaStaffProfileId: W.bcba, now });
  const rbt = await bcbaSessionService.getMyHours({ tenantId: W.T, bcbaStaffProfileId: W.rbt, role: 'RBT', now });
  assert.equal(bcba.totalSeconds / 60, 165);
  assert.equal(rbt.totalSeconds / 60, 90);
});

test('Payroll: workedMinutes × each clinician\'s effective rate, per clinician', { skip }, async () => {
  const pr = await payrollService.previewPeriodPayroll(W.T, { mode: 'custom', from: DATE, to: DATE });
  const staff = Object.fromEntries(pr.staff.map((s) => [s.staffProfileId, s]));
  assert.equal(staff[W.bcba].workedMinutes, 165);
  assert.equal(staff[W.bcba].sessionCount, 2);
  assert.equal(staff[W.bcba].amount, 16500); // 165 min × $60/h
  assert.equal(staff[W.rbt].workedMinutes, 90);
  assert.equal(staff[W.rbt].amount, 3750); // 90 min × $25/h
  const entry = staff[W.bcba].entries.find((e) => e.sessionId === W.bcba1.session.id);
  assert.equal(org(entry.clockInAt), '10:15 AM');
  assert.equal(org(entry.clockOutAt), '11:45 AM');
});

test('Insurance Billing: completed manual sessions are billing-ready automatically — worked minutes × the clinician’s hourly rate', { skip }, async () => {
  const bill = await claimsService.previewCompanyBilling(W.T, { from: DATE, to: DATE });
  const sessions = bill.clients.flatMap((c) => c.sessions);
  const [b1, b2, r1] = [W.bcba1, W.bcba2, W.rbt1].map((r) => sessions.find((s) => s.sessionId === r.session.id));
  for (const s of [b1, b2, r1]) assert.equal(s?.billingStatus, 'READY', 'every manual session reaches billing, ready');
  assert.deepEqual([b1.workedMinutes, b1.hourlyRate, b1.amount], [90, 6000, 9000]); // 1.5h × $60
  assert.deepEqual([b2.workedMinutes, b2.hourlyRate, b2.amount, b2.authorizationNumber], [75, 6000, 7500, 'AUTH-B']); // 1.25h × $60
  assert.deepEqual([r1.workedMinutes, r1.hourlyRate, r1.amount], [90, 2500, 3750]); // 1.5h × $25
  assert.equal(bill.summary.totalBillableAmount, 9000 + 7500 + 3750);
});

test('duplicate protection: an exact repeat (and concurrent repeats) never create a second session', { skip }, async () => {
  const input = { clientId: W.a, startTime: '10:15', endTime: '11:45', authorizationIds: [W.authA] };
  const repeat = await W.add(W.bcba, 'BCBA', input);
  assert.equal(repeat.alreadyExists, true);
  assert.equal(repeat.session.id, W.bcba1.session.id);

  const burst = await Promise.all([1, 2, 3].map(() => W.add(W.rbt, 'RBT', { clientId: W.b, startTime: '14:30', endTime: '15:00', authorizationIds: [W.authB] })));
  assert.equal(new Set(burst.map((r) => r.session.id)).size, 1);
  assert.equal(burst.filter((r) => !r.alreadyExists).length, 1);
  await withTenant(W.T, async () => {
    const s = await M.Session.find({ staffProfileId: W.rbt, clientId: W.b }).lean();
    assert.equal(s.length, 1);
    assert.equal(await M.SessionTimeRecord.countDocuments({ sessionId: s[0]._id }), 1);
  });
  // An overlapping, non-identical entry for the same clinician is a conflict.
  await assert.rejects(W.add(W.bcba, 'BCBA', { clientId: W.b, startTime: '11:00', endTime: '12:00', authorizationIds: [W.authB] }), (e) => e.code === 'SESSION_CONFLICT');
});

test('validation: 15-minute increments, end after start, authorization for this client', { skip }, async () => {
  const base = { clientId: W.a, authorizationIds: [W.authA] };
  await assert.rejects(W.add(W.bcba, 'BCBA', { ...base, startTime: '16:10', endTime: '17:00' }), (e) => e.code === 'INVALID_TIME_INCREMENT');
  await assert.rejects(W.add(W.bcba, 'BCBA', { ...base, startTime: '17:00', endTime: '17:00' }), (e) => e.code === 'INVALID_TIME');
  await assert.rejects(W.add(W.bcba, 'BCBA', { ...base, startTime: '17:00', endTime: '16:00' }), (e) => e.code === 'INVALID_TIME');
  await assert.rejects(W.add(W.bcba, 'BCBA', { ...base, authorizationIds: [W.authB], startTime: '17:00', endTime: '18:00' }), (e) => e.code === 'AUTHORIZATION_NOT_FOR_CLIENT');
  await assert.rejects(W.add(W.bcba, 'BCBA', { ...base, authorizationIds: [], startTime: '17:00', endTime: '18:00' }), (e) => e.code === 'AUTHORIZATION_REQUIRED');
});

test('ownership, role and tenant isolation', { skip }, async () => {
  // The BCBA is not on the care team AS AN RBT: the role claim cannot widen access.
  await assert.rejects(W.add(W.bcba, 'RBT', { clientId: W.a, startTime: '18:00', endTime: '18:30', authorizationIds: [W.authA] }), (e) => e.code === 'NOT_ASSIGNED_TO_CHILD');
  // Another tenant cannot record against, or read, this tenant's data.
  await assert.rejects(bcbaSessionService.createManualSession({
    tenantId: W.T2, actorUserId: randomUUID(), bcbaStaffProfileId: W.bcba, role: 'BCBA',
    input: { date: DATE, clientId: W.a, startTime: '18:00', endTime: '18:30', authorizationIds: [W.authA] },
  }), (e) => e.code === 'NOT_ASSIGNED_TO_CHILD');
  const other = await sessionsService.listSessions({ tenantId: W.T2, limit: 50, dataScope: { clientIds: null, staffIds: null } });
  assert.equal(other.items.length, 0);
  await assert.rejects(sessionsService.getSession({ tenantId: W.T2, sessionId: W.bcba1.session.id }), (e) => e.code === 'SESSION_NOT_FOUND');
});
