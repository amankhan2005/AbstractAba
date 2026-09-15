import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readBillWorkbook, readBillPdf } from './_bill-export-read.js';

/**
 * REGRESSION — the RBT missing from the insurance-billing Excel.
 *
 * Raymond K: BCBA Test1 J worked 6h 00m at $50/hr → $300.00; RBT Test2 K worked
 * 0h 07m at $25/hr → $2.92; client total $302.92. Driven through the real
 * services (booking, live Start/Stop/Complete, Staff Profile hourly rate,
 * insurance, generation) against a throwaway MongoDB. The workbook is the one a
 * user downloads for the GENERATED bill; it is unzipped and read cell by cell, and
 * the PDF download is read back as text.
 *
 * The second organization reproduces the data shape that lost the RBT: a
 * legacy appointment that does not carry rbtId and a clinician with no active
 * care-team row. The RBT's role then came from nowhere, the session was
 * "incomplete", and the RBT never reached the bill or the Excel. The clinician's
 * own role (their RBAC role / discipline) now resolves it.
 */
const CANDIDATES = [process.env.MONGOMS_SYSTEM_BINARY, '/opt/homebrew/bin/mongod', '/usr/local/bin/mongod', '/usr/bin/mongod'].filter(Boolean);
const MONGOD = CANDIDATES.find((p) => existsSync(p)) ?? null;
const skip = MONGOD ? false : 'no local mongod binary (set MONGOMS_SYSTEM_BINARY)';
const TZ = 'America/Los_Angeles';
const PERIOD = { from: '2026-09-01', to: '2026-09-14' };

let server; let mongoose; let M; let withTenant; let claimsService; let createClaimsRouter; let staffPayRatesPort;
const W = {};

const plain = (r) => Object.fromEntries(Object.entries(r).map(([k, c]) => [k, c.value]));
const clientRow = (wb, name) => plain(wb.table.find((r) => r['Client Name'].value === name));
const findSequence = (items, seq) => items.findIndex((_, i) => seq.every((v, k) => items[i + k] === v));

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
  const { clientsService } = await import('../src/modules/clients/index.js');
  const { insuranceService } = await import('../src/modules/clients/insurance.service.js');
  ({ staffPayRatesPort } = await import('../src/modules/staff/index.js'));
  const { BcbaSessionService, bcbaSessionService } = await import('../src/modules/bcba-session/index.js');
  const { SchedulingService, schedulingService } = await import('../src/modules/scheduling/index.js');
  const { zonedWallTimeToUtc } = await import('../src/domain/businessDate.js');
  await Promise.all(Object.values(M).filter((m) => m?.syncIndexes).map((m) => m.syncIndexes()));

  let clock = new Date();
  const live = new BcbaSessionService({ ...bcbaSessionService.deps, clock: { now: () => clock } });
  const sched = new SchedulingService({ ...schedulingService.deps, clock: { now: () => clock } });
  const at = (d, h, m) => { const [y, mo, dd] = d.split('-').map(Number); return zonedWallTimeToUtc(y, mo, dd, h, m, 0, TZ); };

  /** One organization with Raymond K, Test1 J (BCBA) and Test2 K (RBT). */
  const seedOrg = async (slug) => {
    const T = (await M.Organization.create({ slug, legalName: slug, tradingName: slug, state: 'ACTIVE', countryCode: 'US', timezone: TZ, primaryContactName: 'O', primaryContactEmail: `${slug}@example.com` }))._id;
    const ids = await withTenant(T, async () => {
      const role = async (key) => (await M.Role.create({ key, name: key.toUpperCase() }))._id;
      const [bcbaRole, rbtRole] = [await role('bcba'), await role('rbt')];
      const person = async (first, last, roleId) => {
        const userId = randomUUID();
        const m = await M.Membership.create({ userId, status: 'ACTIVE' });
        await M.MembershipRole.create({ membershipId: m._id, roleId });
        return (await M.StaffProfile.create({ userId, firstName: first, lastName: last, status: 'ACTIVE' }))._id;
      };
      const bcba = await person('Test1', 'J', bcbaRole);
      const rbt = await person('Test2', 'K', rbtRole);
      const c = await M.Client.create({ clientNumber: `${slug}-1`, firstName: 'Raymond', lastName: 'K', status: 'ACTIVE' });
      await M.Guardian.create({ clientId: c._id, firstName: 'P', lastName: 'K', phone: '5551234567', email: `p.${slug}@example.com`, relationship: 'PARENT', isPrimary: true });
      await M.ClientAssignment.create({ clientId: c._id, staffProfileId: bcba, role: 'BCBA', status: 'ACTIVE' });
      await M.ClientAssignment.create({ clientId: c._id, staffProfileId: rbt, role: 'RBT', status: 'ACTIVE' });
      return { bcba, rbt, client: c._id };
    });
    const auth = await clientsService.createServiceAuthorization({ tenantId: T, clientId: ids.client, actorUserId: randomUUID(),
      input: { serviceType: 'ABA', authorizationNumber: 'AUTH-123', billingCode: '97153', startDate: '2026-09-01', endDate: '2026-12-31', units: 200 } });
    await insuranceService.create({ tenantId: T, clientId: ids.client, actorUserId: randomUUID(), input: { payerName: 'Acme Health', memberId: 'M-1', effectiveFrom: '2026-01-01' } });
    await staffPayRatesPort.setHourlyRate({ tenantId: T, staffProfileId: ids.bcba, actorUserId: randomUUID(), amount: 50 });
    await staffPayRatesPort.setHourlyRate({ tenantId: T, staffProfileId: ids.rbt, actorUserId: randomUUID(), amount: 25 });

    const session = async (staff, role, date, hour, seconds) => {
      clock = at(date, 4, 0);
      const appt = await sched.bookAppointment({ tenantId: T, actorUserId: randomUUID(), input: { clientId: ids.client, authorizationIds: [`svc:${auth.id}`], units: 4, ...(role === 'BCBA' ? { bcbaId: staff } : { rbtId: staff }), startDate: date } });
      clock = at(date, hour, 0);
      await live.startSession({ tenantId: T, actorUserId: randomUUID(), bcbaStaffProfileId: staff, appointmentId: appt.id, role });
      clock = new Date(clock.getTime() + seconds * 1000);
      await live.stopSession({ tenantId: T, actorUserId: randomUUID(), bcbaStaffProfileId: staff, appointmentId: appt.id, role });
      await live.completeSession({ tenantId: T, actorUserId: randomUUID(), bcbaStaffProfileId: staff, appointmentId: appt.id, role, authorizationId: `svc:${auth.id}` });
      return appt;
    };
    await session(ids.bcba, 'BCBA', '2026-09-12', 6, 6 * 3600);   // 6h 00m
    const rbtAppt = await session(ids.rbt, 'RBT', '2026-09-12', 14, 7 * 60); // 0h 07m
    return { T, ids, rbtAppt };
  };

  W.a = await seedOrg('rbt-canonical');
  W.legacy = await seedOrg('rbt-legacy');
  // The legacy data shape: the RBT's appointment does not carry rbtId, and the
  // RBT's care-team assignment has since ended.
  await withTenant(W.legacy.T, async () => {
    await M.Appointment.updateOne({ _id: W.legacy.rbtAppt.id }, { $set: { rbtId: null } });
    await M.ClientAssignment.updateOne({ staffProfileId: W.legacy.ids.rbt }, { $set: { status: 'ENDED' } });
  });
});
after(async () => { if (skip) return; await mongoose?.disconnect(); await server?.stop(); });

test('generating the bill persists BOTH clinicians: BCBA Test1 J 6h 00m × $50 = $300.00, RBT Test2 K 0h 07m × $25 = $2.92, client $302.92', { skip }, async () => {
  const run = await claimsService.generateCompanyBilling(W.a.T, PERIOD, randomUUID());
  assert.equal(run.claimCount, 1);
  const bill = run.bill;
  assert.ok(bill?.generated && bill.persisted, 'the generate response carries the persisted bill');
  const c = bill.clients[0];
  assert.equal(c.clientName, 'Raymond K');
  assert.deepEqual(c.bcbaStaff.map((s) => [s.staffName, s.role, s.workedMinutes, s.hourlyRate, s.charge]), [['Test1 J', 'BCBA', 360, 5000, 30000]]);
  assert.deepEqual(c.rbtStaff.map((s) => [s.staffName, s.role, s.workedMinutes, s.hourlyRate, s.charge]), [['Test2 K', 'RBT', 7, 2500, 292]]);
  assert.deepEqual([c.bcbaCharge, c.rbtCharge, c.clientTotal], [30000, 292, 30292]);
  assert.deepEqual(c.unassignedStaff, []);
  assert.deepEqual([bill.summary.totalClients, bill.summary.totalSessions, bill.summary.totalWorkedMinutes, bill.summary.totalBillableAmount], [1, 2, 367, 30292]);
  assert.equal(bill.period.label, '09/01/2026 – 09/14/2026');

  const claims = await withTenant(W.a.T, async () => M.Claim.find({}).lean());
  assert.deepEqual(claims.map((x) => [x.totalCharge, x.billingPeriodStart, x.billingPeriodEnd]), [[30292, '2026-09-01', '2026-09-14']]);
  assert.deepEqual(bill.claims.map((x) => [x.claimNumber, x.clientName, x.sessionCount, x.totalCharge]), [[claims[0].claimNumber, 'Raymond K', 2, 30292]]);
  const lines = await withTenant(W.a.T, async () => M.ClaimLine.find({}).sort({ serviceDate: 1 }).lean());
  assert.deepEqual(lines.map((l) => [l.role, l.workedMinutes, l.hourlyRate, l.charge]), [['BCBA', 360, 5000, 30000], ['RBT', 7, 2500, 292]]);
});

test('the downloaded Excel has Test1 J as BCBA AND Test2 K as RBT for Raymond K, and its total equals the generated bill', { skip }, async () => {
  const bill = await claimsService.getGeneratedBill(W.a.T, PERIOD);
  const { buffer, filename } = await claimsService.buildCompanyBillingWorkbook(W.a.T, PERIOD);
  assert.equal(filename, 'insurance-bill-20260901-20260914.xlsx');
  const wb = readBillWorkbook(buffer);
  const raymond = clientRow(wb, 'Raymond K');
  assert.deepEqual(wb.header.slice(1).map((h) => raymond[h]), ['Test1 J', 50, '6h 00m', 300, 'Test2 K', 25, '0h 07m', 2.92, 302.92]);
  const total = plain(wb.total);
  assert.deepEqual([total['BCBA Charge'], total['RBT Charge'], total['Client Total']], [300, 2.92, bill.summary.totalBillableAmount / 100]);
  const claimTotal = (await withTenant(W.a.T, async () => M.Claim.find({}).lean())).reduce((t, x) => t + x.totalCharge, 0);
  assert.equal(Math.round(total['Client Total'] * 100), claimTotal, 'Excel total = generated claims total');

  const text = readBillPdf((await claimsService.buildCompanyBillingPdf(W.a.T, PERIOD)).buffer).flat();
  assert.ok(findSequence(text, ['BCBA', 'Test1 J', '$50.00/hr', '6h 00m', '$300.00']) >= 0, text.join(' | '));
  assert.ok(findSequence(text, ['RBT', 'Test2 K', '$25.00/hr', '0h 07m', '$2.92']) >= 0, text.join(' | '));
  assert.ok(findSequence(text, ['CLIENT TOTAL', '$302.92']) >= 0);
});

test('the generated bill is persisted: a later rate change, a repeated Generate and a reopen return the same bill and the same Excel', { skip }, async () => {
  const before = await claimsService.getGeneratedBill(W.a.T, PERIOD);
  await staffPayRatesPort.setHourlyRate({ tenantId: W.a.T, staffProfileId: W.a.ids.bcba, actorUserId: randomUUID(), amount: 80 });
  await staffPayRatesPort.setHourlyRate({ tenantId: W.a.T, staffProfileId: W.a.ids.rbt, actorUserId: randomUUID(), amount: 40 });

  const again = await claimsService.generateCompanyBilling(W.a.T, PERIOD, randomUUID());
  assert.deepEqual([again.alreadyGenerated, again.claimCount], [true, 0], 'same range → no duplicate claims');
  assert.equal(again.bill.summary.totalBillableAmount, 30292, 'the existing bill is returned');
  assert.equal(await withTenant(W.a.T, async () => M.Claim.countDocuments({})), 1);

  const reopened = await claimsService.getGeneratedBill(W.a.T, PERIOD);
  assert.deepEqual(reopened.clients, before.clients, 'nothing re-priced');
  const wb = readBillWorkbook((await claimsService.buildCompanyBillingWorkbook(W.a.T, PERIOD)).buffer);
  assert.deepEqual(['BCBA Charge', 'RBT Charge', 'Client Total'].map((h) => clientRow(wb, 'Raymond K')[h]), [300, 2.92, 302.92]);

  const list = await claimsService.listGeneratedBills(W.a.T);
  assert.deepEqual(list.map((b) => [b.from, b.to, b.label, b.claimCount, b.clientCount]), [['2026-09-01', '2026-09-14', '09/01/2026 – 09/14/2026', 1, 1]]);
  const text = readBillPdf((await claimsService.buildCompanyBillingPdf(W.a.T, PERIOD)).buffer).flat();
  assert.ok(text.includes('Test2 K') && text.includes('RBT') && text.includes('$302.92'), 'the PDF is the same bill');
});

test('legacy RBT whose appointment lacks rbtId and who has no care-team row is still billed and exported as the RBT', { skip }, async () => {
  const preview = await claimsService.previewCompanyBilling(W.legacy.T, PERIOD);
  const rbtRow = preview.clients[0].sessions.find((r) => r.staffName === 'Test2 K');
  assert.deepEqual([rbtRow.role, rbtRow.billingStatus, rbtRow.amount], ['RBT', 'READY', 292], `RBT resolved: ${JSON.stringify(rbtRow.issues)}`);

  await claimsService.generateCompanyBilling(W.legacy.T, PERIOD, randomUUID());
  const bill = await claimsService.getGeneratedBill(W.legacy.T, PERIOD);
  assert.deepEqual(bill.clients[0].rbtStaff.map((s) => [s.staffName, s.charge]), [['Test2 K', 292]]);
  assert.equal(bill.summary.totalBillableAmount, 30292);
  const wb = readBillWorkbook((await claimsService.buildCompanyBillingWorkbook(W.legacy.T, PERIOD)).buffer);
  const raymond = clientRow(wb, 'Raymond K');
  assert.deepEqual([raymond['BCBA Name'], raymond['RBT Name'], raymond['RBT Charge'], raymond['Client Total']], ['Test1 J', 'Test2 K', 2.92, 302.92]);
});

test('the clinician-role fallback only uses an unambiguous BCBA / RBT role', { skip }, async () => {
  const { clinicianRoleOf } = await import('../src/modules/activity/activity.pipeline.js');
  assert.equal(clinicianRoleOf(['rbt']), 'RBT');
  assert.equal(clinicianRoleOf(['BCBA', 'org_admin']), 'BCBA');
  assert.equal(clinicianRoleOf(['bcba', 'rbt'], 'RBT'), null, 'two clinical roles are ambiguous — never guessed');
  assert.equal(clinicianRoleOf([], 'rbt'), 'RBT');
  assert.equal(clinicianRoleOf(['owner'], 'Speech'), null);
});

test('no generated bill: downloads are refused with a clear message; bills never cross organizations', { skip }, async () => {
  assert.equal(await claimsService.getGeneratedBill(W.a.T, { from: '2026-10-01', to: '2026-10-31' }), null);
  await assert.rejects(claimsService.buildCompanyBillingWorkbook(W.a.T, { from: '2026-10-01', to: '2026-10-31' }), /No bill has been generated for this billing period yet/);
  await assert.rejects(claimsService.buildCompanyBillingPdf(W.a.T, { from: '2026-10-01', to: '2026-10-31' }), /No bill has been generated/);
  await assert.rejects(claimsService.getGeneratedBill(W.a.T, { from: '2026-09-14', to: '2026-09-01' }), /From Date must be on or before To Date/);

  const a = await claimsService.getGeneratedBill(W.a.T, PERIOD);
  const b = await claimsService.getGeneratedBill(W.legacy.T, PERIOD);
  const aClaims = new Set(a.claims.map((c) => c.id));
  assert.ok(b.claims.every((c) => !aClaims.has(c.id)), 'each organization reads only its own claims');
  assert.deepEqual((await claimsService.listGeneratedBills(W.legacy.T)).map((x) => x.claimCount), [1]);
  const empty = await M.Organization.create({ slug: 'rbt-empty', legalName: 'e', tradingName: 'e', state: 'ACTIVE', countryCode: 'US', timezone: TZ, primaryContactName: 'O', primaryContactEmail: 'e@example.com' });
  assert.equal(await claimsService.getGeneratedBill(empty._id, PERIOD), null);
  assert.deepEqual(await claimsService.listGeneratedBills(empty._id), []);
});

test('RBAC: the generated bill, bill list and downloads need claims.read; generation needs claims.manage', { skip }, async () => {
  const router = createClaimsRouter(claimsService);
  const demanded = async (method, path) => {
    const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
    let error;
    await layer.route.stack[0].handle({ principal: { permissions: new Set() } }, {}, (e) => { error = e; });
    return /Missing permission: (\S+)/.exec(error?.message ?? '')?.[1];
  };
  assert.equal(await demanded('get', '/billing/company/bill'), 'claims.read');
  assert.equal(await demanded('get', '/billing/company/bills'), 'claims.read');
  assert.equal(await demanded('get', '/billing/company/export.xlsx'), 'claims.read');
  assert.equal(await demanded('get', '/billing/company/export.pdf'), 'claims.read');
  assert.equal(await demanded('post', '/billing/company/generate'), 'claims.manage');
});
