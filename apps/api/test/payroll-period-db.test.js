import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readPayrollWorkbook, readBillPdf } from './_bill-export-read.js';

/**
 * COMPANY PAYROLL — weekly / bi-weekly / custom against a throwaway MongoDB,
 * driven through the real services (booking, live Start/Stop/Complete, Staff
 * Profile hourly rates, payroll generation and downloads). "Today" is Tuesday
 * 09/15/2026 in New York.
 *
 *   Week 08/31–09/06  Test1 J (BCBA $50)  30 min on 09/02
 *   Week 09/07–09/13  Test1 J (BCBA $50)  240 + 120 = 6h 00m → $300.00
 *                     Ellen Ng (BCBA $60) 90       = 1h 30m → $90.00
 *                     Test2 K (RBT $25)   90 + 60  = 2h 30m → $62.50
 *                     Ann Lee (RBT $30)   45       = 0h 45m → $22.50   total $475.00
 *   Week 09/14–09/20  (in progress)  Test1 J 60 min on Mon 09/14, Test2 K 30 min on Tue 09/15
 */
const CANDIDATES = [process.env.MONGOMS_SYSTEM_BINARY, '/opt/homebrew/bin/mongod', '/usr/local/bin/mongod', '/usr/bin/mongod'].filter(Boolean);
const MONGOD = CANDIDATES.find((p) => existsSync(p)) ?? null;
const skip = MONGOD ? false : 'no local mongod binary (set MONGOMS_SYSTEM_BINARY)';
const TZ = 'America/New_York';
const TUESDAY = new Date('2026-09-15T14:00:00Z');      // Tue 09/15 10:00 New York
const NEXT_MONDAY = new Date('2026-09-21T04:00:00Z');  // Mon 09/21 00:00 New York

let server; let mongoose; let M; let withTenant; let PayrollService; let createPayrollRouter; let staffPayRatesPort;
const W = {};
const payrollAt = (now) => new PayrollService({ clock: { now: () => now } });

before(async () => {
  if (skip) return;
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  server = await MongoMemoryServer.create({ binary: { systemBinary: MONGOD } });
  mongoose = (await import('mongoose')).default;
  await mongoose.connect(server.getUri());
  M = await import('../src/models/index.js');
  ({ withTenant } = await import('../src/tenancy/tenantContext.js'));
  ({ PayrollService } = await import('../src/modules/payroll/index.js'));
  ({ createPayrollRouter } = await import('../src/modules/payroll/payroll.routes.js'));
  const { clientsService } = await import('../src/modules/clients/index.js');
  ({ staffPayRatesPort } = await import('../src/modules/staff/index.js'));
  const { BcbaSessionService, bcbaSessionService } = await import('../src/modules/bcba-session/index.js');
  const { SchedulingService, schedulingService } = await import('../src/modules/scheduling/index.js');
  const { zonedWallTimeToUtc } = await import('../src/domain/businessDate.js');
  await Promise.all(Object.values(M).filter((m) => m?.syncIndexes).map((m) => m.syncIndexes()));

  const org = async (slug, name) => (await M.Organization.create({ slug, legalName: name, tradingName: name, state: 'ACTIVE', countryCode: 'US', timezone: TZ, primaryContactName: 'O', primaryContactEmail: `${slug}@example.com` }))._id;
  W.T = await org('payroll-a', 'Demo ABA Clinic');
  W.T2 = await org('payroll-b', 'Other Clinic');

  let clock = new Date();
  const live = new BcbaSessionService({ ...bcbaSessionService.deps, clock: { now: () => clock } });
  const sched = new SchedulingService({ ...schedulingService.deps, clock: { now: () => clock } });
  const at = (d, h, m = 0) => { const [y, mo, dd] = d.split('-').map(Number); return zonedWallTimeToUtc(y, mo, dd, h, m, 0, TZ); };

  const seedOrg = async (T, people) => {
    const ids = await withTenant(T, async () => {
      const staff = {};
      for (const [key, first, last] of people) staff[key] = (await M.StaffProfile.create({ userId: randomUUID(), firstName: first, lastName: last, status: 'ACTIVE' }))._id;
      const c = await M.Client.create({ clientNumber: `C-${T.slice(-4)}`, firstName: 'Raymond', lastName: 'K', status: 'ACTIVE' });
      await M.Guardian.create({ clientId: c._id, firstName: 'P', lastName: 'K', phone: '5551234567', email: `p.${T.slice(-6)}@example.com`, relationship: 'PARENT', isPrimary: true });
      return { staff, client: c._id };
    });
    const auth = await clientsService.createServiceAuthorization({ tenantId: T, clientId: ids.client, actorUserId: randomUUID(),
      input: { serviceType: 'ABA', authorizationNumber: `AUTH-${T.slice(-4)}`, billingCode: '97153', startDate: '2026-08-01', endDate: '2026-12-31', units: 800 } });
    return { ...ids, auth: auth.id };
  };
  const session = async (T, ids, key, role, date, hour, minutes) => {
    const staffId = ids.staff[key];
    await withTenant(T, async () => {
      if (!(await M.ClientAssignment.exists({ clientId: ids.client, staffProfileId: staffId }))) {
        await M.ClientAssignment.updateMany({ clientId: ids.client, role, status: 'ACTIVE' }, { $set: { status: 'ENDED' } });
        await M.ClientAssignment.create({ clientId: ids.client, staffProfileId: staffId, role, status: 'ACTIVE' });
      } else {
        await M.ClientAssignment.updateMany({ clientId: ids.client, role, status: 'ACTIVE', staffProfileId: { $ne: staffId } }, { $set: { status: 'ENDED' } });
        await M.ClientAssignment.updateOne({ clientId: ids.client, staffProfileId: staffId }, { $set: { status: 'ACTIVE' } });
      }
    });
    clock = at(date, 4);
    const appt = await sched.bookAppointment({ tenantId: T, actorUserId: randomUUID(), input: { clientId: ids.client, authorizationIds: [`svc:${ids.auth}`], units: 4, ...(role === 'BCBA' ? { bcbaId: staffId } : { rbtId: staffId }), startDate: date, startTime: `${String(hour).padStart(2, '0')}:00`, endTime: `${String(hour + 5).padStart(2, '0')}:00` } });
    clock = at(date, hour);
    await live.startSession({ tenantId: T, actorUserId: randomUUID(), bcbaStaffProfileId: staffId, appointmentId: appt.id, role });
    clock = new Date(clock.getTime() + minutes * 60000);
    await live.stopSession({ tenantId: T, actorUserId: randomUUID(), bcbaStaffProfileId: staffId, appointmentId: appt.id, role });
    await live.completeSession({ tenantId: T, actorUserId: randomUUID(), bcbaStaffProfileId: staffId, appointmentId: appt.id, role, authorizationId: `svc:${ids.auth}` });
  };

  W.a = await seedOrg(W.T, [['test1', 'Test1', 'J'], ['ellen', 'Ellen', 'Ng'], ['test2', 'Test2', 'K'], ['ann', 'Ann', 'Lee'], ['mia', 'Mia', 'Stone']]);
  const rate = (key, amount) => staffPayRatesPort.setHourlyRate({ tenantId: W.T, staffProfileId: W.a.staff[key], actorUserId: randomUUID(), amount, effectiveFrom: '2026-01-01' });
  await rate('test1', 50); await rate('ellen', 60); await rate('test2', 25); await rate('ann', 30);
  W.addMiaRate = () => staffPayRatesPort.setHourlyRate({ tenantId: W.T, staffProfileId: W.a.staff.mia, actorUserId: randomUUID(), amount: 40 });

  await session(W.T, W.a, 'test1', 'BCBA', '2026-09-02', 9, 30);   // previous week
  await session(W.T, W.a, 'test1', 'BCBA', '2026-09-08', 8, 240);
  await session(W.T, W.a, 'test1', 'BCBA', '2026-09-09', 8, 120);
  await session(W.T, W.a, 'ellen', 'BCBA', '2026-09-10', 9, 90);
  await session(W.T, W.a, 'test2', 'RBT', '2026-09-08', 13, 90);
  await session(W.T, W.a, 'test2', 'RBT', '2026-09-11', 13, 60);
  await session(W.T, W.a, 'ann', 'RBT', '2026-09-12', 10, 45);
  await session(W.T, W.a, 'mia', 'RBT', '2026-09-12', 15, 30);     // no hourly rate yet
  await session(W.T, W.a, 'test1', 'BCBA', '2026-09-14', 9, 60);   // current week (Monday)
  await session(W.T, W.a, 'test2', 'RBT', '2026-09-15', 8, 30);    // current week (Tuesday)

  W.b = await seedOrg(W.T2, [['other', 'Other', 'Person']]);
  await staffPayRatesPort.setHourlyRate({ tenantId: W.T2, staffProfileId: W.b.staff.other, actorUserId: randomUUID(), amount: 99, effectiveFrom: '2026-01-01' });
  await session(W.T2, W.b, 'other', 'BCBA', '2026-09-09', 9, 60);
});
after(async () => { if (skip) return; await mongoose?.disconnect(); await server?.stop(); });

const rows = (data) => data.staff.map((s) => [s.staffName, s.role, s.hourlyRates, s.workedMinutes, s.amount]);

test('weekly on Tuesday 09/15: the completed week 09/07–09/13 — current-week work waits; BCBA and RBT at their own Staff Profile rates', { skip }, async () => {
  const p = await payrollAt(TUESDAY).previewPeriodPayroll(W.T, { mode: 'weekly' });
  assert.deepEqual([p.period.from, p.period.to, p.period.label, p.period.previousAnchor, p.period.nextAnchor], ['2026-09-07', '2026-09-13', '09/07/2026 – 09/13/2026', '2026-08-31', null]);
  assert.deepEqual(p.staff.map((s) => [s.staffName, s.role, s.hourlyRates, s.workedMinutes, s.amount, s.missingRate]), [
    ['Ellen Ng', 'BCBA', [6000], 90, 9000, false],
    ['Test1 J', 'BCBA', [5000], 360, 30000, false],
    ['Ann Lee', 'RBT', [3000], 45, 2250, false],
    ['Mia Stone', 'RBT', [], 30, 0, true],
    ['Test2 K', 'RBT', [2500], 150, 6250, false],
  ]);
  assert.deepEqual([p.summary.totalAmount, p.summary.missingRateCount, p.committedStatus], [47500, 1, null]);
  const worked = await withTenant(W.T, async () => M.SessionTimeRecord.find({ staffProfileId: W.a.staff.test1 }).lean());
  assert.deepEqual(worked.map((r) => r.workedMinutes).sort((a, b) => a - b), [30, 60, 120, 240], 'actual worked time, not the 5-hour bookings');
  await assert.rejects(payrollAt(TUESDAY).previewPeriodPayroll(W.T, { mode: 'weekly', anchor: '2026-09-15' }), /This week has not finished yet/);
});

test('Generate Payroll saves ONE run for the period; downloads are built from it; generating again creates nothing new', { skip }, async () => {
  const svc = payrollAt(TUESDAY);
  await assert.rejects(svc.buildPeriodPayrollWorkbook(W.T, { mode: 'weekly' }), /Payroll has not been generated for this period yet/);
  const run = await svc.generatePeriodPayroll(W.T, { mode: 'weekly' }, randomUUID());
  assert.deepEqual([run.alreadyGenerated, run.updated, run.skipped], [false, false, 1]);
  const g = run.generated;
  assert.deepEqual(rows(g), [['Ellen Ng', 'BCBA', [6000], 90, 9000], ['Test1 J', 'BCBA', [5000], 360, 30000], ['Ann Lee', 'RBT', [3000], 45, 2250], ['Test2 K', 'RBT', [2500], 150, 6250]]);
  assert.deepEqual([g.summary.staffCount, g.summary.totalMinutes, g.summary.totalAmount], [4, 645, 47500]);

  const wb = readPayrollWorkbook((await svc.buildPeriodPayrollWorkbook(W.T, { mode: 'weekly' })).buffer);
  assert.deepEqual(wb.table.map((r) => wb.header.map((h) => r[h].value)), [
    ['Ellen Ng', 'BCBA', 60, '1h 30m', 90], ['Test1 J', 'BCBA', 50, '6h 00m', 300], ['Ann Lee', 'RBT', 30, '0h 45m', 22.5], ['Test2 K', 'RBT', 25, '2h 30m', 62.5],
  ]);
  assert.deepEqual([wb.total['Hours Worked'].value, wb.total.Payout.value], ['10h 45m', 475]);
  const { buffer: pdf, filename } = await svc.buildPeriodPayrollPdf(W.T, { mode: 'weekly' });
  assert.equal(filename, 'payroll-20260907-20260913.pdf');
  const text = readBillPdf(pdf).flat();
  assert.ok(text.includes('Demo ABA Clinic') && text.includes('09/07/2026 – 09/13/2026'));
  for (const r of [['Test1 J', 'BCBA', '$50.00/hr', '6h 00m', '$300.00'], ['Test2 K', 'RBT', '$25.00/hr', '2h 30m', '$62.50']]) {
    assert.ok(text.some((_, i) => r.every((v, k) => text[i + k] === v)), r.join(' | '));
  }
  assert.equal(text[text.indexOf('TOTAL COMPANY PAYROLL') + 2], '$475.00');

  const again = await svc.generatePeriodPayroll(W.T, { mode: 'weekly' }, randomUUID());
  assert.deepEqual([again.alreadyGenerated, again.updated], [true, false]);
  const [runs, lines] = await withTenant(W.T, async () => [await M.PayrollRun.find({}).lean(), await M.PayrollLine.find({}).lean()]);
  assert.deepEqual([runs.length, lines.length, runs[0].totalAmount], [1, 4, 47500]);
  assert.ok(lines.every((l) => l.role && l.hourlyRates?.length), 'each saved line keeps its role and rate');
  // Refresh / reopen: the same saved payroll.
  const reopened = await payrollAt(TUESDAY).getGeneratedPeriodPayroll(W.T, { mode: 'weekly' });
  assert.deepEqual(rows(reopened), rows(g));
  const preview = await svc.previewPeriodPayroll(W.T, { mode: 'weekly' });
  assert.deepEqual([preview.committedStatus, preview.generatedUpToDate], ['DRAFT', true]);
});

test('a missing hourly rate added later: the payroll shows it has changed, and Update rebuilds the same run', { skip }, async () => {
  await W.addMiaRate();
  const svc = payrollAt(TUESDAY);
  const preview = await svc.previewPeriodPayroll(W.T, { mode: 'weekly' });
  assert.equal(preview.generatedUpToDate, false);
  assert.deepEqual(preview.staff.find((s) => s.staffName === 'Mia Stone').amount, 2000); // 30 min × $40
  const run = await svc.generatePeriodPayroll(W.T, { mode: 'weekly' }, randomUUID());
  assert.deepEqual([run.alreadyGenerated, run.updated, run.generated.summary.totalAmount, run.generated.staff.length], [false, true, 49500, 5]);
  const runs = await withTenant(W.T, async () => M.PayrollRun.find({}).lean());
  assert.equal(runs.length, 1, 'still one payroll run for the period');
});

test('after Sunday ends, the next weekly period (09/14–09/20) includes the new week’s work', { skip }, async () => {
  const p = await payrollAt(NEXT_MONDAY).previewPeriodPayroll(W.T, { mode: 'weekly' });
  assert.deepEqual([p.period.from, p.period.to], ['2026-09-14', '2026-09-20']);
  assert.deepEqual(rows(p), [['Test1 J', 'BCBA', [5000], 60, 5000], ['Test2 K', 'RBT', [2500], 30, 1250]]);
  assert.equal(p.summary.totalAmount, 6250);
  const back = await payrollAt(NEXT_MONDAY).previewPeriodPayroll(W.T, { mode: 'weekly', anchor: p.period.previousAnchor });
  assert.deepEqual([back.period.from, back.committedStatus], ['2026-09-07', 'DRAFT'], 'the previous generated week can be reopened');
});

test('bi-weekly: two completed Monday–Sunday weeks, worked time combined across both weeks', { skip }, async () => {
  const tue = await payrollAt(TUESDAY).previewPeriodPayroll(W.T, { mode: 'biweekly' });
  assert.deepEqual([tue.period.from, tue.period.to], ['2026-08-24', '2026-09-06'], '09/07–09/20 is not finished on Tuesday 09/15');
  assert.deepEqual(rows(tue), [['Test1 J', 'BCBA', [5000], 30, 2500]]);
  await assert.rejects(payrollAt(TUESDAY).previewPeriodPayroll(W.T, { mode: 'biweekly', anchor: '2026-09-15' }), /This pay period has not finished yet/);

  const mon = await payrollAt(NEXT_MONDAY).previewPeriodPayroll(W.T, { mode: 'biweekly' });
  assert.deepEqual([mon.period.from, mon.period.to, mon.period.label], ['2026-09-07', '2026-09-20', '09/07/2026 – 09/20/2026']);
  assert.deepEqual(rows(mon), [
    ['Ellen Ng', 'BCBA', [6000], 90, 9000],
    ['Test1 J', 'BCBA', [5000], 420, 35000],   // 6h 00m + 1h 00m
    ['Ann Lee', 'RBT', [3000], 45, 2250],
    ['Mia Stone', 'RBT', [4000], 30, 2000],
    ['Test2 K', 'RBT', [2500], 180, 7500],     // 2h 30m + 0h 30m
  ]);
  assert.equal(mon.summary.totalAmount, 55750);
  const gen = await payrollAt(NEXT_MONDAY).generatePeriodPayroll(W.T, { mode: 'biweekly' }, randomUUID());
  assert.equal(gen.generated.summary.totalAmount, 55750);
});

test('custom: only work inside the exact From–To range; From after To is refused', { skip }, async () => {
  const svc = payrollAt(TUESDAY);
  const c = await svc.previewPeriodPayroll(W.T, { mode: 'custom', from: '2026-09-09', to: '2026-09-11' });
  assert.deepEqual([c.period.from, c.period.to, c.period.label], ['2026-09-09', '2026-09-11', '09/09/2026 – 09/11/2026']);
  assert.deepEqual(rows(c), [['Ellen Ng', 'BCBA', [6000], 90, 9000], ['Test1 J', 'BCBA', [5000], 120, 10000], ['Test2 K', 'RBT', [2500], 60, 2500]]);
  assert.equal(c.summary.totalAmount, 21500);
  await assert.rejects(svc.previewPeriodPayroll(W.T, { mode: 'custom', from: '2026-09-12', to: '2026-09-11' }), /From Date must be on or before To Date/);
  const gen = await svc.generatePeriodPayroll(W.T, { mode: 'custom', from: '2026-09-09', to: '2026-09-11' }, randomUUID());
  const wb = readPayrollWorkbook((await svc.buildPeriodPayrollWorkbook(W.T, { mode: 'custom', from: '2026-09-09', to: '2026-09-11' })).buffer);
  assert.deepEqual([gen.generated.summary.totalAmount, wb.total.Payout.value], [21500, 215]);
  await assert.rejects(svc.generatePeriodPayroll(W.T, { mode: 'custom', from: '2026-10-01', to: '2026-10-02' }, randomUUID()), /No staff worked during this payroll period/);
});

test('tenant isolation: each organization pays only its own staff', { skip }, async () => {
  const other = await payrollAt(TUESDAY).previewPeriodPayroll(W.T2, { mode: 'weekly' });
  assert.deepEqual(rows(other), [['Other Person', 'BCBA', [9900], 60, 9900]]);
  assert.equal(await payrollAt(TUESDAY).getGeneratedPeriodPayroll(W.T2, { mode: 'weekly' }), null);
  const mine = await payrollAt(TUESDAY).getGeneratedPeriodPayroll(W.T, { mode: 'weekly' });
  assert.ok(!mine.staff.some((s) => s.staffName === 'Other Person'));
});

test('RBAC: preview, generated payroll and downloads need payroll.read; generation needs payroll.manage', { skip }, async () => {
  const router = createPayrollRouter(payrollAt(TUESDAY));
  const demanded = async (method, path) => {
    const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
    let error;
    await layer.route.stack[0].handle({ principal: { permissions: new Set() } }, {}, (e) => { error = e; });
    return /Missing permission: (\S+)/.exec(error?.message ?? '')?.[1];
  };
  assert.equal(await demanded('get', '/period/preview'), 'payroll.read');
  assert.equal(await demanded('get', '/period/generated'), 'payroll.read');
  assert.equal(await demanded('get', '/period/export.xlsx'), 'payroll.read');
  assert.equal(await demanded('get', '/period/export.pdf'), 'payroll.read');
  assert.equal(await demanded('post', '/period/generate'), 'payroll.manage');
});
