/**
 * Real-MongoDB smoke test for the REBUILT Book Appointment pipeline.
 *
 * This is the one check that cannot run in an offline/sandboxed CI: it proves
 * that createAppointmentSimple actually writes to MongoDB, the write RETURNS
 * (no unbounded transaction commit → no infinite spinner), and the record reads
 * back with every required field intact.
 *
 * WHAT IT DOES
 *   1. Connects to the MONGODB_URI in your environment (fails fast, with a clear
 *      message, if the DB is unreachable — it never pretends success).
 *   2. Writes an appointment through the REAL SchedulingRepository.createAppointmentSimple
 *      (the exact call the service makes), timing the write so a hang is caught.
 *   3. Reads it back through the REAL findAppointmentById and asserts:
 *      tenantId, clientId, bcbaId, rbtId, authorizationIds, authorizationId,
 *      staffProfileId, startAt, endAt, units, status, createdBy, timestamps.
 *   4. Deletes the test document so nothing is left behind.
 *
 * It uses a synthetic tenant/client/authorization id, so it does NOT depend on
 * seed data and does NOT touch any real client's records. The service-level
 * orchestration (BCBA/RBT care-team gate, tenant/child authorization guard,
 * validation, error paths) is already covered by the automated suites; this
 * script isolates the live-DB round-trip that those suites can't reach.
 *
 * RUN:
 *   cd apps/api
 *   MONGODB_URI="<your uri>" node scripts/smoke-book-appointment.mjs
 * (or rely on apps/api/.env if MONGODB_URI is already set there)
 */
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { schedulingRepository } from '../src/modules/scheduling/scheduling.repository.js';
import { withTenant } from '../src/tenancy/tenantContext.js';

// MONGODB_URI from the environment, or a minimal fallback read of apps/api/.env
// (no dotenv dependency — this script must run with only what the app already has).
function readEnvUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(resolve(here, '../.env'), 'utf8');
    const line = raw.split('\n').find((l) => l.trim().startsWith('MONGODB_URI='));
    if (line) return line.slice(line.indexOf('=') + 1).trim();
  } catch { /* no .env — fall through */ }
  return undefined;
}
const uri = readEnvUri();
if (!uri) {
  console.error('FAIL: MONGODB_URI is not set. Real MongoDB smoke test could not be executed because no connection string was provided.');
  process.exit(1);
}

const TENANT = randomUUID();
const CLIENT = randomUUID();
const BCBA = randomUUID();
const RBT = randomUUID();
const AUTH_1 = randomUUID();
const AUTH_2 = randomUUID();

const REQUIRED = [
  'tenantId', 'clientId', 'bcbaId', 'rbtId', 'authorizationIds', 'authorizationId',
  'staffProfileId', 'startAt', 'endAt', 'units', 'status', 'createdBy',
];

function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function main() {
  // 1. Connect (bounded — a stalled connect must not hang this script).
  const connectTimeout = setTimeout(() => {
    console.error('FAIL: Real MongoDB smoke test could not be executed because the connection did not establish within 15s (network/whitelist/URI).');
    process.exit(2);
  }, 15000);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 12000 });
  clearTimeout(connectTimeout);
  console.log('connected to MongoDB');

  let createdId;
  try {
    // 2. Write through the REAL repository, timing it — a hang is the original bug.
    const startAt = new Date('2026-09-09T15:00:00.000Z');
    const endAt = new Date('2026-09-09T16:00:00.000Z');
    const t0 = Date.now();
    const created = await withTenant(TENANT, () => schedulingRepository.createAppointmentSimple(TENANT, {
      clientId: CLIENT,
      bcbaId: BCBA,
      rbtId: RBT,
      staffProfileId: RBT,
      authorizationId: AUTH_1,
      authorizationIds: [AUTH_1, AUTH_2],
      serviceCode: 'ABA',
      startAt,
      endAt,
      units: 4,
      status: 'SCHEDULED',
      createdBy: 'smoke-test',
      updatedBy: 'smoke-test',
    }));
    const writeMs = Date.now() - t0;
    createdId = created.id;
    console.log(`createAppointmentSimple returned in ${writeMs}ms (id=${createdId})`);
    assert(writeMs < 10000, `write took ${writeMs}ms — investigate, the create path must return promptly`);
    assert(createdId, 'no id returned from create');

    // 3. Read back through the REAL repository and verify every field.
    const back = await withTenant(TENANT, () => schedulingRepository.findAppointmentById(TENANT, createdId));
    assert(back, 'appointment did not read back from MongoDB (not persisted)');
    for (const f of REQUIRED) assert(back[f] !== undefined && back[f] !== null, `missing field on persisted appointment: ${f}`);
    assert(back.clientId === CLIENT, 'clientId mismatch');
    assert(back.bcbaId === BCBA, 'bcbaId mismatch');
    assert(back.rbtId === RBT, 'rbtId mismatch');
    assert(back.staffProfileId === RBT, 'staffProfileId must equal the RBT');
    assert(back.authorizationId === AUTH_1, 'primary authorizationId mismatch');
    assert(Array.isArray(back.authorizationIds) && back.authorizationIds.length === 2
      && back.authorizationIds.includes(AUTH_1) && back.authorizationIds.includes(AUTH_2),
      'authorizationIds did not persist all selected authorizations');
    assert(new Date(back.startAt).toISOString() === startAt.toISOString(), 'startAt mismatch');
    assert(new Date(back.endAt).toISOString() === endAt.toISOString(), 'endAt mismatch');
    assert(back.units === 4, 'units mismatch');
    assert(back.status === 'SCHEDULED', 'status mismatch');
    assert(back.createdAt && back.updatedAt, 'timestamps missing');

    console.log('read-back verified:', JSON.stringify({
      tenantId: TENANT, clientId: back.clientId, bcbaId: back.bcbaId, rbtId: back.rbtId,
      staffProfileId: back.staffProfileId, authorizationId: back.authorizationId,
      authorizationIds: back.authorizationIds, units: back.units, status: back.status,
      startAt: back.startAt, endAt: back.endAt, createdBy: back.createdBy,
      createdAt: back.createdAt, updatedAt: back.updatedAt,
    }, null, 2));

    console.log('\nPASS: real MongoDB create → persist → read-back succeeded, and the write returned promptly (no hang).');
  } finally {
    // 4. Clean up the synthetic document.
    if (createdId) {
      try {
        await mongoose.connection.collection('appointments').deleteOne({ _id: mongoose.Types.ObjectId.createFromHexString(String(createdId)) });
      } catch {
        try { await mongoose.connection.collection('appointments').deleteOne({ _id: createdId }); } catch { /* leave for manual cleanup */ }
      }
    }
    await mongoose.disconnect();
  }
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
