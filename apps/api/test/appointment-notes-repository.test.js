import test from 'node:test';
import assert from 'node:assert/strict';
import { AppointmentNote } from '../src/models/index.js';
import { appointmentNotesRepository as repo } from '../src/modules/scheduling/appointmentNotes.repository.js';

/**
 * The REAL appointment-note repository with the Mongoose model's query methods
 * stubbed, so the exact filters/updates it sends to MongoDB are asserted
 * (no live MongoDB in this environment). Also pins the schema: the unique key
 * is still (tenantId, appointmentId, serviceDate) and clientId defaults to null.
 */

const T1 = '11111111-1111-4111-8111-111111111111';
const calls = [];
const stub = (name, result = {}) => {
  AppointmentNote[name] = (filter, update, options) => {
    calls.push({ name, filter, update, options });
    const chain = { sort: () => chain, limit: () => chain, lean: async () => (Array.isArray(result) ? result : { _id: 'n1', ...result }) };
    return chain;
  };
};
const last = () => calls.at(-1);

test('schema: unique key unchanged, clientId optional (null), supersededVersions preserved', () => {
  const indexes = AppointmentNote.schema.indexes();
  assert.ok(indexes.some(([keys, opts]) => opts?.unique && keys.tenantId === 1 && keys.appointmentId === 1 && keys.serviceDate === 1));
  assert.equal(AppointmentNote.schema.path('clientId').defaultValue, null);
  assert.notEqual(AppointmentNote.schema.path('clientId').isRequired, true);
  assert.ok(AppointmentNote.schema.path('supersededVersions'));
});

test('create: keyed on (appointmentId, serviceDate) WITHOUT a deletedAt filter; client written explicitly (null when none)', async () => {
  stub('findOneAndUpdate');
  await repo.create(T1, { appointmentId: 'a1', serviceDate: '2026-09-13', authorStaffProfileId: 's1', body: 'sealed', updatedBy: 'u1' });
  const c = last();
  assert.deepEqual(c.filter, { appointmentId: 'a1', serviceDate: '2026-09-13' });
  assert.equal(c.update.$set.clientId, null);
  assert.equal(c.update.$set.deletedAt, null);
  assert.equal(c.update.$set.authorStaffProfileId, 's1');
  assert.equal(c.update.$push, undefined);
  assert.equal(c.options.upsert, true);
});

test('create with supersede pushes the previous content instead of discarding it', async () => {
  stub('findOneAndUpdate');
  await repo.create(T1, { appointmentId: 'a1', serviceDate: '2026-09-14', authorStaffProfileId: 's1', body: 'new', updatedBy: 'u1', clientId: 'c1', supersede: { body: 'old', clientId: 'cOld', authorStaffProfileId: 's0', updatedAt: null } });
  const c = last();
  assert.equal(c.update.$set.clientId, 'c1');
  assert.equal(c.update.$push.supersededVersions.body, 'old');
  assert.ok(c.update.$push.supersededVersions.supersededAt instanceof Date);
});

test('update: live row only; clientId only when provided; author never rewritten', async () => {
  stub('findOneAndUpdate');
  await repo.update(T1, { appointmentId: 'a1', serviceDate: '2026-09-13', body: 'b', updatedBy: 'u1' });
  assert.deepEqual(last().filter, { appointmentId: 'a1', serviceDate: '2026-09-13', deletedAt: null });
  assert.equal('clientId' in last().update.$set, false);
  assert.equal('authorStaffProfileId' in last().update.$set, false);
  await repo.update(T1, { appointmentId: 'a1', serviceDate: '2026-09-13', body: 'b', updatedBy: 'u1', clientId: null });
  assert.equal(last().update.$set.clientId, null);
});

test('softDelete: stamps deletedAt on the live row for that date only', async () => {
  stub('findOneAndUpdate');
  await repo.softDelete(T1, { appointmentId: 'a1', serviceDate: '2026-09-13', deletedBy: 'u1' });
  assert.deepEqual(last().filter, { appointmentId: 'a1', serviceDate: '2026-09-13', deletedAt: null });
  assert.ok(last().update.$set.deletedAt instanceof Date);
});

test('reads: live rows only; overview is a single business date', async () => {
  stub('findOne');
  await repo.findByAppointmentAndDate(T1, 'a1', '2026-09-13');
  assert.deepEqual(last().filter, { appointmentId: 'a1', serviceDate: '2026-09-13', deletedAt: null });
  stub('find', []);
  await repo.listForBusinessDate(T1, '2026-09-13');
  assert.deepEqual(last().filter, { serviceDate: '2026-09-13', body: { $ne: null }, deletedAt: null });
  assert.equal(typeof repo.listInDateRange, 'undefined', 'no date-range note query remains');
  assert.equal(typeof repo.upsert, 'undefined', 'no generic per-date upsert remains');
});
