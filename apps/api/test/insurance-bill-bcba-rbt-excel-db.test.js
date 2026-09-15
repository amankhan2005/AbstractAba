import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readBillWorkbook, readBillPdf } from './_bill-export-read.js';

/**
 * REGRESSION — BCBA and RBT must both reach the downloaded Insurance Bill.
 *
 * Driven through the real services against a throwaway MongoDB:
 *   Raymond K  Test1 J (BCBA) $10/hr — 9 completed sessions, 404 worked minutes → $67.33
 *              Test2 K (RBT)  $20/hr — 5 completed sessions, 158 worked minutes → $52.67
 *              client total $120.00
 *   Bella B    BCBA only · Carl C  RBT only · Dana D  BCBA + a second RBT
 *
 * The original bug: the bill was generated before the RBT had an hourly rate,
 * so only the BCBA sessions were billed — the live panel later priced the RBT
 * while the downloaded Excel still held the BCBA alone. Generating again now
 * ADDS the newly ready RBT sessions to the client's existing claim, and the Excel
 * and PDF downloads (bill summaries) carry both roles, equal to the page.
 */
const CANDIDATES = [process.env.MONGOMS_SYSTEM_BINARY, '/opt/homebrew/bin/mongod', '/usr/local/bin/mongod', '/usr/bin/mongod'].filter(Boolean);
const MONGOD = CANDIDATES.find((p) => existsSync(p)) ?? null;
const skip = MONGOD ? false : 'no local mongod binary (set MONGOMS_SYSTEM_BINARY)';
const TZ = 'America/Los_Angeles';
const PERIOD = { from: '2026-09-01', to: '2026-09-14' };

let server; let mongoose; let M; let withTenant; let claimsService; let staffPayRatesPort;
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
  const { clientsService } = await import('../src/modules/clients/index.js');
  const { insuranceService } = await import('../src/modules/clients/insurance.service.js');
  ({ staffPayRatesPort } = await import('../src/modules/staff/index.js'));
  const { BcbaSessionService, bcbaSessionService } = await import('../src/modules/bcba-session/index.js');
  const { SchedulingService, schedulingService } = await import('../src/modules/scheduling/index.js');
  const { zonedWallTimeToUtc } = await import('../src/domain/businessDate.js');
  await Promise.all(Object.values(M).filter((m) => m?.syncIndexes).map((m) => m.syncIndexes()));

  W.T = (await M.Organization.create({ slug: 'bcba-rbt-excel', legalName: 'x', tradingName: 'Demo ABA', state: 'ACTIVE', countryCode: 'US', timezone: TZ, primaryContactName: 'O', primaryContactEmail: 'o@example.com' }))._id;
  const T = W.T;
  W.staff = await withTenant(T, async () => ({
    bcba: (await M.StaffProfile.create({ userId: randomUUID(), firstName: 'Test1', lastName: 'J', status: 'ACTIVE' }))._id,
    rbt: (await M.StaffProfile.create({ userId: randomUUID(), firstName: 'Test2', lastName: 'K', status: 'ACTIVE' }))._id,
  }));

  let clock = new Date();
  const live = new BcbaSessionService({ ...bcbaSessionService.deps, clock: { now: () => clock } });
  const sched = new SchedulingService({ ...schedulingService.deps, clock: { now: () => clock } });
  const at = (d, h, m) => { const [y, mo, dd] = d.split('-').map(Number); return zonedWallTimeToUtc(y, mo, dd, h, m, 0, TZ); };

  const client = async (first, last, roles, staffFor = (role) => (role === 'BCBA' ? W.staff.bcba : W.staff.rbt)) => {
    const id = await withTenant(T, async () => {
      const c = await M.Client.create({ clientNumber: `C-${first}`, firstName: first, lastName: last, status: 'ACTIVE' });
      await M.Guardian.create({ clientId: c._id, firstName: 'P', lastName: last, phone: '5551234567', email: `${first.toLowerCase()}@example.com`, relationship: 'PARENT', isPrimary: true });
      for (const role of roles) await M.ClientAssignment.create({ clientId: c._id, staffProfileId: staffFor(role), role, status: 'ACTIVE' });
      return c._id;
    });
    const auth = await clientsService.createServiceAuthorization({ tenantId: T, clientId: id, actorUserId: randomUUID(),
      input: { serviceType: 'ABA', authorizationNumber: `AUTH-${first.toUpperCase()}`, billingCode: '97153', startDate: '2026-09-01', endDate: '2026-12-31', units: 400 } });
    await insuranceService.create({ tenantId: T, clientId: id, actorUserId: randomUUID(), input: { payerName: 'Acme Health', memberId: `M-${first}`, effectiveFrom: '2026-01-01' } });
    return { id, auth: auth.id };
  };
  const session = async (c, role, date, hour, minutes, staff = role === 'BCBA' ? W.staff.bcba : W.staff.rbt) => {
    clock = at(date, 4, 0);
    const appt = await sched.bookAppointment({ tenantId: T, actorUserId: randomUUID(), input: { clientId: c.id, authorizationIds: [`svc:${c.auth}`], units: 4, ...(role === 'BCBA' ? { bcbaId: staff } : { rbtId: staff }), startDate: date, startTime: `${String(hour).padStart(2, '0')}:00`, endTime: `${String(hour + 1).padStart(2, '0')}:00` } });
    clock = at(date, hour, 0);
    await live.startSession({ tenantId: T, actorUserId: randomUUID(), bcbaStaffProfileId: staff, appointmentId: appt.id, role });
    clock = new Date(clock.getTime() + minutes * 60 * 1000);
    await live.stopSession({ tenantId: T, actorUserId: randomUUID(), bcbaStaffProfileId: staff, appointmentId: appt.id, role });
    await live.completeSession({ tenantId: T, actorUserId: randomUUID(), bcbaStaffProfileId: staff, appointmentId: appt.id, role, authorizationId: `svc:${c.auth}` });
  };

  // Raymond K — BCBA and RBT. 9 BCBA sessions / 404 min; 5 RBT sessions / 158 min.
  W.raymond = await client('Raymond', 'K', ['BCBA', 'RBT']);
  for (const [i, m] of [45, 45, 45, 45, 45, 45, 45, 45, 44].entries()) await session(W.raymond, 'BCBA', i < 5 ? '2026-09-12' : '2026-09-13', 6 + (i % 5), m);
  for (const [i, m] of [40, 30, 30, 30, 28].entries()) await session(W.raymond, 'RBT', i < 2 ? '2026-09-12' : '2026-09-13', 13 + i, m);
  // Bella B — BCBA only: 30 + 31 min at $10/hr = $10.17.
  W.bella = await client('Bella', 'B', ['BCBA']);
  await session(W.bella, 'BCBA', '2026-09-10', 9, 30);
  await session(W.bella, 'BCBA', '2026-09-11', 9, 31);
  // Carl C — RBT only: 20 + 20 + 5 min at $20/hr = $15.00.
  W.carl = await client('Carl', 'C', ['RBT']);
  for (const [i, m] of [20, 20, 5].entries()) await session(W.carl, 'RBT', '2026-09-09', 15 + i, m);
  // Outside the period: never on the bill.
  await session(W.raymond, 'RBT', '2026-09-15', 10, 30);

  W.client = client; W.session = session;
  // Only the BCBA has an hourly rate when the bill is first generated.
  await staffPayRatesPort.setHourlyRate({ tenantId: T, staffProfileId: W.staff.bcba, actorUserId: randomUUID(), amount: 10 });
});
after(async () => { if (skip) return; await mongoose?.disconnect(); await server?.stop(); });

const plain = (r) => Object.fromEntries(Object.entries(r).map(([k, c]) => [k, c.value]));
const excel = async () => readBillWorkbook((await claimsService.buildCompanyBillingWorkbook(W.T, PERIOD)).buffer);
const pdfText = async () => readBillPdf((await claimsService.buildCompanyBillingPdf(W.T, PERIOD)).buffer).flat();
const clientRow = (wb, name) => plain(wb.table.find((r) => r['Client Name'].value === name));
const totalRow = (wb) => plain(wb.total);
const findSequence = (items, seq) => items.findIndex((_, i) => seq.every((v, k) => items[i + k] === v));
const pdfCard = (text, name) => { const at = findSequence(text, ['CLIENT', name]); return at < 0 ? [] : text.slice(at, text.indexOf('CLIENT TOTAL', at) + 2); };

test('reproduction: a bill generated before the RBT had an hourly rate holds BCBA only, while the live panel prices the RBT', { skip }, async () => {
  const run = await claimsService.generateCompanyBilling(W.T, PERIOD, randomUUID());
  assert.deepEqual(run.claims.map((c) => [c.clientName, c.sessionCount, c.totalCharge]).sort(), [['Bella B', 2, 1017], ['Raymond K', 9, 6733]]);
  const first = await excel();
  assert.deepEqual(['BCBA Name', 'BCBA Charge', 'RBT Name', 'RBT Charge', 'Client Total'].map((h) => clientRow(first, 'Raymond K')[h]), ['Test1 J', 67.33, '', '', 67.33]);

  await staffPayRatesPort.setHourlyRate({ tenantId: W.T, staffProfileId: W.staff.rbt, actorUserId: randomUUID(), amount: 20 });
  const panel = await claimsService.previewCompanyBilling(W.T, PERIOD);
  const ray = panel.clients.find((c) => c.clientName === 'Raymond K');
  assert.deepEqual([ray.bcbaCharge, ray.rbtCharge, ray.clientTotal, panel.summary.readyToBill], [6733, 5267, 12000, 8]);
  const stale = await claimsService.getGeneratedBill(W.T, PERIOD);
  assert.equal(stale.clients.find((c) => c.clientName === 'Raymond K').rbtCharge, 0, 'the persisted bill has not received the RBT yet');
});

test('Update Bill adds the ready RBT sessions to Raymond K’s existing claim: ONE claim, BCBA $67.33 + RBT $52.67 = $120.00', { skip }, async () => {
  const run = await claimsService.generateCompanyBilling(W.T, PERIOD, randomUUID());
  assert.equal(run.alreadyGenerated, false);
  assert.deepEqual(run.claims.map((c) => [c.clientName, c.updated, c.sessionCount, c.totalCharge]).sort(), [['Carl C', false, 3, 1500], ['Raymond K', true, 5, 5267]]);
  assert.deepEqual([run.claimCount, run.updatedClaimCount, run.addedSessionCount], [1, 1, 8]);

  const claims = await withTenant(W.T, async () => M.Claim.find({}).lean());
  const rayClaims = claims.filter((c) => c.clientId === W.raymond.id);
  assert.equal(rayClaims.length, 1, 'still one claim for the client');
  assert.deepEqual([rayClaims[0].totalCharge, rayClaims[0].totalUnits], [12000, 14]);
  const lines = await withTenant(W.T, async () => M.ClaimLine.find({ claimId: rayClaims[0]._id }).lean());
  const byRole = (role) => lines.filter((l) => l.role === role);
  assert.deepEqual([byRole('BCBA').length, byRole('BCBA').reduce((t, l) => t + l.workedMinutes, 0), byRole('BCBA')[0].hourlyRate, byRole('BCBA').reduce((t, l) => t + l.charge, 0)], [9, 404, 1000, 6733]);
  assert.deepEqual([byRole('RBT').length, byRole('RBT').reduce((t, l) => t + l.workedMinutes, 0), byRole('RBT')[0].hourlyRate, byRole('RBT').reduce((t, l) => t + l.charge, 0)], [5, 158, 2000, 5267]);

  const bill = run.bill;
  const ray = bill.clients.find((c) => c.clientName === 'Raymond K');
  assert.deepEqual(ray.bcbaStaff.map((s) => [s.staffName, s.hourlyRate, s.sessions, s.workedMinutes, s.charge]), [['Test1 J', 1000, 9, 404, 6733]]);
  assert.deepEqual(ray.rbtStaff.map((s) => [s.staffName, s.hourlyRate, s.sessions, s.workedMinutes, s.charge]), [['Test2 K', 2000, 5, 158, 5267]]);
  assert.equal(ray.clientTotal, 12000);
  // The panel and the persisted bill now agree to the cent, client by client.
  const panel = await claimsService.previewCompanyBilling(W.T, PERIOD);
  assert.equal(panel.summary.readyToBill, 0);
  for (const c of panel.clients) {
    const b = bill.clients.find((x) => x.clientId === c.clientId);
    assert.deepEqual([b.bcbaCharge, b.rbtCharge, b.clientTotal], [c.bcbaCharge, c.rbtCharge, c.clientTotal], c.clientName);
  }
  assert.equal(bill.summary.totalBillableAmount, panel.summary.totalBillableAmount);
});

test('the downloaded Excel contains BOTH BCBA and RBT: hourly rates, worked hours "Xh Ym", charges, client totals and the company total', { skip }, async () => {
  const bill = await claimsService.getGeneratedBill(W.T, PERIOD);
  const wb = await excel();
  assert.deepEqual(wb.header, ['Client Name', 'BCBA Name', 'BCBA Hourly Rate', 'BCBA Worked Hours', 'BCBA Charge', 'RBT Name', 'RBT Hourly Rate', 'RBT Worked Hours', 'RBT Charge', 'Client Total']);
  assert.deepEqual(wb.rows.slice(0, 3).map((r) => r.map((c) => c.value).filter((v) => v !== '')), [['Demo ABA'], ['Insurance Bill'], ['Billing Period', '09/01/2026 – 09/14/2026']]);

  const raymond = clientRow(wb, 'Raymond K');
  assert.deepEqual(wb.header.slice(1).map((h) => raymond[h]), ['Test1 J', 10, '6h 44m', 67.33, 'Test2 K', 20, '2h 38m', 52.67, 120]);
  const bella = clientRow(wb, 'Bella B');
  assert.deepEqual(wb.header.slice(1).map((h) => bella[h]), ['Test1 J', 10, '1h 01m', 10.17, '', '', '', '', 10.17], 'BCBA only');
  const carl = clientRow(wb, 'Carl C');
  assert.deepEqual(wb.header.slice(1).map((h) => carl[h]), ['', '', '', '', 'Test2 K', 20, '0h 45m', 15, 15], 'RBT only');

  const total = totalRow(wb);
  assert.deepEqual(['BCBA Worked Hours', 'BCBA Charge', 'RBT Worked Hours', 'RBT Charge', 'Client Total'].map((h) => total[h]), ['7h 45m', 77.5, '3h 23m', 67.67, 145.17]);
  assert.equal(Math.round(total['Client Total'] * 100), Math.round((raymond['Client Total'] + bella['Client Total'] + carl['Client Total']) * 100), 'company total = Σ client totals');
  assert.equal(Math.round(total['Client Total'] * 100), bill.summary.totalBillableAmount, 'company total = the generated bill');
  const claimsTotal = (await withTenant(W.T, async () => M.Claim.find({}).lean())).reduce((t, c) => t + c.totalCharge, 0);
  assert.equal(Math.round(total['Client Total'] * 100), claimsTotal, 'company total = the persisted claims');
  // The Excel equals the page's bill, client by client.
  for (const c of bill.clients) {
    const r = clientRow(wb, c.clientName);
    assert.deepEqual([Math.round((Number(r['BCBA Charge']) || 0) * 100), Math.round((Number(r['RBT Charge']) || 0) * 100), Math.round(r['Client Total'] * 100)], [c.bcbaCharge, c.rbtCharge, c.clientTotal], c.clientName);
  }
  // The 09/15 RBT session is outside the period: Raymond's RBT time is 2h 38m, not 3h 08m.
  const text = wb.cells.map(String).join('|');
  for (const bad of ['Minutes', 'CLM-', 'AUTH-', '97153', 'America/', 'Generated', 'Session']) assert.ok(!text.includes(bad), bad);
});

test('the downloaded PDF is the same bill: both roles per client, client totals and the company total — no session details', { skip }, async () => {
  const text = await pdfText();
  assert.deepEqual(text.slice(0, 4), ['Demo ABA', 'Insurance Bill', 'BILLING PERIOD', '09/01/2026 – 09/14/2026']);
  const ray = pdfCard(text, 'Raymond K');
  assert.ok(findSequence(ray, ['BCBA', 'Test1 J', '$10.00/hr', '6h 44m', '$67.33']) >= 0, ray.join(' | '));
  assert.ok(findSequence(ray, ['RBT', 'Test2 K', '$20.00/hr', '2h 38m', '$52.67']) >= 0, ray.join(' | '));
  assert.deepEqual(ray.slice(-2), ['CLIENT TOTAL', '$120.00']);
  const bella = pdfCard(text, 'Bella B');
  assert.ok(findSequence(bella, ['BCBA', 'Test1 J', '$10.00/hr', '1h 01m', '$10.17']) >= 0 && !bella.includes('RBT'));
  const carl = pdfCard(text, 'Carl C');
  assert.ok(findSequence(carl, ['RBT', 'Test2 K', '$20.00/hr', '0h 45m', '$15.00']) >= 0 && !carl.includes('BCBA'));
  const at = text.indexOf('TOTAL COMPANY INSURANCE BILLING');
  assert.equal(text[at + 2], '$145.17');
  const joined = text.join('\n');
  for (const bad of ['Session', 'CLM-', 'AUTH-', '97153', 'America/', 'Generated', 'minutes', 'Billed']) assert.ok(!joined.includes(bad), bad);
  assert.ok(!/\d{1,2}:\d{2}\s?(AM|PM)/.test(joined));
});

test('refresh / reopen / repeated Generate: the same persisted bill and the same Excel, no duplicate claims', { skip }, async () => {
  const claimCount = await withTenant(W.T, async () => M.Claim.countDocuments({}));
  const again = await claimsService.generateCompanyBilling(W.T, PERIOD, randomUUID());
  assert.deepEqual([again.alreadyGenerated, again.claimCount, again.updatedClaimCount], [true, 0, 0]);
  assert.equal(await withTenant(W.T, async () => M.Claim.countDocuments({})), claimCount);
  // A later rate change never re-prices the generated bill.
  await staffPayRatesPort.setHourlyRate({ tenantId: W.T, staffProfileId: W.staff.rbt, actorUserId: randomUUID(), amount: 90 });
  const wb = await excel();
  assert.deepEqual(['BCBA Charge', 'RBT Charge', 'Client Total'].map((h) => clientRow(wb, 'Raymond K')[h]), [67.33, 52.67, 120]);
  assert.equal(totalRow(wb)['Client Total'], 145.17);
  const text = await pdfText();
  assert.deepEqual(pdfCard(text, 'Raymond K').slice(-2), ['CLIENT TOTAL', '$120.00']);
  assert.equal(text[text.indexOf('TOTAL COMPANY INSURANCE BILLING') + 2], '$145.17');
});

test('concurrent Update Bill runs add newly ready sessions exactly once', { skip }, async () => {
  // Dana D: BCBA Test1 J and a second RBT, Test3 L, who has no hourly rate yet.
  const rbt2 = await withTenant(W.T, async () => (await M.StaffProfile.create({ userId: randomUUID(), firstName: 'Test3', lastName: 'L', status: 'ACTIVE' }))._id);
  const dana = await W.client('Dana', 'D', ['BCBA', 'RBT'], (role) => (role === 'BCBA' ? W.staff.bcba : rbt2));
  await W.session(dana, 'BCBA', '2026-09-08', 9, 60);
  await W.session(dana, 'RBT', '2026-09-08', 11, 30, rbt2);
  await W.session(dana, 'RBT', '2026-09-08', 13, 15, rbt2);
  const first = await claimsService.generateCompanyBilling(W.T, PERIOD, randomUUID());
  assert.deepEqual(first.claims.map((c) => [c.clientName, c.sessionCount, c.totalCharge]), [['Dana D', 1, 1000]]);

  await staffPayRatesPort.setHourlyRate({ tenantId: W.T, staffProfileId: rbt2, actorUserId: randomUUID(), amount: 40 });
  const runs = await Promise.all([1, 2, 3].map(() => claimsService.generateCompanyBilling(W.T, PERIOD, randomUUID())));
  assert.equal(runs.reduce((t, r) => t + r.addedSessionCount, 0), 2, 'the two new RBT sessions are added exactly once');
  const claims = await withTenant(W.T, async () => M.Claim.find({ clientId: dana.id }).lean());
  const lines = await withTenant(W.T, async () => M.ClaimLine.find({ sessionId: { $in: (await M.Session.find({ clientId: dana.id }).lean()).map((x) => x._id) } }).lean());
  assert.deepEqual([claims.length, lines.length, claims[0].totalUnits, claims[0].totalCharge], [1, 3, 3, 1000 + 2000 + 1000]);
  assert.ok(lines.every((l) => l.claimId === claims[0]._id), 'no orphan or duplicate lines');

  const wb = await excel();
  assert.deepEqual(['BCBA Name', 'BCBA Charge', 'RBT Name', 'RBT Hourly Rate', 'RBT Worked Hours', 'RBT Charge', 'Client Total'].map((h) => clientRow(wb, 'Dana D')[h]), ['Test1 J', 10, 'Test3 L', 40, '0h 45m', 30, 40]);
  assert.equal(totalRow(wb)['Client Total'], 185.17, 'company total includes every client');
});
