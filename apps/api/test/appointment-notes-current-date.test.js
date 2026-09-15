import test from 'node:test';
import assert from 'node:assert/strict';
import { AppointmentNotesService } from '../src/modules/scheduling/appointmentNotes.service.js';
import { saveAppointmentNoteSchema, appointmentNotesOverviewQuerySchema } from '../src/modules/scheduling/scheduling.schemas.js';
import { zonedWallTimeToUtc } from '../src/domain/businessDate.js';
import { makeNotesStore } from './helpers/appointmentNotesStore.js';

/**
 * ---------------------------------------------------------------------------
 * APPOINTMENT NOTES — CURRENT BUSINESS DATE ONLY, CLIENT NEVER INHERITED.
 *
 * The REAL AppointmentNotesService over a store with the repository's exact
 * semantics (test/helpers/appointmentNotesStore.js). The clock is controlled so
 * "today" moves 09/13 → 09/14 in the organization timezone; nothing hardcodes
 * the date inside the service.
 *
 * Final acceptance scenario: appointment Raymond K / BCBA Test1 J scheduled
 * 09/12/2026 → 09/30/2026; on 09/13 the BCBA saves a note with no client, later
 * selects Raymond K; on 09/14 neither the 09/13 note nor its client appears and
 * no note exists until one is explicitly created.
 * ---------------------------------------------------------------------------
 */

const TZ = 'America/New_York';
const TENANT = 'org1';
const OTHER_TENANT = 'org2';
const BCBA = 'bcba_test1';
const OTHER_BCBA = 'bcba_other';
const RBT = 'rbt_1';
const wall = (date, hh, mm = 0) => { const [y, m, d] = date.split('-').map(Number); return zonedWallTimeToUtc(y, m, d, hh, mm, 0, TZ); };

const APPOINTMENTS = {
  // Raymond K with BCBA Test1 J, 09/12 → 09/30 (date-only).
  appt_ray: { id: 'appt_ray', clientId: 'client_raymond', bcbaId: BCBA, rbtId: RBT, status: 'SCHEDULED', startAt: wall('2026-09-12', 0), endAt: wall('2026-10-01', 0), timeSet: false },
  // Another appointment for the same BCBA, different client.
  appt_bea: { id: 'appt_bea', clientId: 'client_bea', bcbaId: BCBA, rbtId: null, status: 'SCHEDULED', startAt: wall('2026-09-13', 0), endAt: wall('2026-09-14', 0), timeSet: false },
  // A future appointment (09/20 only).
  appt_future: { id: 'appt_future', clientId: 'client_raymond', bcbaId: BCBA, rbtId: null, status: 'SCHEDULED', startAt: wall('2026-09-20', 0), endAt: wall('2026-09-21', 0), timeSet: false },
  // Another BCBA's appointment.
  appt_other: { id: 'appt_other', clientId: 'client_cam', bcbaId: OTHER_BCBA, rbtId: null, status: 'SCHEDULED', startAt: wall('2026-09-13', 0), endAt: wall('2026-09-14', 0), timeSet: false },
};
const CLIENTS = {
  client_raymond: { id: 'client_raymond', firstName: 'Raymond', lastName: 'K' },
  client_bea: { id: 'client_bea', firstName: 'Bea', lastName: 'Stone' },
  client_cam: { id: 'client_cam', firstName: 'Cam', lastName: 'Ng' },
};
const STAFF = { [BCBA]: { firstName: 'Test1', lastName: 'J' }, [OTHER_BCBA]: { firstName: 'Priya', lastName: 'Shah' }, [RBT]: { firstName: 'Nia', lastName: 'Patel' } };
const ASSIGNMENTS = {
  client_raymond: [{ staffProfileId: BCBA, status: 'ACTIVE' }],
  client_bea: [{ staffProfileId: BCBA, status: 'ACTIVE' }],
  client_cam: [{ staffProfileId: OTHER_BCBA, status: 'ACTIVE' }, { staffProfileId: BCBA, status: 'ENDED' }],
};

function setup(startIso = wall('2026-09-13', 9).toISOString()) {
  let current = new Date(startIso).getTime();
  const clock = { now: () => new Date(current), set: (d) => { current = new Date(d).getTime(); } };
  const store = makeNotesStore(clock);
  const service = new AppointmentNotesService({
    clock,
    repository: { findAppointmentById: async (_t, id) => APPOINTMENTS[id] ?? null },
    notes: store,
    organizations: { getById: async () => ({ timezone: TZ }) },
    staff: { findById: async (_t, id) => STAFF[id] ?? null },
    clients: { findById: async (_t, id) => CLIENTS[id] ?? null },
    assignments: { listActiveForClient: async (_t, id) => ASSIGNMENTS[id] ?? [] },
    phi: { seal: (v) => `sealed(${v})`, open: (v) => (typeof v === 'string' && v.startsWith('sealed(') ? v.slice(7, -1) : v) },
  });
  return { service, store, clock };
}

const bcba = { tenantId: TENANT, actorRole: 'BCBA', actorStaffProfileId: BCBA, scope: 'TEAM' };
const otherBcba = { tenantId: TENANT, actorRole: 'BCBA', actorStaffProfileId: OTHER_BCBA, scope: 'TEAM' };
const admin = { tenantId: TENANT, actorRole: 'BCBA', actorStaffProfileId: null, scope: 'ORGANIZATION' };
const rbt = { tenantId: TENANT, actorRole: 'RBT', actorStaffProfileId: RBT, scope: 'OWN' };
const save = (svc, ctx, appointmentId, extra) => svc.saveNote({ ...ctx, actorUserId: 'u1', appointmentId, ...extra });
const get = (svc, ctx, appointmentId, extra = {}) => svc.getNote({ ...ctx, appointmentId, ...extra });

// ============================ FINAL ACCEPTANCE ==============================

test('ACCEPTANCE: 09/12 → 09/30 appointment; 09/13 note without client, then Raymond K; 09/14 starts clean', async () => {
  const { service, store, clock } = setup(wall('2026-09-13', 9).toISOString());

  // BCBA opens the note on 09/13: nothing exists, and NO client is pre-filled.
  const opened = await get(service, bcba, 'appt_ray');
  assert.equal(opened.exists, false);
  assert.equal(opened.businessDate, '2026-09-13');
  assert.equal(opened.clientId, null);
  assert.equal(opened.clientName, null);
  assert.equal('context' in opened, false, 'no appointment data mixed into the note response');

  // Saves WITHOUT selecting a client → persisted with NO client.
  const saved = await save(service, bcba, 'appt_ray', { note: 'Session plan for today.' });
  assert.equal(saved.exists, true);
  assert.equal(saved.clientId, null);
  assert.equal(store.raw(TENANT, 'appt_ray', '2026-09-13').clientId, null);
  assert.equal(store.raw(TENANT, 'appt_ray', '2026-09-13').serviceDate, '2026-09-13');

  // Later edits and explicitly selects Raymond K → the current-day note now has him.
  clock.set(wall('2026-09-13', 15));
  const edited = await save(service, bcba, 'appt_ray', { note: 'Session plan for today (updated).', clientId: 'client_raymond' });
  assert.equal(edited.clientId, 'client_raymond');
  assert.equal(edited.clientName, 'Raymond K');
  assert.equal(store.rows.size, 1);

  // Next business day, 09/14: the 09/13 note and its client do not appear, and
  // no note was created for 09/14 (or any later date) automatically.
  clock.set(wall('2026-09-14', 8));
  const nextDay = await get(service, bcba, 'appt_ray');
  assert.equal(nextDay.businessDate, '2026-09-14');
  assert.equal(nextDay.exists, false);
  assert.equal(nextDay.note, null);
  assert.equal(nextDay.clientId, null);
  assert.equal(nextDay.clientName, null);
  assert.equal(store.rows.size, 1, 'only the explicitly created 09/13 row exists');
  assert.equal(store.raw(TENANT, 'appt_ray', '2026-09-14'), undefined);
  // 09/13 history is intact, not deleted or moved.
  assert.equal(store.raw(TENANT, 'appt_ray', '2026-09-13').body, 'sealed(Session plan for today (updated).)');
});

// ============================ CLIENT: NEVER INHERITED =======================

test('the appointment client is never auto-inherited: create without client → clientId null in storage and response', async () => {
  const { service, store } = setup();
  const r = await save(service, bcba, 'appt_ray', { note: 'No client selected.' });
  assert.equal(r.clientId, null);
  assert.equal(r.clientName, null);
  assert.equal(store.raw(TENANT, 'appt_ray', '2026-09-13').clientId, null);
  const reread = await get(service, admin, 'appt_ray');
  assert.equal(reread.clientId, null);
  assert.equal(reread.clientName, null);
  const list = await service.listForAppointment({ ...admin, appointmentId: 'appt_ray' });
  assert.equal(list.notes[0].clientName, null);
});

test('explicitly selected client persists; an edit that omits it keeps it; null clears it', async () => {
  const { service, store } = setup();
  await save(service, bcba, 'appt_ray', { note: 'v1', clientId: 'client_bea' });
  assert.equal(store.raw(TENANT, 'appt_ray', '2026-09-13').clientId, 'client_bea');
  await save(service, bcba, 'appt_ray', { note: 'v2' });
  assert.equal(store.raw(TENANT, 'appt_ray', '2026-09-13').clientId, 'client_bea');
  const cleared = await save(service, bcba, 'appt_ray', { note: 'v3', clientId: null });
  assert.equal(cleared.clientId, null);
  assert.equal(store.raw(TENANT, 'appt_ray', '2026-09-13').clientId, null);
  assert.equal(store.rows.size, 1);
  assert.equal(saveAppointmentNoteSchema.safeParse({ note: 'x', clientId: null }).success, true);
});

test('a client the BCBA is not actively assigned to (or an unknown client) is refused and nothing is written', async () => {
  const { service, store } = setup();
  await assert.rejects(() => save(service, bcba, 'appt_ray', { note: 'x', clientId: 'client_cam' }), (e) => e.code === 'NOTE_CLIENT_NOT_ALLOWED');
  await assert.rejects(() => save(service, bcba, 'appt_ray', { note: 'x', clientId: 'nope' }), (e) => e.code === 'NOTE_CLIENT_NOT_ALLOWED');
  assert.equal(store.rows.size, 0);
});

// ============================ CURRENT-DATE ONLY =============================

test('the note date is the CURRENT business date — never the appointment start or range', async () => {
  const { service, store } = setup(wall('2026-09-13', 9).toISOString());
  const r = await save(service, bcba, 'appt_ray', { note: 'Today.' });
  assert.equal(r.businessDate, '2026-09-13');
  assert.equal(store.raw(TENANT, 'appt_ray', '2026-09-12'), undefined, 'not the appointment start date');
  assert.deepEqual([...store.rows.values()].map((x) => x.serviceDate), ['2026-09-13']);
  const list = await service.listForAppointment({ ...bcba, appointmentId: 'appt_ray' });
  assert.equal('serviceDates' in list, false, 'no schedule range offered as note dates');
  assert.equal(list.businessDate, '2026-09-13');
});

test('writing/reading/deleting another date is refused — including dates inside the appointment range', async () => {
  const { service, store } = setup();
  for (const serviceDate of ['2026-09-12', '2026-09-14', '2026-09-30']) {
    await assert.rejects(() => save(service, bcba, 'appt_ray', { note: 'x', serviceDate }), (e) => e.code === 'NOTE_DATE_NOT_CURRENT');
    await assert.rejects(() => get(service, bcba, 'appt_ray', { serviceDate }), (e) => e.code === 'NOTE_DATE_NOT_CURRENT');
    await assert.rejects(() => service.deleteNote({ ...bcba, actorUserId: 'u1', appointmentId: 'appt_ray', serviceDate }), (e) => e.code === 'NOTE_DATE_NOT_CURRENT');
  }
  // Echoing today's date is fine.
  const ok = await save(service, bcba, 'appt_ray', { note: 'Today.', serviceDate: '2026-09-13' });
  assert.equal(ok.exists, true);
  assert.equal(store.rows.size, 1);
});

test('09/12 note does not appear on 09/13; 09/13 note does not appear on 09/14', async () => {
  const { service, clock } = setup(wall('2026-09-12', 12).toISOString());
  await save(service, bcba, 'appt_ray', { note: 'Note from 09/12', clientId: 'client_raymond' });
  clock.set(wall('2026-09-13', 0, 1));
  const on13 = await get(service, bcba, 'appt_ray');
  assert.deepEqual([on13.exists, on13.note, on13.clientName], [false, null, null]);
  await save(service, bcba, 'appt_ray', { note: 'Note from 09/13' });
  clock.set(wall('2026-09-14', 0, 1));
  const on14 = await get(service, bcba, 'appt_ray');
  assert.deepEqual([on14.exists, on14.note], [false, null]);
});

test('a note written just before midnight stays on its date; a stale 09/13 screen cannot write after midnight', async () => {
  const { service, store, clock } = setup(wall('2026-09-13', 23, 59).toISOString());
  await save(service, bcba, 'appt_ray', { note: 'Late note', serviceDate: '2026-09-13' });
  clock.set(wall('2026-09-14', 0, 0));
  await assert.rejects(() => save(service, bcba, 'appt_ray', { note: 'edit from stale screen', serviceDate: '2026-09-13' }), (e) => e.code === 'NOTE_DATE_NOT_CURRENT');
  assert.equal(store.raw(TENANT, 'appt_ray', '2026-09-13').body, 'sealed(Late note)');
});

test('future appointment: nothing is created automatically; reads never create rows', async () => {
  const { service, store } = setup(wall('2026-09-13', 9).toISOString());
  for (const id of ['appt_future', 'appt_ray']) {
    const r = await get(service, bcba, id);
    assert.equal(r.exists, false);
  }
  await service.listForAppointment({ ...bcba, appointmentId: 'appt_future' });
  await service.listNotesOverview(admin);
  assert.equal(store.rows.size, 0, 'no note rows from reads');
  // An explicit note on the future appointment is TODAY's note, not a 09/20 note.
  const explicit = await save(service, bcba, 'appt_future', { note: 'Prep' });
  assert.equal(explicit.businessDate, '2026-09-13');
  assert.equal(store.raw(TENANT, 'appt_future', '2026-09-20'), undefined);
});

test('a legacy row filed for today on an EARLIER day is not today\'s note; creating today\'s note preserves it', async () => {
  const { service, store } = setup(wall('2026-09-14', 9).toISOString());
  // What the retired per-date picker could write: on 09/12, a note "for 09/14".
  store.plant({
    id: 'legacy1', tenantId: TENANT, appointmentId: 'appt_ray', serviceDate: '2026-09-14',
    authorStaffProfileId: BCBA, clientId: 'client_raymond', body: 'sealed(written in advance)',
    createdAt: wall('2026-09-12', 10), updatedAt: wall('2026-09-12', 10),
  });
  const read = await get(service, bcba, 'appt_ray');
  assert.equal(read.exists, false, 'a pre-written future note is not presented as today\'s');
  assert.equal(read.clientName, null);
  const overview = await service.listNotesOverview(admin);
  assert.equal(overview.items.length, 0);

  const created = await save(service, bcba, 'appt_ray', { note: 'Actual 09/14 note' });
  assert.equal(created.note, 'Actual 09/14 note');
  assert.equal(created.clientId, null, 'legacy client not carried over');
  const raw = store.raw(TENANT, 'appt_ray', '2026-09-14');
  assert.equal(raw.supersededVersions.length, 1);
  assert.equal(raw.supersededVersions[0].body, 'sealed(written in advance)');
  assert.equal(raw.supersededVersions[0].clientId, 'client_raymond');
});

// ============================ BCBA CRUD =====================================

test('BCBA CRUD on the current-day note: create, read, update, delete (then re-create the same day)', async () => {
  const { service, store } = setup();
  const created = await save(service, bcba, 'appt_ray', { note: 'Create' });
  assert.equal(created.canEdit, true);
  assert.equal((await get(service, bcba, 'appt_ray')).note, 'Create');
  await save(service, bcba, 'appt_ray', { note: 'Update' });
  assert.equal((await get(service, bcba, 'appt_ray')).note, 'Update');
  assert.equal(store.raw(TENANT, 'appt_ray', '2026-09-13').authorStaffProfileId, BCBA);

  const del = await service.deleteNote({ ...bcba, actorUserId: 'u1', appointmentId: 'appt_ray' });
  assert.deepEqual(del, { appointmentId: 'appt_ray', businessDate: '2026-09-13', deleted: true });
  assert.equal((await get(service, bcba, 'appt_ray')).exists, false);
  await assert.rejects(() => service.deleteNote({ ...bcba, actorUserId: 'u1', appointmentId: 'appt_ray' }), (e) => e.code === 'APPOINTMENT_NOTE_NOT_FOUND');

  // Re-create the same day: takes over the deleted row (unique key), fresh client.
  const again = await save(service, bcba, 'appt_ray', { note: 'Re-created' });
  assert.deepEqual([again.exists, again.note, again.clientId], [true, 'Re-created', null]);
  assert.equal(store.rows.size, 1);
});

test('deleting a note affects nothing else: other appointment, other date, appointment client', async () => {
  const { service, store, clock } = setup(wall('2026-09-12', 12).toISOString());
  await save(service, bcba, 'appt_ray', { note: '09/12 history' });
  clock.set(wall('2026-09-13', 9));
  await save(service, bcba, 'appt_ray', { note: 'today ray' });
  await save(service, bcba, 'appt_bea', { note: 'today bea', clientId: 'client_bea' });
  await service.deleteNote({ ...bcba, actorUserId: 'u1', appointmentId: 'appt_ray' });
  assert.equal(store.raw(TENANT, 'appt_ray', '2026-09-12').deletedAt, null, 'previous date untouched');
  assert.equal((await get(service, bcba, 'appt_bea')).note, 'today bea');
  assert.equal(APPOINTMENTS.appt_ray.clientId, 'client_raymond', 'appointment untouched');
});

test('an empty note is refused (use Delete to remove a note)', async () => {
  const { service, store } = setup();
  await assert.rejects(() => save(service, bcba, 'appt_ray', { note: '   ' }), (e) => e.code === 'NOTE_REQUIRED');
  assert.equal(store.rows.size, 0);
});

test('the note body is sealed at rest', async () => {
  const { service, store } = setup();
  await save(service, bcba, 'appt_ray', { note: 'Private content' });
  assert.equal(store.raw(TENANT, 'appt_ray', '2026-09-13').body, 'sealed(Private content)');
});

// ============================ ADMIN / BCBA SCOPE / RBT ======================

test('Company Admin reads the current-day note (selected client only, never invented) and cannot write or delete', async () => {
  const { service } = setup();
  await save(service, bcba, 'appt_ray', { note: 'No client' });
  await save(service, bcba, 'appt_bea', { note: 'With client', clientId: 'client_bea' });
  const ray = await get(service, admin, 'appt_ray');
  assert.deepEqual([ray.note, ray.clientName, ray.canEdit], ['No client', null, false]);
  const bea = await get(service, admin, 'appt_bea');
  assert.deepEqual([bea.note, bea.clientName], ['With client', 'Bea Stone']);
  await assert.rejects(() => save(service, admin, 'appt_ray', { note: 'x' }), (e) => e.code === 'APPOINTMENT_NOTE_FORBIDDEN');
  await assert.rejects(() => service.deleteNote({ ...admin, actorUserId: 'a', appointmentId: 'appt_ray' }), (e) => e.code === 'APPOINTMENT_NOTE_FORBIDDEN');
});

test('admin overview: current business date only; appointment info separate from the note\'s own client', async () => {
  const { service, clock } = setup(wall('2026-09-12', 12).toISOString());
  await save(service, bcba, 'appt_ray', { note: 'yesterday' });
  clock.set(wall('2026-09-13', 9));
  await save(service, bcba, 'appt_ray', { note: 'today, no client' });
  await save(service, bcba, 'appt_bea', { note: 'today, client', clientId: 'client_bea' });
  await save(service, otherBcba, 'appt_other', { note: 'other bcba' });

  const { businessDate, items } = await service.listNotesOverview(admin);
  assert.equal(businessDate, '2026-09-13');
  const view = items.map((r) => [r.appointmentId, r.bcbaName, r.appointmentClientName, r.noteClientName]).sort();
  assert.deepEqual(view, [
    ['appt_bea', 'Test1 J', 'Bea Stone', 'Bea Stone'],
    ['appt_other', 'Priya Shah', 'Cam Ng', null],
    ['appt_ray', 'Test1 J', 'Raymond K', null], // appointment client shown as appointment info; no note client invented
  ]);
  assert.equal(items.find((r) => r.appointmentId === 'appt_ray').rbtName, 'Nia Patel');
  for (const r of items) assert.equal('note' in r || 'body' in r, false, 'rows carry no note text');
  assert.equal(appointmentNotesOverviewQuerySchema.safeParse({ from: '2026-09-01', to: '2026-09-30' }).success, false);

  // BCBA overview is scoped to their own appointments.
  const mine = await service.listNotesOverview(bcba);
  assert.deepEqual(mine.items.map((r) => r.appointmentId).sort(), ['appt_bea', 'appt_ray']);
});

test('appointment isolation: an unassigned BCBA cannot read, write or delete another appointment\'s note', async () => {
  const { service } = setup();
  await save(service, bcba, 'appt_ray', { note: 'Mine' });
  await assert.rejects(() => get(service, otherBcba, 'appt_ray'), (e) => e.code === 'APPOINTMENT_NOTE_FORBIDDEN');
  await assert.rejects(() => save(service, otherBcba, 'appt_ray', { note: 'x' }), (e) => e.code === 'APPOINTMENT_NOTE_FORBIDDEN');
  await assert.rejects(() => service.deleteNote({ ...otherBcba, actorUserId: 'u', appointmentId: 'appt_ray' }), (e) => e.code === 'APPOINTMENT_NOTE_FORBIDDEN');
  await assert.rejects(() => get(service, bcba, 'nope'), (e) => e.code === 'APPOINTMENT_NOT_FOUND');
});

test('tenant isolation: another tenant sees no note for the same appointment id', async () => {
  const { service } = setup();
  await save(service, bcba, 'appt_ray', { note: 'Tenant one' });
  const other = await get(service, { ...admin, tenantId: OTHER_TENANT }, 'appt_ray');
  assert.equal(other.exists, false);
  assert.equal((await service.listNotesOverview({ ...admin, tenantId: OTHER_TENANT })).items.length, 0);
});

test('RBT denied everywhere — read, list, overview, write, delete — even on their own appointment, without leaking existence', async () => {
  const { service, store } = setup();
  await save(service, bcba, 'appt_ray', { note: 'Exists' });
  const refusals = [
    () => get(service, rbt, 'appt_ray'),
    () => get(service, rbt, 'appt_bea'), // no note there — same refusal
    () => service.listForAppointment({ ...rbt, appointmentId: 'appt_ray' }),
    () => service.listNotesOverview(rbt),
    () => save(service, rbt, 'appt_ray', { note: 'x', clientId: 'client_raymond' }),
    () => service.deleteNote({ ...rbt, actorUserId: 'r', appointmentId: 'appt_ray' }),
  ];
  for (const call of refusals) await assert.rejects(call, (e) => e.code === 'APPOINTMENT_NOTE_FORBIDDEN');
  assert.equal(store.raw(TENANT, 'appt_ray', '2026-09-13').body, 'sealed(Exists)');
});

test('routes: DELETE reuses the note permission grade; overview takes no date range; controller forwards clientId', async () => {
  const { readFile } = await import('node:fs/promises');
  const routes = await readFile(new URL('../src/modules/scheduling/scheduling.routes.js', import.meta.url), 'utf8');
  assert.match(routes, /router\.delete\('\/appointments\/:appointmentId\/note', requireAnyPermission\('documents\.write', 'scheduling\.write'\)/);
  assert.match(routes, /router\.get\('\/appointment-notes', requireAnyPermission\('documents\.read', 'scheduling\.read'\)/);
  const controller = await readFile(new URL('../src/modules/scheduling/scheduling.controller.js', import.meta.url), 'utf8');
  assert.match(controller, /req\.body\.clientId !== undefined \? \{ clientId: req\.body\.clientId \}/);
  assert.doesNotMatch(controller, /req\.query\.from|req\.query\.to/);
});

test('ACCEPTANCE (Part 2): note saved without a client, then ANOTHER client explicitly selected → that client persists; Raymond K never attached', async () => {
  const { service, store, clock } = setup(wall('2026-09-13', 9).toISOString());
  const opened = await get(service, bcba, 'appt_ray');
  assert.deepEqual([opened.exists, opened.clientId, opened.clientName], [false, null, null]);
  const saved = await save(service, bcba, 'appt_ray', { note: 'Session-related appointment note' });
  assert.equal(saved.clientId, null);
  assert.notEqual(store.raw(TENANT, 'appt_ray', '2026-09-13').clientId, 'client_raymond');
  const edited = await save(service, bcba, 'appt_ray', { note: 'Session-related appointment note', clientId: 'client_bea' });
  assert.deepEqual([edited.clientId, edited.clientName], ['client_bea', 'Bea Stone']);
  assert.equal(store.raw(TENANT, 'appt_ray', '2026-09-13').clientId, 'client_bea');
  clock.set(wall('2026-09-14', 9));
  const next = await get(service, bcba, 'appt_ray');
  assert.deepEqual([next.exists, next.note, next.clientId, next.clientName], [false, null, null, null]);
});

// ==================== ADMIN NOTIFICATION: REAL AUTHOR DATA ===================

test('admin notification data comes from the persisted note: author first name (as stored), selected client, no rows when no note', async () => {
  const lowerStaff = { ...STAFF, [BCBA]: { firstName: 'test1 john', lastName: 'j' } };
  const { service, clock } = setup(wall('2026-09-13', 9).toISOString());
  service.deps.staff = { findById: async (_t, id) => lowerStaff[id] ?? null };

  // No current-day note anywhere → no rows → nothing to announce.
  assert.deepEqual((await service.listNotesOverview(admin)).items, []);

  await save(service, bcba, 'appt_ray', { note: 'Plan for today.', clientId: 'client_bea' });
  const { items } = await service.listNotesOverview(admin);
  assert.equal(items.length, 1);
  const [row] = items;
  assert.equal(row.authorStaffProfileId, BCBA);
  assert.equal(row.authorFirstName, 'test1 john', 'the persisted value — display casing is the UI formatter\'s job');
  assert.equal(row.noteClientName, 'Bea Stone', 'the client the BCBA selected, not the appointment client (Raymond K)');
  assert.ok(row.updatedAt);

  // Opening it returns the actual note, author and selected client.
  const opened = await get(service, admin, 'appt_ray');
  assert.equal(opened.note, 'Plan for today.');
  assert.equal(opened.authorFirstName, 'test1 john');
  assert.equal(opened.clientName, 'Bea Stone');
  assert.equal(opened.canEdit, false, 'admin view is read-only');

  // The author is the note's persisted author even if the appointment's BCBA later changes.
  const reassigned = { ...APPOINTMENTS.appt_ray, bcbaId: OTHER_BCBA };
  service.deps.repository = { findAppointmentById: async (_t, id) => (id === 'appt_ray' ? reassigned : APPOINTMENTS[id] ?? null) };
  const after = await service.listNotesOverview(admin);
  assert.equal(after.items[0].authorFirstName, 'test1 john');

  // Next business day: yesterday's note does not announce itself as today's.
  clock.set(wall('2026-09-14', 9));
  assert.deepEqual((await service.listNotesOverview(admin)).items, []);
});
