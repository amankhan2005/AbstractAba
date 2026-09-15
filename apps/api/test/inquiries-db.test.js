import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * WEBSITE INQUIRIES — end to end against a throwaway MongoDB and the real HTTP
 * app: anonymous submit (validation, persistence, email jobs, honeypot,
 * duplicates) and the operator-only review surface (401 anonymous, 403 for
 * Company Admin / BCBA / RBT, status management for platform operators).
 */
process.env.BCRYPT_ROUNDS = process.env.BCRYPT_ROUNDS ?? '4';
// The per-client submit limit is exercised in its own test below.
process.env.INQUIRY_RATE_LIMIT_MAX = process.env.INQUIRY_RATE_LIMIT_MAX ?? '8';
const CANDIDATES = [process.env.MONGOMS_SYSTEM_BINARY, '/opt/homebrew/bin/mongod', '/usr/local/bin/mongod', '/usr/bin/mongod'].filter(Boolean);
const MONGOD = CANDIDATES.find((p) => existsSync(p)) ?? null;
const skip = MONGOD ? false : 'no local mongod binary (set MONGOMS_SYSTEM_BINARY)';

let server; let mongoose; let M; let httpServer; let base;
const W = {};
const PASSWORD = 'Str0ng-Passw0rd!';
const VALID = {
  name: 'Jane Doe',
  organization: 'Bright Steps ABA',
  email: 'jane@brightsteps.example',
  subject: 'Product walkthrough',
  message: 'We would like to learn how Abstract ABA fits our workflow.',
};

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
}
const signIn = async (email) => {
  const r = await call('POST', '/api/v1/auth/sign-in', { body: { email, password: PASSWORD } });
  assert.equal(r.status, 200, `sign-in ${email}: ${JSON.stringify(r.json)}`);
  return r.json.data.accessToken ?? r.json.data.tokens?.accessToken;
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
  const { withPlatform } = await import('../src/tenancy/tenantContext.js');
  W.withPlatform = withPlatform;

  const passwordHash = await hashPassword(PASSWORD);
  const tenantId = (await M.Organization.create({ slug: 'harbor-aba', legalName: 'Harbor ABA LLC', tradingName: 'Harbor ABA', state: 'ACTIVE', countryCode: 'US', timezone: 'America/New_York', primaryContactName: 'Owner', primaryContactEmail: 'owner@example.com' }))._id;
  const account = (email, roleKey) => usersRepository.createActiveAccountWithPassword({ userId: randomUUID(), membershipId: randomUUID(), tenantId, email, fullName: email.split('@')[0], passwordHash, roleKey });
  await account('admin@example.com', 'org_admin');
  await account('bcba@example.com', 'bcba');
  await account('rbt@example.com', 'rbt');
  await withPlatform(() => M.User.create({ email: 'operator@example.com', fullName: 'Platform Operator', isPlatformOperator: true, passwordHash, status: 'ACTIVE' }));

  httpServer = http.createServer(createApp()).listen(0);
  await new Promise((r) => httpServer.once('listening', r));
  base = `http://127.0.0.1:${httpServer.address().port}`;
  W.admin = await signIn('admin@example.com');
  W.bcba = await signIn('bcba@example.com');
  W.rbt = await signIn('rbt@example.com');
  W.operator = await signIn('operator@example.com');
});

after(async () => {
  httpServer?.close();
  await mongoose?.disconnect();
  await server?.stop();
});

const inquiries = () => W.withPlatform(() => M.Inquiry.find({}).lean());
const jobsOf = (type) => W.withPlatform(() => M.Job.find({ type }).lean());

test('anonymous submit validates, persists a NEW inquiry and queues both emails', { skip }, async () => {
  const bad = await call('POST', '/api/v1/public/inquiries', { body: { ...VALID, email: 'nope', message: '' } });
  assert.equal(bad.status, 422, JSON.stringify(bad.json));
  assert.equal((await inquiries()).length, 0);

  const injected = await call('POST', '/api/v1/public/inquiries', { body: { ...VALID, status: 'CLOSED' } });
  assert.equal(injected.status, 422, 'server-owned fields are rejected');

  const ok = await call('POST', '/api/v1/public/inquiries', { body: { ...VALID, name: '<b>Jane</b> Doe', phone: '555-010-2000', website: '' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.deepEqual(ok.json.data, { received: true }, 'the response exposes no record details');

  const rows = await inquiries();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'NEW');
  assert.equal(rows[0].name, '<b>Jane</b> Doe', 'stored as plain text; every renderer escapes it');
  assert.ok(rows[0].createdAt instanceof Date);
  W.inquiryId = rows[0]._id;

  const team = await jobsOf('inquiry.notify_team');
  const confirm = await jobsOf('inquiry.confirm_submitter');
  assert.equal(team.length, 1);
  assert.equal(confirm.length, 1);
  assert.equal(confirm[0].payload.email, VALID.email);
});

test('duplicates and honeypot hits are absorbed without new records or emails', { skip }, async () => {
  const dup = await call('POST', '/api/v1/public/inquiries', { body: { ...VALID, name: '<b>Jane</b> Doe', phone: '555-010-2000' } });
  assert.equal(dup.status, 201);
  const bot = await call('POST', '/api/v1/public/inquiries', { body: { ...VALID, subject: 'Buy now', website: 'http://spam.example' } });
  assert.equal(bot.status, 201);
  assert.equal((await inquiries()).length, 1);
  assert.equal((await jobsOf('inquiry.notify_team')).length, 1);
});

test('only platform operators can read or change inquiries', { skip }, async () => {
  assert.equal((await call('GET', '/api/v1/platform/inquiries')).status, 401);
  for (const token of [W.admin, W.bcba, W.rbt]) {
    assert.equal((await call('GET', '/api/v1/platform/inquiries', { token })).status, 403);
    assert.equal((await call('GET', `/api/v1/platform/inquiries/${W.inquiryId}`, { token })).status, 403);
    assert.equal((await call('PATCH', `/api/v1/platform/inquiries/${W.inquiryId}`, { token, body: { status: 'CLOSED' } })).status, 403);
  }
  assert.equal((await inquiries())[0].status, 'NEW', 'refused requests changed nothing');

  const list = await call('GET', '/api/v1/platform/inquiries', { token: W.operator });
  assert.equal(list.status, 200, JSON.stringify(list.json));
  assert.equal(list.json.data.items.length, 1);
  assert.deepEqual(list.json.data.counts, { NEW: 1, CONTACTED: 0, CLOSED: 0 });
  assert.equal(list.json.data.items[0].submissionKey, undefined, 'internal dedupe key is not exposed');
});

test('operator marks contacted, adds a note, closes, and filters by status', { skip }, async () => {
  const path = `/api/v1/platform/inquiries/${W.inquiryId}`;
  const contacted = await call('PATCH', path, { token: W.operator, body: { status: 'CONTACTED', internalNote: 'Emailed pricing overview.' } });
  assert.equal(contacted.status, 200, JSON.stringify(contacted.json));
  assert.equal(contacted.json.data.status, 'CONTACTED');
  assert.ok(contacted.json.data.contactedAt);
  assert.equal(contacted.json.data.internalNote, 'Emailed pricing overview.');

  const closed = await call('PATCH', path, { token: W.operator, body: { status: 'CLOSED' } });
  assert.equal(closed.json.data.status, 'CLOSED');
  assert.ok(closed.json.data.closedAt);

  assert.equal((await call('PATCH', path, { token: W.operator, body: { status: 'ARCHIVED' } })).status, 422);
  assert.equal((await call('PATCH', path, { token: W.operator, body: {} })).status, 422);
  assert.equal((await call('GET', '/api/v1/platform/inquiries/missing-id', { token: W.operator })).status, 404);

  const onlyClosed = await call('GET', '/api/v1/platform/inquiries?status=CLOSED', { token: W.operator });
  assert.equal(onlyClosed.json.data.items.length, 1);
  const onlyNew = await call('GET', '/api/v1/platform/inquiries?status=NEW', { token: W.operator });
  assert.equal(onlyNew.json.data.items.length, 0);

  const detail = await call('GET', path, { token: W.operator });
  assert.equal(detail.json.data.message, VALID.message);
});

test('the per-client submit limit returns a friendly 429', { skip }, async () => {
  let last;
  for (let i = 0; i < 10; i += 1) {
    last = await call('POST', '/api/v1/public/inquiries', { body: { ...VALID, subject: `Question number ${i}` } });
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429);
  assert.equal(last.json.error.code, 'INQUIRY-429');
});
