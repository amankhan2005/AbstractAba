import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readBillWorkbook, readBillPdf } from './_bill-export-read.js';

/**
 * INSURANCE BILLING — the complete pipeline against a REAL MongoDB, driven only
 * through the application's own services (booking, live Start/Stop/Complete,
 * manual sessions, authorizations, insurance, Staff Profile hourly rates, claims).
 *
 * Raymond K: BCBA Test1 J — 9 completed sessions / 6h 44m; RBT Test2 K — 5
 * completed sessions / 7m. Completed sessions are billing-ready automatically:
 * no manual review, no authorization rate. Worked minutes ÷ 60 × the clinician's
 * Staff Profile hourly rate: $50/hr → $336.67, $25/hr → $2.92, client $339.59.
 */
const CANDIDATES = [process.env.MONGOMS_SYSTEM_BINARY, '/opt/homebrew/bin/mongod', '/usr/local/bin/mongod', '/usr/bin/mongod'].filter(Boolean);
const MONGOD = CANDIDATES.find((p) => existsSync(p)) ?? null;
const skip = MONGOD ? false : 'no local mongod binary (set MONGOMS_SYSTEM_BINARY)';
const TZ = 'America/Los_Angeles';

let server; let mongoose; let M; let withTenant; let claimsService; let clientsService; let insuranceService; let createClaimsRouter; let staffPayRatesPort;
const W = {};

before(async () => {
  if (skip) return;
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  server = await MongoMemoryServer.create({ binary: { systemBinary: MONGOD } });
  mongoose = (await import('mongoose')).default;
  await mongoose.connect(server.getUri());
  M = await import('../src/models/index.js');
  ({ withTenant } = await import('../src/tenancy/tenantContext.js'));
  ({ claimsService } = await import('../src/modules/claims/index.js'));
  ({ createClaimsRouter } = await import('../src/modules/claims/claims.routes.js'));
  ({ clientsService } = await import('../src/modules/clients/index.js'));
  ({ insuranceService } = await import('../src/modules/clients/insurance.service.js'));
  ({ staffPayRatesPort } = await import('../src/modules/staff/index.js'));
  const { BcbaSessionService, bcbaSessionService } = await import('../src/modules/bcba-session/index.js');
  const { SchedulingService, schedulingService } = await import('../src/modules/scheduling/index.js');
  const { zonedWallTimeToUtc } = await import('../src/domain/businessDate.js');
  await Promise.all(Object.values(M).filter((m) => m?.syncIndexes).map((m) => m.syncIndexes()));

  const org = (slug) => M.Organization.create({ slug, legalName: slug, tradingName: slug, state: 'ACTIVE', countryCode: 'US', timezone: TZ, primaryContactName: 'O', primaryContactEmail: `${slug}@example.com` });
  W.T = (await org('bill-a'))._id;
  W.T2 = (await org('bill-b'))._id;

  const seedClient = async (tenant, [first, last], [bFirst, bLast], [rFirst, rLast]) => withTenant(tenant, async () => {
    const bcba = await M.StaffProfile.create({ userId: randomUUID(), firstName: bFirst, lastName: bLast, status: 'ACTIVE' });
    const rbt = await M.StaffProfile.create({ userId: randomUUID(), firstName: rFirst, lastName: rLast, status: 'ACTIVE' });
    const c = await M.Client.create({ clientNumber: `${tenant}-${first}`, firstName: first, lastName: last, status: 'ACTIVE' });
    await M.Guardian.create({ clientId: c._id, firstName: 'P', lastName: last, phone: '5551234567', email: `${first.toLowerCase()}.${tenant.slice(-4)}@example.com`, relationship: 'PARENT', isPrimary: true });
    await M.ClientAssignment.create({ clientId: c._id, staffProfileId: bcba._id, role: 'BCBA', status: 'ACTIVE' });
    await M.ClientAssignment.create({ clientId: c._id, staffProfileId: rbt._id, role: 'RBT', status: 'ACTIVE' });
    return { bcba: bcba._id, rbt: rbt._id, client: c._id };
  });
  W.a = await seedClient(W.T, ['Raymond', 'K'], ['Test1', 'J'], ['Test2', 'K']);
  W.b = await seedClient(W.T2, ['Leak', 'Other'], ['Other', 'Bcba'], ['Other', 'Rbt']);

  // An authorization as the Client → Authorizations panel saves it — no rate of any kind.
  const authFor = (tenant, clientId, number) => clientsService.createServiceAuthorization({ tenantId: tenant, clientId, actorUserId: randomUUID(),
    input: { serviceType: 'ABA', authorizationNumber: number, billingCode: 'bnm', startDate: '2026-09-01', endDate: '2026-12-31', units: 200 } });
  W.auth = await authFor(W.T, W.a.client, 'AUTH-123');
  W.authB = await authFor(W.T2, W.b.client, 'AUTH-B');

  let clock = new Date();
  const live = new BcbaSessionService({ ...bcbaSessionService.deps, clock: { now: () => clock } });
  const sched = new SchedulingService({ ...schedulingService.deps, clock: { now: () => clock } });
  const at = (d, h, m) => { const [y, mo, dd] = d.split('-').map(Number); return zonedWallTimeToUtc(y, mo, dd, h, m, 0, TZ); };
  const liveSession = async (tenant, ids, authId, staff, role, date, hour, seconds) => {
    clock = at(date, 4, 0);
    const appt = await sched.bookAppointment({ tenantId: tenant, actorUserId: randomUUID(), input: { clientId: ids.client, authorizationIds: [`svc:${authId}`], units: 4, ...(role === 'BCBA' ? { bcbaId: staff } : { rbtId: staff }), startDate: date, startTime: `${String(hour).padStart(2, '0')}:00`, endTime: `${String(hour + 1).padStart(2, '0')}:00` } });
    clock = at(date, hour, 0);
    await live.startSession({ tenantId: tenant, actorUserId: randomUUID(), bcbaStaffProfileId: staff, appointmentId: appt.id, role });
    clock = new Date(clock.getTime() + seconds * 1000);
    await live.stopSession({ tenantId: tenant, actorUserId: randomUUID(), bcbaStaffProfileId: staff, appointmentId: appt.id, role });
    await live.completeSession({ tenantId: tenant, actorUserId: randomUUID(), bcbaStaffProfileId: staff, appointmentId: appt.id, role, authorizationId: `svc:${authId}` });
  };
  // Raymond K: BCBA Test1 J — 9 sessions, 6h 44m. RBT Test2 K — 5 sessions, 7m. On 09/12 and 09/13.
  for (const [i, m] of [45, 45, 45, 45, 45, 45, 45, 45, 44].entries()) await liveSession(W.T, W.a, W.auth.id, W.a.bcba, 'BCBA', i < 5 ? '2026-09-12' : '2026-09-13', 6 + (i % 5), m * 60);
  for (const [i, m] of [2, 1, 1, 2, 1].entries()) await liveSession(W.T, W.a, W.auth.id, W.a.rbt, 'RBT', i < 2 ? '2026-09-12' : '2026-09-13', 13 + i, m * 60);
  // Other organization: one fully configured, billable session.
  await liveSession(W.T2, W.b, W.authB.id, W.b.bcba, 'BCBA', '2026-09-12', 9, 3600);
  await staffPayRatesPort.setHourlyRate({ tenantId: W.T2, staffProfileId: W.b.bcba, actorUserId: randomUUID(), amount: 99 });
  await insuranceService.create({ tenantId: W.T2, clientId: W.b.client, actorUserId: randomUUID(), input: { payerName: 'Other Payer', memberId: 'B-1', effectiveFrom: '2026-01-01' } });
  W.makeManual = (date, s, e, authorizationId = `svc:${W.auth.id}`) => bcbaSessionService.createManualSession({ tenantId: W.T, actorUserId: randomUUID(), bcbaStaffProfileId: W.a.bcba, role: 'BCBA',
    input: { clientId: W.a.client, date, startTime: s, endTime: e, memo: 'x', authorizationIds: [authorizationId] } });
});
after(async () => { if (skip) return; await mongoose?.disconnect(); await server?.stop(); });

const PERIOD = { from: '2026-09-01', to: '2026-09-13' };

test('completed sessions with no billing configuration yet are INCOMPLETE for real data gaps only — never a review queue or an authorization-rate error', { skip }, async () => {
  const p = await claimsService.previewCompanyBilling(W.T, PERIOD);
  const c = p.clients[0];
  assert.equal(c.clientName, 'Raymond K');
  assert.deepEqual(c.bcbaStaff.map((s) => [s.staffName, s.sessions, s.workedMinutes]), [['Test1 J', 9, 404]]);
  assert.deepEqual(c.rbtStaff.map((s) => [s.staffName, s.sessions, s.workedMinutes]), [['Test2 K', 5, 7]]);
  assert.deepEqual([p.summary.totalSessions, p.summary.totalWorkedMinutes, p.summary.readyToBill, p.summary.incomplete], [14, 411, 0, 14]);
  assert.deepEqual(p.summary.issues.map((r) => [r.code, r.count]), [['MISSING_HOURLY_RATE', 14], ['MISSING_PAYER', 14]]);
  assert.ok(!JSON.stringify(p).match(/unit price|insurance billing rate|review/i), 'no authorization-rate or review wording anywhere');
  assert.ok(c.sessions.every((r) => r.amount === null), 'no fake $0.00 per session');
  await assert.rejects(claimsService.generateCompanyBilling(W.T, PERIOD, randomUUID()), /Some billing information is incomplete for 14 sessions/);
  assert.equal(await withTenant(W.T, async () => M.Claim.countDocuments({})), 0);
});

test('saving the client insurance activates it immediately — the sessions need only the clinicians’ hourly rates', { skip }, async () => {
  const cov = await insuranceService.create({ tenantId: W.T, clientId: W.a.client, actorUserId: randomUUID(), input: { payerName: 'Acme Health', memberId: 'M-100', effectiveFrom: '2026-01-01' } });
  assert.equal(cov.verificationStatus, 'VERIFIED');
  const p = await claimsService.previewCompanyBilling(W.T, PERIOD);
  assert.deepEqual(p.summary.issues.map((r) => [r.code, r.count, r.staff]), [['MISSING_HOURLY_RATE', 14, ['Test1 J', 'Test2 K']]]);
});

test('once the Staff Profile hourly rates exist, all 14 completed sessions are READY automatically: $336.67 + $2.92 = $339.59', { skip }, async () => {
  // Exactly what saving the hourly rate on each Staff Profile does.
  await staffPayRatesPort.setHourlyRate({ tenantId: W.T, staffProfileId: W.a.bcba, actorUserId: randomUUID(), amount: 50 });
  await staffPayRatesPort.setHourlyRate({ tenantId: W.T, staffProfileId: W.a.rbt, actorUserId: randomUUID(), amount: 25 });
  const p = await claimsService.previewCompanyBilling(W.T, PERIOD);
  const c = p.clients[0];
  assert.deepEqual(c.bcbaStaff.map((s) => [s.staffName, s.hourlyRate, s.workedMinutes, s.charge]), [['Test1 J', 5000, 404, 33667]]);
  assert.deepEqual(c.rbtStaff.map((s) => [s.staffName, s.hourlyRate, s.workedMinutes, s.charge]), [['Test2 K', 2500, 7, 292]]);
  assert.deepEqual([c.bcbaCharge, c.rbtCharge, c.clientTotal, c.payerName], [33667, 292, 33959, 'Acme Health']);
  assert.deepEqual([p.summary.readyToBill, p.summary.incomplete, p.summary.readyAmount, p.summary.totalBillableAmount], [14, 0, 33959, 33959]);
  assert.equal(c.sessions.reduce((t, r) => t + r.amount, 0), 33959, 'session amounts reconcile to the charges');
  const recs = await withTenant(W.T, async () => M.SessionTimeRecord.find({}).lean());
  assert.equal(recs.reduce((t, r) => t + r.workedMinutes, 0), 411, 'worked time is the SessionTimeRecord, not the 1-hour bookings');
  W.ready = p;
});

test('ONE consolidated billing run, one claim per client, equal to the preview to the cent; never billed twice', { skip }, async () => {
  const run = await claimsService.generateCompanyBilling(W.T, PERIOD, randomUUID());
  assert.deepEqual(run.claims.map((x) => [x.clientName, x.payerName, x.sessionCount, x.totalCharge]), [['Raymond K', 'Acme Health', 14, 33959]]);
  assert.equal(run.generatedAmount, W.ready.summary.readyAmount);
  const lines = await withTenant(W.T, async () => M.ClaimLine.find({}).lean());
  assert.equal(lines.length, 14);
  const rowBySession = new Map(W.ready.clients[0].sessions.map((r) => [r.sessionId, r]));
  for (const l of lines) {
    const r = rowBySession.get(l.sessionId);
    assert.deepEqual([l.charge, l.role, l.workedMinutes, l.hourlyRate, l.authorizationId], [r.amount, r.role, r.workedMinutes, r.hourlyRate, `svc:${W.auth.id}`]);
  }
  assert.deepEqual([run.summary.readyToBill, run.summary.alreadyBilled, run.summary.totalBillableAmount], [0, 14, 33959]);
  assert.deepEqual([run.bill.summary.totalSessions, run.bill.summary.totalBillableAmount, run.bill.claims.length], [14, 33959, 1], 'the response carries the persisted bill');

  const again = await claimsService.generateCompanyBilling(W.T, PERIOD, randomUUID());
  assert.deepEqual([again.alreadyGenerated, again.claimCount], [true, 0]);
  assert.equal(await withTenant(W.T, async () => M.ClaimLine.countDocuments({})), 14);
  // Concurrent runs for the same work cannot both bill it.
  await withTenant(W.T, async () => { await M.ClaimLine.deleteMany({}); await M.Claim.deleteMany({}); });
  const [r1, r2] = await Promise.all([claimsService.generateCompanyBilling(W.T, PERIOD, randomUUID()), claimsService.generateCompanyBilling(W.T, PERIOD, randomUUID())]);
  assert.equal(r1.claimCount + r2.claimCount, 1);
  assert.equal(await withTenant(W.T, async () => M.ClaimLine.countDocuments({})), 14);
  // A later rate change never re-prices billed work.
  await staffPayRatesPort.setHourlyRate({ tenantId: W.T, staffProfileId: W.a.bcba, actorUserId: randomUUID(), amount: 80 });
  assert.equal((await claimsService.previewCompanyBilling(W.T, PERIOD)).summary.totalBillableAmount, 33959);
  assert.equal((await claimsService.getGeneratedBill(W.T, PERIOD)).summary.totalBillableAmount, 33959);
});

test('the Excel and PDF downloads are built from the generated bill, and their totals equal the generated claims', { skip }, async () => {
  const { buffer, filename } = await claimsService.buildCompanyBillingWorkbook(W.T, PERIOD);
  assert.equal(filename, 'insurance-bill-20260901-20260913.xlsx');
  const wb = readBillWorkbook(buffer);
  const claimTotal = (await withTenant(W.T, async () => M.Claim.find({}).lean())).reduce((t, c) => t + c.totalCharge, 0);
  assert.equal(claimTotal, 33959);
  assert.deepEqual(wb.sheetNames, ['Insurance Bill']);
  const raymond = wb.table.find((r) => r['Client Name'].value === 'Raymond K');
  assert.deepEqual(wb.header.slice(1).map((h) => raymond[h].value), ['Test1 J', 50, '6h 44m', 336.67, 'Test2 K', 25, '0h 07m', 2.92, 339.59]);
  assert.equal(Math.round(wb.total['Client Total'].value * 100), claimTotal, 'company total cell equals the claims total');
  assert.deepEqual(wb.table.map((r) => r['Client Name'].value), ['Raymond K'], 'no other organization in the export');
  const { filename: pdfName, buffer: pdf } = await claimsService.buildCompanyBillingPdf(W.T, PERIOD);
  assert.equal(pdfName, 'insurance-bill-20260901-20260913.pdf');
  const text = readBillPdf(pdf).flat();
  assert.ok(text.includes('$339.59') && text.includes('Test2 K') && !text.includes('Leak Other'));
});

test('date range: inclusive org-calendar days, same-day ranges, month boundary, no UTC shift, invalid ranges refused', { skip }, async () => {
  // 11:30 PM Los Angeles on 09/13 is 06:30 UTC on 09/14.
  await W.makeManual('2026-09-13', '23:30', '23:45');
  const august = await clientsService.createServiceAuthorization({ tenantId: W.T, clientId: W.a.client, actorUserId: randomUUID(),
    input: { serviceType: 'ABA', authorizationNumber: 'AUTH-AUG', billingCode: '97153', startDate: '2026-08-01', endDate: '2026-08-31', units: 10 } });
  await W.makeManual('2026-08-31', '23:30', '23:45', `svc:${august.id}`);
  const sessionsIn = async (from, to) => (await claimsService.previewCompanyBilling(W.T, { from, to })).summary.totalSessions;
  assert.equal(await sessionsIn('2026-09-01', '2026-09-13'), 15, 'the late 09/13 session belongs to 09/13');
  assert.equal(await sessionsIn('2026-09-13', '2026-09-13'), 8, 'same-day range: 4 BCBA + 3 RBT + the late manual session');
  assert.equal(await sessionsIn('2026-09-14', '2026-09-14'), 0, 'never shifted into 09/14');
  assert.equal(await sessionsIn('2026-08-31', '2026-08-31'), 1, 'month boundary');
  assert.equal(await sessionsIn('2026-12-31', '2027-01-01'), 0, 'year boundary is a valid range');
  await assert.rejects(claimsService.previewCompanyBilling(W.T, { from: '2026-09-13', to: '2026-09-01' }), /From Date must be on or before To Date/);
  await assert.rejects(claimsService.previewCompanyBilling(W.T, { from: '2026-02-30', to: '2026-03-01' }), /valid calendar date/);
  const p = await claimsService.previewCompanyBilling(W.T, { from: '2026-09-13', to: '2026-09-13' });
  assert.equal(p.period.label, '09/13/2026 – 09/13/2026');
  const late = p.clients[0].sessions.find((r) => r.billingStatus === 'READY');
  assert.equal(late.serviceDate, '2026-09-13');
});

test('tenant isolation: each organization sees and bills only its own clients, claims and exports', { skip }, async () => {
  const a = await claimsService.previewCompanyBilling(W.T, PERIOD);
  const b = await claimsService.previewCompanyBilling(W.T2, PERIOD);
  assert.deepEqual(a.clients.map((c) => c.clientName), ['Raymond K']);
  assert.deepEqual(b.clients.map((c) => c.clientName), ['Leak Other']);
  assert.deepEqual([b.summary.readyToBill, b.summary.totalBillableAmount], [1, 9900]); // 60 min × $99/hr
  const runB = await claimsService.generateCompanyBilling(W.T2, PERIOD, randomUUID());
  assert.equal(runB.claimCount, 1, 'a second organization can bill after the first (claim numbers are per organization)');
  const [numA, numB] = await Promise.all([withTenant(W.T, async () => M.Claim.findOne({}).lean()), withTenant(W.T2, async () => M.Claim.findOne({}).lean())]);
  assert.equal(numA.claimNumber.slice(-5), numB.claimNumber.slice(-5), 'each organization numbers its own claims');
  const idx = await M.Claim.collection.indexes();
  assert.ok(idx.some((i) => i.unique && i.key.tenantId === 1 && i.key.claimNumber === 1), 'claim number unique per tenant');
  assert.ok(!idx.some((i) => i.key.organizationId), 'no index on the never-populated organizationId');
  assert.equal(await withTenant(W.T, async () => M.Claim.countDocuments({ payerName: 'Other Payer' })), 0);
  assert.ok(!JSON.stringify(await claimsService.previewCompanyBilling(W.T, PERIOD)).includes('Other Payer'));
});

test('RBAC: preview and exports need claims.read; generation needs claims.manage', { skip }, async () => {
  const router = createClaimsRouter(claimsService);
  const demanded = async (method, path) => {
    const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
    let error;
    await layer.route.stack[0].handle({ principal: { permissions: new Set() } }, {}, (e) => { error = e; });
    return /Missing permission: (\S+)/.exec(error?.message ?? '')?.[1];
  };
  assert.equal(await demanded('get', '/billing/company/preview'), 'claims.read');
  assert.equal(await demanded('get', '/billing/company/bill'), 'claims.read');
  assert.equal(await demanded('get', '/billing/company/export.xlsx'), 'claims.read');
  assert.equal(await demanded('get', '/billing/company/export.pdf'), 'claims.read');
  assert.equal(await demanded('post', '/billing/company/generate'), 'claims.manage');
});
