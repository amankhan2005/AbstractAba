import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * ORGANIZATION TIMEZONE — the single business timezone, end to end against a
 * throwaway MongoDB and the real HTTP app (sign-in, PATCH /v1/organization,
 * GET /v1/auth/me), plus the real services that derive business dates.
 *
 *   Org A "Harbor ABA"  America/New_York   Company Admin, BCBA, RBT
 *   Org B "Prairie ABA" America/Chicago    Company Admin
 */
process.env.BCRYPT_ROUNDS = process.env.BCRYPT_ROUNDS ?? '4';
const CANDIDATES = [process.env.MONGOMS_SYSTEM_BINARY, '/opt/homebrew/bin/mongod', '/usr/local/bin/mongod', '/usr/bin/mongod'].filter(Boolean);
const MONGOD = CANDIDATES.find((p) => existsSync(p)) ?? null;
const skip = MONGOD ? false : 'no local mongod binary (set MONGOMS_SYSTEM_BINARY)';

let server; let mongoose; let app; let M; let httpServer; let base;
const W = {};

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
}
const signIn = async (email) => {
  const r = await call('POST', '/api/v1/auth/sign-in', { body: { email, password: 'Str0ng-Passw0rd!' } });
  assert.equal(r.status, 200, `sign-in ${email}: ${JSON.stringify(r.json)}`);
  return r.json.data.accessToken ?? r.json.data.tokens?.accessToken;
};
const me = async (token) => (await call('GET', '/api/v1/auth/me', { token })).json.data;
const profile = async (token) => (await call('GET', '/api/v1/organization', { token })).json.data;
const patchTz = async (token, timezone, extra = {}) => {
  const current = await profile(token);
  return call('PATCH', '/api/v1/organization', { token, body: { timezone, ...extra }, headers: { 'If-Match': String(current.version) } });
};

before(async () => {
  if (skip) return;
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  server = await MongoMemoryServer.create({ binary: { systemBinary: MONGOD } });
  mongoose = (await import('mongoose')).default;
  await mongoose.connect(server.getUri());
  M = await import('../src/models/index.js');
  await Promise.all(Object.values(M).filter((m) => m?.syncIndexes).map((m) => m.syncIndexes()));
  const { createApp } = await import('../src/app.js');
  const { usersRepository } = await import('../src/modules/users/index.js');
  const { hashPassword } = await import('../src/utils/password.js');
  const { withTenant } = await import('../src/tenancy/tenantContext.js');
  W.withTenant = withTenant;

  const org = async (slug, name, timezone) => (await M.Organization.create({ slug, legalName: `${name} LLC`, tradingName: name, state: 'ACTIVE', countryCode: 'US', timezone, primaryContactName: 'Owner', primaryContactEmail: `${slug}@example.com` }))._id;
  W.A = await org('harbor-aba', 'Harbor ABA', 'America/New_York');
  W.B = await org('prairie-aba', 'Prairie ABA', 'America/Chicago');
  const passwordHash = await hashPassword('Str0ng-Passw0rd!');
  const account = (tenantId, email, roleKey) => usersRepository.createActiveAccountWithPassword({ userId: randomUUID(), membershipId: randomUUID(), tenantId, email, fullName: email.split('@')[0], passwordHash, roleKey });
  await account(W.A, 'admin.a@example.com', 'org_admin');
  await account(W.A, 'bcba.a@example.com', 'bcba');
  await account(W.A, 'rbt.a@example.com', 'rbt');
  await account(W.B, 'admin.b@example.com', 'org_admin');

  // A historical appointment instant, stored before any timezone change.
  W.startAt = new Date('2026-09-15T13:00:00.000Z');
  W.apptId = randomUUID();
  await M.Appointment.collection.insertOne({ _id: W.apptId, tenantId: W.A, startAt: W.startAt, endAt: new Date('2026-09-15T14:00:00.000Z'), businessTimeZone: 'America/New_York', status: 'SCHEDULED' });
  W.clientId = (await withTenant(W.A, () => M.Client.create({ clientNumber: 'C-1', firstName: 'Mia', lastName: 'Khan', status: 'ACTIVE' })))._id;

  app = createApp();
  httpServer = http.createServer(app).listen(0);
  await new Promise((r) => httpServer.once('listening', r));
  base = `http://127.0.0.1:${httpServer.address().port}`;
  W.admin = await signIn('admin.a@example.com');
  W.bcba = await signIn('bcba.a@example.com');
  W.rbt = await signIn('rbt.a@example.com');
  W.adminB = await signIn('admin.b@example.com');
});

after(async () => {
  httpServer?.close();
  await mongoose?.disconnect();
  await server?.stop();
});

test('Company Admin views the organization timezone; every role receives it on /auth/me', { skip }, async () => {
  assert.equal((await profile(W.admin)).timezone, 'America/New_York');
  for (const token of [W.admin, W.bcba, W.rbt]) assert.equal((await me(token)).organizationTimezone, 'America/New_York');
  assert.equal((await me(W.adminB)).organizationTimezone, 'America/Chicago');
});

test('BCBA and RBT cannot change the timezone (403) and nothing is written', { skip }, async () => {
  for (const token of [W.bcba, W.rbt]) {
    const r = await patchTz(token, 'America/Denver');
    assert.equal(r.status, 403, JSON.stringify(r.json));
  }
  assert.equal((await M.Organization.findById(W.A).lean()).timezone, 'America/New_York');
});

test('invalid timezones are rejected (422) and nothing is written', { skip }, async () => {
  for (const bad of ['Mars/Olympus', 'EST', '+05:00', 'america/new_york', 'Eastern Time', '', 'UTC-4']) {
    const r = await patchTz(W.admin, bad);
    assert.equal(r.status, 422, `${JSON.stringify(bad)} → ${r.status}`);
  }
  assert.equal((await M.Organization.findById(W.A).lean()).timezone, 'America/New_York');
});

test('Company Admin changes the timezone: persisted as the IANA id, returned, and /auth/me follows for admin, BCBA and RBT — other organizations untouched', { skip }, async () => {
  // A body organizationId/tenantId is stripped: the tenant is the caller's.
  const r = await patchTz(W.admin, 'America/Chicago', { organizationId: W.B, tenantId: W.B });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.data.timezone, 'America/Chicago');

  assert.equal((await M.Organization.findById(W.A).lean()).timezone, 'America/Chicago');
  assert.equal((await profile(W.admin)).timezone, 'America/Chicago'); // persists across reads (reload)
  for (const token of [W.admin, W.bcba, W.rbt]) assert.equal((await me(token)).organizationTimezone, 'America/Chicago');

  // Organization B was not changed and B's admin cannot see or change A.
  assert.equal((await M.Organization.findById(W.B).lean()).timezone, 'America/Chicago');
  const rB = await patchTz(W.adminB, 'America/Phoenix');
  assert.equal(rB.status, 200);
  assert.equal((await M.Organization.findById(W.B).lean()).timezone, 'America/Phoenix');
  assert.equal((await M.Organization.findById(W.A).lean()).timezone, 'America/Chicago');
  assert.equal((await me(W.admin)).organizationTimezone, 'America/Chicago');
});

test('historical timestamps are not rewritten by a timezone change', { skip }, async () => {
  const appt = await M.Appointment.collection.findOne({ _id: W.apptId });
  assert.equal(appt.startAt.toISOString(), W.startAt.toISOString());
  assert.equal(appt.businessTimeZone, 'America/New_York'); // booking-time snapshot left as recorded
});

test('server business dates follow the NEW organization timezone (dashboard today, payroll week, billing period), DST-aware', { skip }, async () => {
  // Org A is now America/Chicago.
  const { DashboardsService, dashboardsService } = await import('../src/modules/dashboards/index.js');
  const { PayrollService } = await import('../src/modules/payroll/index.js');
  const { claimsService } = await import('../src/modules/claims/index.js');

  // 04:30Z on 09/15 is 00:30 on 09/15 in New York but still 23:30 on 09/14 in Chicago.
  const dash = await new DashboardsService({ ...dashboardsService.deps, now: () => new Date('2026-09-15T04:30:00Z') }).companyDashboard({ tenantId: W.A });
  assert.equal(dash.businessDate, '2026-09-14');

  // Monday 09/21 04:30Z: New York has finished the week 09/14–09/20; Chicago is still on Sunday 09/20.
  const pay = await new PayrollService({ clock: { now: () => new Date('2026-09-21T04:30:00Z') } }).previewPeriodPayroll(W.A, { mode: 'weekly' });
  assert.match(JSON.stringify(pay.period), /09\/07\/2026/);

  // A billing period starting 09/01 begins at Chicago midnight (CDT, UTC−5), and
  // a period starting 12/01 at Chicago midnight in CST (UTC−6) — DST from the tz database.
  const sept = await claimsService.previewChildBilling(W.A, { clientId: W.clientId, from: '2026-09-01', to: '2026-09-30' });
  assert.equal(sept.period.timeZone, 'America/Chicago');
  assert.equal(new Date(sept.period.startDate).toISOString(), '2026-09-01T05:00:00.000Z');
  const dec = await claimsService.previewChildBilling(W.A, { clientId: W.clientId, from: '2026-12-01', to: '2026-12-31' });
  assert.equal(new Date(dec.period.startDate).toISOString(), '2026-12-01T06:00:00.000Z');
});
