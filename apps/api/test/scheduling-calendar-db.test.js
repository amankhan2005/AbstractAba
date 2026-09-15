import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * SCHEDULING CALENDAR + RESCHEDULE — against a REAL MongoDB.
 *
 *   • GET appointments carries display names (client, BCBA, RBT) from one
 *     batched read — the calendar never needs per-appointment requests.
 *   • The list cursor pages in the SAME order it sorts (startAt, id): a range
 *     loaded page by page returns every appointment exactly once.
 *   • Rescheduling an appointment created by the current booking flow uses that
 *     flow's rules (it used to fail with STAFF_NOT_ELIGIBLE): a date-only
 *     appointment stays date-only on whole business days, the clinician and
 *     authorizations are re-validated, and a stale version is refused.
 *   • Tenant isolation, clinician data scope and RBAC are unchanged.
 */
const CANDIDATES = [process.env.MONGOMS_SYSTEM_BINARY, '/opt/homebrew/bin/mongod', '/usr/local/bin/mongod', '/usr/bin/mongod'].filter(Boolean);
const MONGOD = CANDIDATES.find((p) => existsSync(p)) ?? null;
const skip = MONGOD ? false : 'no local mongod binary (set MONGOMS_SYSTEM_BINARY)';

const TZ = 'America/New_York';
let server; let mongoose; let M; let withTenant; let zonedWallTimeToUtc;
let clientsService; let schedulingService; let SchedulingService; let schedulingRepository; let createSchedulingRouter;
let svc;
const W = {};
const range = {};
const ACTOR = () => randomUUID();

before(async () => {
  if (skip) return;
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  server = await MongoMemoryServer.create({ binary: { systemBinary: MONGOD } });
  mongoose = (await import('mongoose')).default;
  await mongoose.connect(server.getUri(), { monitorCommands: true });
  M = await import('../src/models/index.js');
  ({ withTenant } = await import('../src/tenancy/tenantContext.js'));
  ({ zonedWallTimeToUtc } = await import('../src/domain/businessDate.js'));
  ({ clientsService } = await import('../src/modules/clients/index.js'));
  ({ schedulingService, SchedulingService, schedulingRepository } = await import('../src/modules/scheduling/index.js'));
  ({ createSchedulingRouter } = await import('../src/modules/scheduling/scheduling.routes.js'));
  await Promise.all(Object.values(M).filter((m) => m?.syncIndexes).map((m) => m.syncIndexes()));
  Object.assign(range, { from: zonedWallTimeToUtc(2026, 8, 1, 0, 0, 0, TZ).toISOString(), to: zonedWallTimeToUtc(2026, 10, 1, 0, 0, 0, TZ).toISOString() });
  svc = new SchedulingService({ ...schedulingService.deps, clock: { now: () => zonedWallTimeToUtc(2026, 9, 14, 9, 0, 0, TZ) } });

  const org = (slug) => M.Organization.create({ slug, legalName: slug, tradingName: slug, state: 'ACTIVE', countryCode: 'US', timezone: TZ, primaryContactName: 'O', primaryContactEmail: `${slug}@example.com` });
  W.T = (await org('cal-acme'))._id;
  W.T2 = (await org('cal-other'))._id;
  const seed = async (tenant, prefix) => withTenant(tenant, async () => {
    const bcba = await M.StaffProfile.create({ userId: randomUUID(), firstName: `${prefix}Ada`, lastName: 'Lovelace', status: 'ACTIVE' });
    const rbt = await M.StaffProfile.create({ userId: randomUUID(), firstName: `${prefix}Nia`, lastName: 'Patel', status: 'ACTIVE' });
    const client = await M.Client.create({ clientNumber: `${prefix}C-1`, firstName: `${prefix}Mia`, lastName: 'Khan', status: 'ACTIVE' });
    await M.Guardian.create({ clientId: client._id, firstName: 'Sarah', lastName: 'Khan', phone: '5551234567', email: `${prefix}s@example.com`, relationship: 'PARENT', isPrimary: true });
    const bcbaAssignment = await M.ClientAssignment.create({ clientId: client._id, staffProfileId: bcba._id, role: 'BCBA', status: 'ACTIVE' });
    await M.ClientAssignment.create({ clientId: client._id, staffProfileId: rbt._id, role: 'RBT', status: 'ACTIVE' });
    return { bcba: bcba._id, rbt: rbt._id, client: client._id, bcbaAssignment: bcbaAssignment._id };
  });
  W.a = await seed(W.T, '');
  W.b = await seed(W.T2, 'X');
  const auth = await clientsService.createServiceAuthorization({ tenantId: W.T, clientId: W.a.client, actorUserId: ACTOR(),
    input: { serviceType: 'ABA', authorizationNumber: 'ABA-CAL', units: 400, startDate: '2026-09-01T00:00:00.000Z', endDate: '2026-12-31T00:00:00.000Z' } });
  W.auth = `svc:${auth.id}`;
  W.authRaw = auth.id;
});
after(async () => { if (skip) return; await mongoose?.disconnect(); await server?.stop(); });

const book = (input) => svc.bookAppointment({ tenantId: W.T, actorUserId: ACTOR(), input: { clientId: W.a.client, authorizationIds: [W.auth], units: 4, ...input } });

test('the calendar list carries client and clinician names from one batched read', { skip }, async () => {
  const bcbaAppt = await book({ bcbaId: W.a.bcba, startDate: '2026-09-15' });
  const rbtAppt = await book({ rbtId: W.a.rbt, startDate: '2026-09-15' });
  const { items } = await schedulingService.listAppointments({ tenantId: W.T, limit: 100, ...range });
  const byId = Object.fromEntries(items.map((a) => [a.id, a]));
  assert.equal(byId[bcbaAppt.id].clientName, 'Mia Khan');
  assert.equal(byId[bcbaAppt.id].bcbaName, 'Ada Lovelace');
  assert.equal(byId[bcbaAppt.id].rbtName, null, 'one clinician per new appointment');
  assert.equal(byId[rbtAppt.id].rbtName, 'Nia Patel');
  assert.equal(byId[rbtAppt.id].bcbaName, null);
  assert.equal(byId[rbtAppt.id].timeSet, false, 'booked date-only');

  // Names are read with one query per collection, not one per appointment.
  const ops = [];
  const onCmd = (e) => { if (e.commandName === 'find') ops.push(e.command.find); };
  const conn = mongoose.connection.getClient();
  conn.on('commandStarted', onCmd);
  await schedulingService.listAppointments({ tenantId: W.T, limit: 100, ...range });
  conn.off('commandStarted', onCmd);
  assert.ok(ops.includes('appointments') || ops.some((c) => /appointment/i.test(c)), `commands were captured: ${ops}`);
  assert.ok(ops.filter((c) => /client/i.test(c) && !/assign/i.test(c)).length <= 1, `client lookups: ${ops}`);
  assert.ok(ops.filter((c) => /staff/i.test(c)).length <= 1, `staff lookups: ${ops}`);

  const detail = await schedulingService.getAppointment({ tenantId: W.T, appointmentId: bcbaAppt.id });
  assert.equal(detail.clientName, 'Mia Khan');
  assert.equal(detail.bcbaName, 'Ada Lovelace');
});

test('a range loaded page by page returns every appointment exactly once, in date order', { skip }, async () => {
  for (const day of ['2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20']) await book({ bcbaId: W.a.bcba, startDate: day });
  const all = (await schedulingService.listAppointments({ tenantId: W.T, limit: 100, ...range })).items;
  const paged = [];
  let cursor;
  for (let i = 0; i < 20; i += 1) {
    const page = await schedulingService.listAppointments({ tenantId: W.T, limit: 2, ...range, ...(cursor ? { cursor } : {}) });
    paged.push(...page.items);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  assert.equal(paged.length, all.length);
  assert.equal(new Set(paged.map((a) => a.id)).size, all.length, 'no duplicates');
  const starts = paged.map((a) => new Date(a.startAt).getTime());
  assert.deepEqual(starts, [...starts].sort((x, y) => x - y), 'ascending by start');
});

test('reschedule of a current (date-only) appointment works and stays date-only on whole business days', { skip }, async () => {
  const appt = await book({ bcbaId: W.a.bcba, startDate: '2026-09-22' });
  const updated = await svc.updateAppointment({ tenantId: W.T, appointmentId: appt.id, actorUserId: ACTOR(), expectedVersion: appt.version,
    input: { startAt: zonedWallTimeToUtc(2026, 9, 24, 0, 0, 0, TZ).toISOString(), endAt: zonedWallTimeToUtc(2026, 9, 26, 0, 0, 0, TZ).toISOString(), units: 6 } });
  assert.equal(updated.timeSet, false);
  assert.equal(new Date(updated.startAt).toISOString(), zonedWallTimeToUtc(2026, 9, 24, 0, 0, 0, TZ).toISOString());
  assert.equal(new Date(updated.endAt).toISOString(), zonedWallTimeToUtc(2026, 9, 26, 0, 0, 0, TZ).toISOString(), 'covers 09/24 and 09/25');
  assert.equal(updated.units, 6);
  // A clock time sent for a date-only appointment is not recorded: it is re-anchored to the business day.
  const again = await svc.updateAppointment({ tenantId: W.T, appointmentId: appt.id, actorUserId: ACTOR(), expectedVersion: updated.version,
    input: { startAt: zonedWallTimeToUtc(2026, 9, 27, 13, 30, 0, TZ).toISOString(), endAt: zonedWallTimeToUtc(2026, 9, 27, 15, 0, 0, TZ).toISOString() } });
  assert.equal(new Date(again.startAt).toISOString(), zonedWallTimeToUtc(2026, 9, 27, 0, 0, 0, TZ).toISOString());
  assert.equal(new Date(again.endAt).toISOString(), zonedWallTimeToUtc(2026, 9, 28, 0, 0, 0, TZ).toISOString());
  assert.equal(again.timeSet, false);
  // burn-down follows the unit change (4 → 6 → 6)
  const sa = await withTenant(W.T, async () => await M.ServiceAuthorization.findById(W.authRaw).lean());
  assert.ok(sa.usedUnits >= 6);
  // stale version
  await assert.rejects(
    svc.updateAppointment({ tenantId: W.T, appointmentId: appt.id, actorUserId: ACTOR(), expectedVersion: appt.version, input: { units: 5 } }),
    (e) => e.code === 'VERSION_CONFLICT',
  );
});

test('reschedule re-validates: an ended clinician assignment or a denied authorization is refused', { skip }, async () => {
  const rbtAppt = await book({ rbtId: W.a.rbt, startDate: '2026-09-23' });
  const denied = await clientsService.createServiceAuthorization({ tenantId: W.T, clientId: W.a.client, actorUserId: ACTOR(),
    input: { serviceType: 'FBA', authorizationNumber: 'FBA-DEN', units: 40, startDate: '2026-09-01T00:00:00.000Z', endDate: '2026-12-31T00:00:00.000Z' } });
  const usingDenied = await book({ bcbaId: W.a.bcba, authorizationIds: [`svc:${denied.id}`], startDate: '2026-09-23' });
  for (const target of ['SENT', 'DENIED']) {
    await clientsService.transitionServiceAuthorization({ tenantId: W.T, clientId: W.a.client, authorizationId: denied.id, actorUserId: ACTOR(), target, reason: 'Payer denied' });
  }
  const move = (a) => svc.updateAppointment({ tenantId: W.T, appointmentId: a.id, actorUserId: ACTOR(), expectedVersion: a.version,
    input: { startAt: zonedWallTimeToUtc(2026, 9, 29, 0, 0, 0, TZ).toISOString(), endAt: zonedWallTimeToUtc(2026, 9, 30, 0, 0, 0, TZ).toISOString() } });
  await assert.rejects(move(usingDenied), (e) => e.code === 'AUTHORIZATION_INVALID');

  await withTenant(W.T, async () => await M.ClientAssignment.updateMany({ clientId: W.a.client, role: 'RBT' }, { $set: { status: 'ENDED', effectiveEndDate: new Date() } }));
  await assert.rejects(move(rbtAppt), (e) => e.code === 'RBT_NOT_ASSIGNED');
  const unchanged = await schedulingService.getAppointment({ tenantId: W.T, appointmentId: rbtAppt.id });
  assert.equal(new Date(unchanged.startAt).toISOString(), new Date(rbtAppt.startAt).toISOString(), 'nothing written on refusal');
  await withTenant(W.T, async () => await M.ClientAssignment.updateMany({ clientId: W.a.client, role: 'RBT' }, { $set: { status: 'ACTIVE', effectiveEndDate: null } }));
});

test('tenant isolation and clinician scope: another company sees nothing; a clinician sees only their own appointments', { skip }, async () => {
  const other = await schedulingService.listAppointments({ tenantId: W.T2, limit: 100, ...range });
  assert.equal(other.items.length, 0);
  const anyId = (await schedulingService.listAppointments({ tenantId: W.T, limit: 1, ...range })).items[0].id;
  await assert.rejects(schedulingService.getAppointment({ tenantId: W.T2, appointmentId: anyId }), (e) => e.code === 'APPOINTMENT_NOT_FOUND');
  await assert.rejects(
    svc.updateAppointment({ tenantId: W.T2, appointmentId: anyId, actorUserId: ACTOR(), expectedVersion: 1, input: { units: 2 } }),
    (e) => e.code === 'APPOINTMENT_NOT_FOUND',
  );
  const rbtScope = { scope: 'ASSIGNED', staffProfileId: W.a.rbt, clientIds: [W.a.client], staffIds: [W.a.rbt] };
  const mine = await schedulingService.listAppointments({ tenantId: W.T, limit: 100, ...range, dataScope: rbtScope });
  assert.ok(mine.items.length > 0);
  assert.ok(mine.items.every((a) => a.rbtId === W.a.rbt), 'only appointments assigned to this RBT');
});

test('RBAC unchanged: reads need scheduling.read; book, reschedule and cancel need scheduling.write', { skip }, async () => {
  const router = createSchedulingRouter({});
  const demanded = async (method, path) => {
    const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
    let error;
    await layer.route.stack[0].handle({ principal: { permissions: new Set() } }, {}, (e) => { error = e; });
    return /Missing permission: (\S+)/.exec(error?.message ?? '')?.[1];
  };
  assert.equal(await demanded('get', '/appointments'), 'scheduling.read');
  assert.equal(await demanded('get', '/appointments/:appointmentId'), 'scheduling.read');
  assert.equal(await demanded('post', '/appointments'), 'scheduling.write');
  assert.equal(await demanded('patch', '/appointments/:appointmentId'), 'scheduling.write');
  assert.equal(await demanded('post', '/appointments/:appointmentId/cancel'), 'scheduling.write');
});

test('Start session (API): a Company Admin cannot start a clinician session; the assigned BCBA still can', { skip }, async () => {
  const { BcbaSessionService, bcbaSessionService } = await import('../src/modules/bcba-session/index.js');
  const { resolveDataScope } = await import('../src/modules/rbac/dataScope.js');
  const sessions = new BcbaSessionService({ ...bcbaSessionService.deps, clock: { now: () => zonedWallTimeToUtc(2026, 9, 14, 10, 0, 0, TZ) } });
  const appt = await book({ bcbaId: W.a.bcba, startDate: '2026-09-14' });
  const start = (staffProfileId, role = 'BCBA') => sessions.startSession({ tenantId: W.T, actorUserId: ACTOR(), bcbaStaffProfileId: staffProfileId, appointmentId: appt.id, role });

  // A Company Admin user has no clinician staff profile: the route resolves
  // staffProfileId from the token (never the body), so it is null and refused.
  const adminUserId = randomUUID();
  const adminScope = await withTenant(W.T, async () => await resolveDataScope({ userId: adminUserId }, 'ORGANIZATION'));
  assert.equal(adminScope.staffProfileId, null);
  await assert.rejects(start(adminScope.staffProfileId), (e) => e.code === 'MISSING_STAFF_PROFILE');

  // An administrator who does have a staff profile, but is not this appointment's
  // BCBA, is refused too — ownership is the appointment's bcbaId.
  const adminProfile = await withTenant(W.T, async () => (await M.StaffProfile.create({ userId: adminUserId, firstName: 'Office', lastName: 'Admin', status: 'ACTIVE' }))._id);
  await assert.rejects(start(adminProfile), (e) => e.code === 'NOT_YOUR_APPOINTMENT');
  // The RBT panel cannot start a BCBA appointment either.
  await assert.rejects(start(W.a.rbt, 'RBT'), (e) => e.code === 'NOT_YOUR_APPOINTMENT');
  const none = await withTenant(W.T, async () => await M.Session.countDocuments({ appointmentId: appt.id }));
  assert.equal(none, 0, 'nothing was created by the refused calls');

  // The assigned BCBA's existing workflow is unchanged.
  const session = await start(W.a.bcba);
  assert.ok(session.id || session.session?.id, 'session started');
  const created = await withTenant(W.T, async () => await M.Session.countDocuments({ appointmentId: appt.id }));
  assert.equal(created, 1);
});

test('Start session routes still require sessions.write (guard unchanged)', { skip }, async () => {
  const { bcbaSessionRouter, rbtSessionRouter } = await import('../src/modules/bcba-session/index.js');
  for (const router of [bcbaSessionRouter, rbtSessionRouter]) {
    const layer = router.stack.find((l) => l.route?.path === '/appointments/:appointmentId/start' && l.route.methods.post);
    let error;
    await layer.route.stack[0].handle({ principal: { permissions: new Set() } }, {}, (e) => { error = e; });
    assert.match(error?.message ?? '', /Missing permission: sessions\.write/);
  }
});
