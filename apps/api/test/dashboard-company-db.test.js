import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * COMPANY DASHBOARD (GET /dashboards/company) — against a REAL MongoDB.
 *
 * Drives DashboardsService over the production repository, models, tenant
 * plugin and indexes, with the business clock pinned to 09/14/2026 10:00 AM
 * America/New_York. Every expectation is derived from records seeded here;
 * the tests also check the dashboard agrees with the Clients page, Client
 * detail alerts and the Appointment Notes rules.
 */

const CANDIDATES = [process.env.MONGOMS_SYSTEM_BINARY, '/opt/homebrew/bin/mongod', '/usr/local/bin/mongod', '/usr/bin/mongod'].filter(Boolean);
const MONGOD = CANDIDATES.find((p) => existsSync(p)) ?? null;
const skip = MONGOD ? false : 'no local mongod binary (set MONGOMS_SYSTEM_BINARY)';

const TZ = 'America/New_York';
let server; let mongoose; let M; let withTenant; let wall;
let DashboardsService; let dashboardsRepository; let AppointmentNotesService; let appointmentNotesService;
let clientsService; let bcbaSessionService; let computeChildAlerts; let organizationService;
const W = {};

const NOW = () => wall(2026, 9, 14, 10, 0);

before(async () => {
  if (skip) return;
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  server = await MongoMemoryServer.create({ binary: { systemBinary: MONGOD } });
  mongoose = (await import('mongoose')).default;
  await mongoose.connect(server.getUri());
  M = await import('../src/models/index.js');
  ({ withTenant } = await import('../src/tenancy/tenantContext.js'));
  const bd = await import('../src/domain/businessDate.js');
  wall = (y, mo, d, h, mi = 0) => bd.zonedWallTimeToUtc(y, mo, d, h, mi, 0, TZ);
  ({ DashboardsService, dashboardsRepository } = await import('../src/modules/dashboards/index.js'));
  ({ AppointmentNotesService, appointmentNotesService } = await import('../src/modules/scheduling/index.js'));
  ({ clientsService } = await import('../src/modules/clients/index.js'));
  ({ bcbaSessionService } = await import('../src/modules/bcba-session/index.js'));
  ({ computeChildAlerts } = await import('../src/modules/clients/clients.alerts.js'));
  ({ organizationService } = await import('../src/modules/organization/index.js'));
  await Promise.all(Object.values(M).filter((m) => m?.syncIndexes).map((m) => m.syncIndexes()));

  const makeOrg = (slug) => M.Organization.create({
    slug, legalName: slug, tradingName: slug, state: 'ACTIVE', countryCode: 'US', timezone: TZ,
    primaryContactName: 'Owner', primaryContactEmail: `${slug}@example.com`,
  });
  W.T = (await makeOrg('dash-acme'))._id;
  W.T2 = (await makeOrg('dash-other'))._id;
  W.T3 = (await makeOrg('dash-empty'))._id;

  const roleIds = {};
  const staff = async (tenant, first, last, roleKey, status = 'ACTIVE') => {
    const userId = randomUUID();
    const sp = await M.StaffProfile.create({ userId, firstName: first, lastName: last, status });
    const k = `${tenant}:${roleKey}`;
    if (!roleIds[k]) roleIds[k] = (await M.Role.create({ key: roleKey, name: roleKey.toUpperCase() }))._id;
    const m = await M.Membership.create({ userId, status: 'ACTIVE' });
    await M.MembershipRole.create({ membershipId: m._id, roleId: roleIds[k] });
    return sp._id;
  };
  const client = (number, first, last, status, intakeWorkflowStatus, extra = {}) => M.Client.create({ clientNumber: number, firstName: first, lastName: last, status, intakeWorkflowStatus, ...extra });
  const parent = (clientId, extra = {}) => M.Guardian.create({ clientId, firstName: 'Jane', lastName: 'Parent', phone: '5551234567', email: `p-${randomUUID()}@example.com`, relationship: 'PARENT', ...extra });
  const appt = (fields) => M.Appointment.create({ authorizationId: 'svc:none', units: 4, status: 'SCHEDULED', ...fields, staffProfileId: fields.bcbaId ?? fields.rbtId });

  await withTenant(W.T, async () => {
    W.bcba = await staff(W.T, 'test1', 'J', 'bcba');
    await staff(W.T, 'Priya', 'Shah', 'bcba', 'INACTIVE');   // inactive → not counted
    W.rbt = await staff(W.T, 'Nia', 'Patel', 'rbt');
    W.rbt2 = await staff(W.T, 'Omar', 'Diaz', 'rbt');
    await staff(W.T, 'Ops', 'Admin', 'org_admin');           // unrelated role → not counted

    // CLIENTS — total 5 (archived excluded), active 2, inactive 3.
    const A = await client('C-A', 'Raymond', 'K', 'ACTIVE', 'COMPLETE');
    await parent(A._id);
    const B = await client('C-B', 'Ada', 'B', 'ACTIVE', 'COMPLETE');
    await parent(B._id, { email: null });                     // incomplete parent
    const C = await client('C-C', 'Cam', 'N', 'REFERRED', 'NOT_SENT'); // no parent + intake open
    const D = await client('C-D', 'Dee', 'D', 'DISCHARGED', 'NOT_SENT'); // discharged → not attention
    const E = await client('C-E', 'Eve', 'E', 'ON_HOLD', 'MISSING_DOCUMENTS');
    await parent(E._id);
    const F = await client('C-F', 'Fay', 'F', 'ACTIVE', 'NOT_SENT', { deletedAt: new Date() }); // archived
    Object.assign(W, { A: A._id, B: B._id, C: C._id, D: D._id, E: E._id, F: F._id });
    for (const c of [A, B, C, E]) {
      await M.ClientAssignment.create({ clientId: c._id, staffProfileId: W.bcba, role: 'BCBA', status: 'ACTIVE' });
      await M.ClientAssignment.create({ clientId: c._id, staffProfileId: W.rbt, role: 'RBT', status: 'ACTIVE' });
    }

    // AUTHORIZATIONS — only auth1 is expiring soon.
    const auth = (clientId, number, endDate, extra = {}) => M.ServiceAuthorization.create({
      clientId, serviceType: 'ABA', status: 'NOT_SENT', authorizationNumber: number, billingCode: '97153',
      startDate: new Date('2026-08-01T00:00:00Z'), endDate: new Date(endDate), units: 400, ...extra,
    });
    W.auth1 = (await auth(A._id, 'AUTH-SOON', '2026-09-20T00:00:00Z'))._id;
    W.authManual = (await auth(A._id, 'AUTH-MANUAL', '2026-12-31T00:00:00Z', { status: 'APPROVED' }))._id;
    await auth(B._id, 'AUTH-LATER', '2026-12-31T00:00:00Z', { status: 'APPROVED' });
    await auth(C._id, 'AUTH-DENIED', '2026-09-30T00:00:00Z', { status: 'DENIED' });
    await auth(A._id, 'AUTH-EXPIRED', '2026-09-10T00:00:00Z');
    await auth(F._id, 'AUTH-ARCHIVED-CLIENT', '2026-09-25T00:00:00Z');
    await auth(B._id, 'AUTH-DELETED', '2026-09-22T00:00:00Z', { deletedAt: new Date() });

    // TODAY (09/14 NY)
    W.apptTimed = (await appt({ clientId: A._id, bcbaId: W.bcba, startAt: wall(2026, 9, 14, 10, 0), endAt: wall(2026, 9, 14, 11, 30), timeSet: true, status: 'COMPLETED' }))._id;
    W.apptRange = (await appt({ clientId: B._id, rbtId: W.rbt2, startAt: wall(2026, 9, 12, 0), endAt: wall(2026, 10, 1, 0), timeSet: false }))._id;
    W.apptNoteClient = (await appt({ clientId: C._id, bcbaId: W.bcba, startAt: wall(2026, 9, 14, 15, 0), endAt: wall(2026, 9, 14, 16, 0), timeSet: true }))._id;
    W.apptLate = (await appt({ clientId: E._id, bcbaId: W.bcba, startAt: wall(2026, 9, 14, 22, 30), endAt: wall(2026, 9, 14, 23, 30), timeSet: true }))._id; // 02:30 UTC 09/15
    W.apptYesterdayLate = (await appt({ clientId: E._id, bcbaId: W.bcba, startAt: wall(2026, 9, 13, 23, 0), endAt: wall(2026, 9, 13, 23, 45), timeSet: true }))._id; // 03:00 UTC 09/14
    W.apptTomorrow = (await appt({ clientId: A._id, bcbaId: W.bcba, startAt: wall(2026, 9, 15, 10, 0), endAt: wall(2026, 9, 15, 11, 0), timeSet: true }))._id;

    // Persisted session + time record for the timed appointment (actual 10:05–11:35).
    const s1 = await M.Session.create({ appointmentId: W.apptTimed, clientId: A._id, staffProfileId: W.bcba, startedAt: wall(2026, 9, 14, 10, 5), endedAt: wall(2026, 9, 14, 11, 35), status: 'FROZEN', active: false });
    await M.SessionTimeRecord.create({ staffProfileId: W.bcba, clientId: A._id, sessionId: s1._id, appointmentId: W.apptTimed, startedAt: wall(2026, 9, 14, 10, 5), endedAt: wall(2026, 9, 14, 11, 35), workedMinutes: 90 });
    W.s1 = s1._id;

    // Older sessions for "latest 4".
    const older = async (d, h, minutes) => {
      const ap = await appt({ clientId: B._id, rbtId: W.rbt, startAt: wall(2026, 9, d, h), endAt: wall(2026, 9, d, h + 1), timeSet: true, status: 'COMPLETED' });
      const s = await M.Session.create({ appointmentId: ap._id, clientId: B._id, staffProfileId: W.rbt, startedAt: wall(2026, 9, d, h), endedAt: wall(2026, 9, d, h + 1), status: 'FROZEN', active: false });
      await M.SessionTimeRecord.create({ staffProfileId: W.rbt, clientId: B._id, sessionId: s._id, appointmentId: ap._id, startedAt: wall(2026, 9, d, h), endedAt: wall(2026, 9, d, h + 1), workedMinutes: minutes });
      return s._id;
    };
    W.s12 = await older(12, 9, 60);
    W.s11 = await older(11, 9, 55);
    W.s10 = await older(10, 9, 50);
  });

  // MANUAL SESSION through the real pipeline — RBT, today 08:00–09:15.
  W.manual = await bcbaSessionService.createManualSession({
    tenantId: W.T, actorUserId: randomUUID(), bcbaStaffProfileId: W.rbt, role: 'RBT',
    input: { clientId: W.A, date: '2026-09-14', startTime: '08:00', endTime: '09:15', authorizationIds: [`svc:${W.authManual}`] },
  });

  // OTHER TENANT — must never leak.
  await withTenant(W.T2, async () => {
    const other = await staff(W.T2, 'Other', 'Bcba', 'bcba');
    const oc = await client('X-1', 'Leak', 'Client', 'ACTIVE', 'NOT_SENT');
    await M.ServiceAuthorization.create({ clientId: oc._id, serviceType: 'ABA', status: 'APPROVED', endDate: new Date('2026-09-18T00:00:00Z') });
    const oa = await appt({ clientId: oc._id, bcbaId: other, startAt: wall(2026, 9, 14, 12, 0), endAt: wall(2026, 9, 14, 13, 0), timeSet: true });
    await M.Session.create({ appointmentId: oa._id, clientId: oc._id, staffProfileId: other, startedAt: wall(2026, 9, 14, 12, 0), status: 'IN_PROGRESS' });
  });

  // APPOINTMENT NOTES
  const notesAt = (now) => new AppointmentNotesService({ ...appointmentNotesService.deps, clock: { now: () => now } });
  const stamp = async (appointmentId, serviceDate, at) => withTenant(W.T, async () => {
    await M.AppointmentNote.collection.updateOne({ tenantId: W.T, appointmentId, serviceDate }, { $set: { createdAt: at, updatedAt: at } });
  });
  const bcbaCtx = { tenantId: W.T, actorUserId: randomUUID(), actorRole: 'BCBA', actorStaffProfileId: W.bcba, scope: 'TEAM' };
  // 09/13 note (yesterday) — must not appear.
  await notesAt(wall(2026, 9, 13, 16, 0)).saveNote({ ...bcbaCtx, appointmentId: W.apptYesterdayLate, note: 'Yesterday note', clientId: null });
  await stamp(W.apptYesterdayLate, '2026-09-13', wall(2026, 9, 13, 16, 0));
  // Today: no client selected on the Raymond K appointment.
  await notesAt(wall(2026, 9, 14, 9, 0)).saveNote({ ...bcbaCtx, appointmentId: W.apptTimed, note: 'Worked on requesting.', clientId: null });
  await stamp(W.apptTimed, '2026-09-14', wall(2026, 9, 14, 9, 0));
  // Today: client Eve E explicitly selected on Cam N's appointment.
  await notesAt(wall(2026, 9, 14, 9, 30)).saveNote({ ...bcbaCtx, appointmentId: W.apptNoteClient, note: 'Plan with Eve.', clientId: W.E });
  await stamp(W.apptNoteClient, '2026-09-14', wall(2026, 9, 14, 9, 30));
  // An RBT-authored row (cannot be created through the service) — must not appear.
  await withTenant(W.T, async () => {
    await M.AppointmentNote.create({ appointmentId: W.apptRange, serviceDate: '2026-09-14', authorStaffProfileId: W.rbt, clientId: null, body: 'sealed:rbt', createdAt: wall(2026, 9, 14, 8, 0), updatedAt: wall(2026, 9, 14, 8, 0) });
  });

  W.service = new DashboardsService({
    repository: dashboardsRepository,
    organizations: { getById: (id) => organizationService.getById(id) },
    appointmentNotes: notesAt(NOW()),
    now: NOW,
  });
  W.dash = await W.service.companyDashboard({ tenantId: W.T, includeNotes: true });
});

after(async () => {
  if (skip) return;
  await mongoose?.disconnect();
  await server?.stop();
});

const timeIn = (instant) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(instant));

test('business date and timezone come from the organization and the server clock', { skip }, () => {
  assert.equal(W.dash.businessDate, '2026-09-14');
  assert.equal(W.dash.timeZone, TZ);
});

test('client counts: total / active / inactive use the Clients page ACCOUNT rule — archived excluded, numbers agree', { skip }, async () => {
  // A: valid parent → Active. B: incomplete parent → Hold. C: no parent → Hold.
  // D: discharged. E: explicitly on hold (valid parent) → Hold.
  assert.deepEqual(
    { total: W.dash.clients.total, active: W.dash.clients.active, inactive: W.dash.clients.inactive },
    { total: 5, active: 1, inactive: 4 },
  );
  assert.deepEqual(W.dash.clients.byAccount, { ACTIVE: 1, HOLD: 3, DISCHARGED: 1 });
  assert.deepEqual(W.dash.clients.byStatus, { ACTIVE: 2, REFERRED: 1, DISCHARGED: 1, ON_HOLD: 1 });
  const all = await clientsService.listClients({ tenantId: W.T, limit: 100 });
  const active = await clientsService.listClients({ tenantId: W.T, limit: 100, accountStatus: 'ACTIVE' });
  const summary = await clientsService.summarizeClients({ tenantId: W.T });
  assert.equal(all.items.length, W.dash.clients.total, 'Clients page "All"');
  assert.equal(active.items.length, W.dash.clients.active, 'Clients page "Active"');
  assert.deepEqual(summary.account, W.dash.clients.byAccount, 'Clients page summary');
});

test('staff distribution: ACTIVE staff by RBAC role — inactive and unrelated roles excluded', { skip }, () => {
  assert.equal(W.dash.staff.bcba, 1);
  assert.equal(W.dash.staff.rbt, 2);
  assert.equal(W.dash.staff.activeStaff, 4);
});

test('clients requiring attention: the canonical completion rules only (intake + valid parent), worst first', { skip }, async () => {
  const byName = Object.fromEntries(W.dash.attention.items.map((i) => [i.clientName, i]));
  assert.equal(W.dash.attention.total, 3);
  assert.deepEqual(Object.keys(byName).sort(), ['Ada B', 'Cam N', 'Eve E']);
  assert.equal(W.dash.attention.items[0].clientName, 'Eve E', 'missing documents (critical) leads');
  assert.deepEqual(byName['Ada B'].missing.map((m) => m.label), ['Parent/guardian details incomplete']);
  assert.deepEqual(byName['Cam N'].missing.map((m) => m.label), ['Parent/guardian details missing', 'Intake is not yet complete.']);
  assert.deepEqual(byName['Eve E'].missing.map((m) => m.label), ['Intake is missing documents.']);
  assert.equal(byName['Cam N'].status, 'REFERRED');
  assert.ok(!byName['Raymond K'] && !byName['Dee D'] && !byName['Fay F'], 'complete, discharged and archived clients are not flagged');

  // The Client detail alerts agree on what is incomplete.
  for (const item of W.dash.attention.items) {
    const detail = await clientsService.getChildAlerts({ tenantId: W.T, clientId: item.clientId });
    const detailCodes = detail.alerts.map((a) => a.code).filter((c) => ['PARENT_DETAILS_REQUIRED', 'INTAKE_INCOMPLETE'].includes(c));
    assert.deepEqual(detailCodes.sort(), item.missing.map((m) => m.code).sort(), item.clientName);
  }
  const complete = await clientsService.getChildAlerts({ tenantId: W.T, clientId: W.A });
  assert.ok(!complete.alerts.some((a) => ['PARENT_DETAILS_REQUIRED', 'INTAKE_INCOMPLETE'].includes(a.code)));
});

test('authorizations expiring soon: the canonical expiry rule — not denied, not expired, not archived/deleted, not later', { skip }, () => {
  assert.equal(W.dash.expiringAuthorizations.total, 1);
  const [row] = W.dash.expiringAuthorizations.items;
  assert.deepEqual(
    { client: row.clientName, number: row.authorizationNumber, endDate: row.endDate, daysLeft: row.daysLeft, status: row.status, service: row.serviceType },
    { client: 'Raymond K', number: 'AUTH-SOON', endDate: '2026-09-20', daysLeft: 6, status: 'NOT_SENT', service: 'ABA' },
  );
  // Same verdict as the Client detail alerts engine at the same instant.
  const alerts = computeChildAlerts({ now: NOW(), intakeWorkflowStatus: 'COMPLETE', careTeam: [], serviceAuthorizations: [{ serviceType: 'ABA', status: 'NOT_SENT', endDate: '2026-09-20T00:00:00Z' }] });
  assert.ok(alerts.some((a) => a.code === 'ABA_EXPIRING' && /6 days/.test(a.message)));
});

test("today's sessions: org business date (not UTC), multi-date occurrences, manual session, persisted times", { skip }, () => {
  const rows = W.dash.today.items;
  const names = rows.map((r) => `${r.clientName}|${r.role}`);
  assert.deepEqual(names, ['Ada B|RBT', 'Raymond K|RBT', 'Raymond K|BCBA', 'Cam N|BCBA', 'Eve E|BCBA']);
  assert.equal(W.dash.today.total, 5);

  const range = rows[0];
  assert.deepEqual([range.timeKind, range.status, range.startAt, range.clinicianName], ['ALL_DAY', 'SCHEDULED', null, 'Omar Diaz']);

  const manual = rows[1];
  assert.deepEqual([manual.timeKind, manual.status, manual.source, manual.workedMinutes], ['ACTUAL', 'COMPLETED', 'MANUAL', 75]);
  assert.deepEqual([timeIn(manual.startAt), timeIn(manual.endAt)], ['8:00 AM', '9:15 AM']);

  const timed = rows[2];
  assert.deepEqual([timed.timeKind, timed.status, timed.clinicianName, timed.workedMinutes], ['ACTUAL', 'COMPLETED', 'test1 J', 90]);
  assert.deepEqual([timeIn(timed.startAt), timeIn(timed.endAt)], ['10:05 AM', '11:35 AM'], 'actual persisted times, not the schedule');

  const scheduled = rows[3];
  assert.deepEqual([scheduled.timeKind, timeIn(scheduled.startAt), timeIn(scheduled.endAt)], ['SCHEDULED', '3:00 PM', '4:00 PM']);

  // 10:30 PM NY is 09/15 in UTC — still today; 11:00 PM NY 09/13 is 09/14 in UTC — not today.
  assert.equal(rows[4].clientName, 'Eve E');
  assert.equal(timeIn(rows[4].startAt), '10:30 PM');
  assert.ok(!rows.some((r) => r.appointmentId === W.apptYesterdayLate || r.appointmentId === W.apptTomorrow));
  assert.ok(!rows.some((r) => r.clientName === 'Leak Client'));
});

test('BCBA Appointment Notes: current day only, BCBA-authored only, persisted first name, selected client only', { skip }, () => {
  const notes = W.dash.appointmentNotes;
  assert.equal(notes.total, 2);
  const byAppt = Object.fromEntries(notes.items.map((n) => [n.appointmentId, n]));
  assert.deepEqual(Object.keys(byAppt).sort(), [W.apptNoteClient, W.apptTimed].sort());
  assert.equal(byAppt[W.apptTimed].authorFirstName, 'test1', 'persisted first name (display casing is presentation)');
  assert.equal(byAppt[W.apptTimed].noteClientName, null, 'appointment client Raymond K is NEVER used as the note client');
  assert.equal(byAppt[W.apptNoteClient].noteClientName, 'Eve E');
  assert.equal(notes.items[0].appointmentId, W.apptNoteClient, 'newest first');
  assert.ok(!JSON.stringify(notes).includes('Worked on requesting'), 'no note content in the list');
});

test('notes section is omitted (null) for a caller without note read access', { skip }, async () => {
  const d = await W.service.companyDashboard({ tenantId: W.T, includeNotes: false });
  assert.equal(d.appointmentNotes, null);
});

test('latest sessions: exactly 4, newest first by actual start, normal + manual, worked minutes from time records', { skip }, () => {
  const rows = W.dash.latestSessions;
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.sessionId), [W.s1, W.manual.session.id, W.s12, W.s11]);
  assert.deepEqual(rows.map((r) => r.workedMinutes), [90, 75, 60, 55]);
  assert.deepEqual(rows.map((r) => r.role), ['BCBA', 'RBT', 'RBT', 'RBT']);
  assert.equal(rows[1].source, 'MANUAL');
  // Clock-in / clock-out come from the persisted SessionTimeRecord.
  assert.deepEqual([rows[0].clockIn, rows[0].clockOut].map((d) => new Date(d).toISOString()), [wall(2026, 9, 14, 10, 5).toISOString(), wall(2026, 9, 14, 11, 35).toISOString()]);
  assert.deepEqual([rows[1].clockIn, rows[1].clockOut].map((d) => new Date(d).toISOString()), [wall(2026, 9, 14, 8, 0).toISOString(), wall(2026, 9, 14, 9, 15).toISOString()]);
  assert.equal(rows[0].clientName, 'Raymond K');
  assert.ok(!rows.some((r) => r.sessionId === W.s10));
});

test('tenant isolation: another tenant sees only its own records', { skip }, async () => {
  const d = await W.service.companyDashboard({ tenantId: W.T2, includeNotes: true });
  assert.deepEqual([d.clients.total, d.clients.active, d.staff.bcba, d.staff.rbt], [1, 0, 1, 0]); // Leak Client has no parent → Hold
  assert.deepEqual(d.attention.items.map((i) => i.clientName), ['Leak Client']);
  assert.equal(d.expiringAuthorizations.total, 1);
  assert.deepEqual(d.today.items.map((r) => r.clientName), ['Leak Client']);
  assert.equal(d.latestSessions.length, 1);
  assert.equal(d.appointmentNotes.total, 0);
  const text = JSON.stringify(d);
  for (const name of ['Raymond', 'Ada', 'test1', 'AUTH-SOON']) assert.ok(!text.includes(name), name);
});

test('empty tenant: real zeros and empty lists, nothing fabricated', { skip }, async () => {
  const d = await W.service.companyDashboard({ tenantId: W.T3, includeNotes: true });
  assert.deepEqual(d.clients, { total: 0, active: 0, inactive: 0, byStatus: {}, byAccount: { ACTIVE: 0, HOLD: 0, DISCHARGED: 0 } });
  assert.deepEqual(d.staff, { bcba: 0, rbt: 0, activeStaff: 0, total: 0, active: 0, inactive: 0, byStatus: {} });
  assert.deepEqual(d.sessionsByRole, { period: { from: '2026-09-01', to: '2026-09-14' }, BCBA: { sessions: 0, completed: 0, workedMinutes: 0 }, RBT: { sessions: 0, completed: 0, workedMinutes: 0 } });
  assert.deepEqual(d.attention, { total: 0, items: [] });
  assert.deepEqual(d.expiringAuthorizations, { total: 0, items: [] });
  assert.deepEqual(d.today, { total: 0, byRole: { BCBA: 0, RBT: 0 }, items: [] });
  assert.deepEqual(d.appointmentNotes, { total: 0, items: [] });
  assert.deepEqual(d.latestSessions, []);
});

test('response exposes no sensitive fields: no guardian contact data, SSN envelope, memo or note body', { skip }, () => {
  const text = JSON.stringify(W.dash);
  for (const forbidden of ['5551234567', '@example.com', 'sensitive', 'memo', 'Plan with Eve', 'sealed', 'tenantId', 'userId']) {
    assert.ok(!text.includes(forbidden), forbidden);
  }
});

test('staff counts: total / active / inactive from StaffProfile status; clinicians by RBAC role stay separate', { skip }, () => {
  // test1 (bcba), Nia (rbt), Omar (rbt), Ops (org_admin) active; Priya (bcba) inactive.
  assert.deepEqual(
    { total: W.dash.staff.total, active: W.dash.staff.active, inactive: W.dash.staff.inactive, byStatus: W.dash.staff.byStatus },
    { total: 5, active: 4, inactive: 1, byStatus: { ACTIVE: 4, INACTIVE: 1 } },
  );
  assert.deepEqual([W.dash.staff.bcba, W.dash.staff.rbt, W.dash.staff.activeStaff], [1, 2, 4]);
});

test("today's sessions by role: counted on the server over every Today row, BCBA and RBT separate", { skip }, () => {
  assert.deepEqual(W.dash.today.byRole, { BCBA: 3, RBT: 2 });
  assert.equal(W.dash.today.byRole.BCBA + W.dash.today.byRole.RBT, W.dash.today.total);
});

test('BCBA / RBT sessions month-to-date: org business calendar, role from the session’s own appointment, minutes from time records', { skip }, async () => {
  const before = W.dash.sessionsByRole;
  assert.deepEqual(before.period, { from: '2026-09-01', to: '2026-09-14' });
  const recs = await withTenant(W.T, async () => await M.SessionTimeRecord.find({}).lean());
  const bySession = new Map(recs.map((r) => [r.sessionId, r.workedMinutes]));
  const sessions = await withTenant(W.T, async () => await M.Session.find({ deletedAt: null }).lean());
  const rbtSessions = sessions.filter((x) => x.staffProfileId === W.rbt);
  assert.deepEqual(before.BCBA, { sessions: 1, completed: 1, workedMinutes: 90 });
  assert.equal(before.RBT.sessions, 4); // s12, s11, s10 + the manual session
  assert.equal(before.RBT.workedMinutes, rbtSessions.reduce((a, x) => a + (bySession.get(x._id) ?? 0), 0));
  assert.equal(before.RBT.workedMinutes, 60 + 55 + 50 + 75);
  assert.equal(before.RBT.completed, rbtSessions.filter((x) => ['FROZEN', 'AMENDED'].includes(x.status)).length);

  // Boundaries: 09/01 00:30 New York counts; 08/31 23:30 New York (03:30 UTC 09/01) does not.
  await withTenant(W.T, async () => {
    const ap = await M.Appointment.create({ authorizationId: 'svc:none', units: 4, status: 'COMPLETED', clientId: W.A, bcbaId: W.bcba, staffProfileId: W.bcba, startAt: wall(2026, 8, 31, 23, 30), endAt: wall(2026, 9, 1, 1, 0), timeSet: true });
    await M.Session.create({ appointmentId: ap._id, clientId: W.A, staffProfileId: W.bcba, startedAt: wall(2026, 8, 31, 23, 30), endedAt: wall(2026, 8, 31, 23, 50), status: 'FROZEN', active: false });
    await M.Session.create({ appointmentId: ap._id, clientId: W.A, staffProfileId: W.bcba, startedAt: wall(2026, 9, 1, 0, 30), endedAt: wall(2026, 9, 1, 1, 0), status: 'IN_PROGRESS', active: false });
  });
  const after = (await W.service.companyDashboard({ tenantId: W.T, includeNotes: false })).sessionsByRole;
  assert.deepEqual(after.BCBA, { sessions: 2, completed: 1, workedMinutes: 90 }, 'no time record → no invented minutes');
  assert.deepEqual(after.RBT, before.RBT);
  // The other tenant's sessions never count here.
  const other = (await W.service.companyDashboard({ tenantId: W.T2, includeNotes: false })).sessionsByRole;
  assert.deepEqual(other.BCBA, { sessions: 1, completed: 0, workedMinutes: 0 });
  assert.deepEqual(other.RBT, { sessions: 0, completed: 0, workedMinutes: 0 });
});
