import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InquiryService,
  INQUIRY_NOTIFY_TEAM_JOB,
  INQUIRY_CONFIRM_SUBMITTER_JOB,
  DUPLICATE_WINDOW_MS,
} from '../src/modules/inquiries/inquiry.service.js';
import { submitInquirySchema, updateInquirySchema } from '../src/modules/inquiries/inquiry.schemas.js';
import {
  createInquiryTeamNotificationHandler,
  createInquiryConfirmationHandler,
  CONFIRMATION_TEXT,
} from '../src/modules/inquiries/inquiry.email.js';

/**
 * Public website inquiries. DB-free: the repository, job queue and email
 * transport are fakes, so these prove the service, validation and email
 * contracts. Access control over HTTP is covered in inquiries-db.test.js.
 */
const VALID = {
  name: 'Jane Doe',
  organization: 'Bright Steps ABA',
  email: 'jane@brightsteps.example',
  phone: '+1 (555) 010-2000',
  subject: 'Product walkthrough',
  message: 'We are a team of 20 and would like to learn more.',
  website: '',
};

function makeService({ clock } = {}) {
  const store = new Map();
  let seq = 0;
  const repository = {
    async create(doc) { seq += 1; const e = { id: `inq-${seq}`, createdAt: clock?.now?.() ?? new Date(), contactedAt: null, closedAt: null, internalNote: null, ...doc }; store.set(e.id, e); return { ...e }; },
    async findRecentDuplicate(key, since) { return [...store.values()].find((e) => e.submissionKey === key && e.createdAt >= since) ?? null; },
    async list({ status } = {}) { return [...store.values()].filter((e) => !status || e.status === status); },
    async countByStatus() { const c = {}; for (const e of store.values()) c[e.status] = (c[e.status] ?? 0) + 1; return c; },
    async findById(id) { const e = store.get(id); return e ? { ...e } : null; },
    async update(id, patch) { const e = { ...store.get(id), ...patch }; store.set(id, e); return { ...e }; },
  };
  const jobs = [];
  const jobQueue = { async enqueue(job) { jobs.push(job); return job; } };
  const audits = [];
  const audit = { async record(entry) { audits.push(entry); } };
  return { svc: new InquiryService({ repository, jobQueue, audit, clock }), store, jobs, audits };
}

test('schema trims, lowercases the email, keeps message line breaks and drops an empty phone', () => {
  const r = submitInquirySchema.safeParse({ ...VALID, name: '  Jane  ', email: ' JANE@Example.COM ', phone: '', message: 'Line one here.\nLine two.' });
  assert.equal(r.success, true);
  assert.equal(r.data.name, 'Jane');
  assert.equal(r.data.email, 'jane@example.com');
  assert.equal(r.data.phone, undefined);
  assert.equal(r.data.message, 'Line one here.\nLine two.');
});

test('schema rejects empty, invalid, oversized and unknown fields', () => {
  assert.equal(submitInquirySchema.safeParse({}).success, false);
  assert.equal(submitInquirySchema.safeParse({ ...VALID, email: 'not-an-email' }).success, false);
  assert.equal(submitInquirySchema.safeParse({ ...VALID, phone: 'call me' }).success, false);
  assert.equal(submitInquirySchema.safeParse({ ...VALID, message: 'x'.repeat(5001) }).success, false);
  assert.equal(submitInquirySchema.safeParse({ ...VALID, name: 'n'.repeat(121) }).success, false);
  assert.equal(submitInquirySchema.safeParse({ ...VALID, message: 'short' }).success, false);
  // Server-authoritative fields can never be supplied by the visitor.
  assert.equal(submitInquirySchema.safeParse({ ...VALID, status: 'CLOSED' }).success, false);
  assert.equal(submitInquirySchema.safeParse({ ...VALID, tenantId: 't-1' }).success, false);
});

test('update schema requires a status or a note and only accepts known statuses', () => {
  assert.equal(updateInquirySchema.safeParse({}).success, false);
  assert.equal(updateInquirySchema.safeParse({ status: 'ARCHIVED' }).success, false);
  assert.equal(updateInquirySchema.safeParse({ status: 'CONTACTED' }).success, true);
  assert.equal(updateInquirySchema.safeParse({ internalNote: null }).success, true);
});

test('submit persists a NEW inquiry and enqueues the team notification and the confirmation', async () => {
  const { svc, store, jobs, audits } = makeService();
  const receipt = await svc.submit(submitInquirySchema.parse(VALID));
  assert.deepEqual(receipt, { received: true });
  assert.equal(store.size, 1);
  const saved = [...store.values()][0];
  assert.equal(saved.status, 'NEW');
  assert.equal(saved.email, 'jane@brightsteps.example');
  assert.equal(saved.website, undefined, 'the honeypot field is never stored');
  assert.deepEqual(jobs.map((j) => j.type), [INQUIRY_NOTIFY_TEAM_JOB, INQUIRY_CONFIRM_SUBMITTER_JOB]);
  assert.equal(jobs[0].idempotencyKey, `inquiry-team:${saved.id}`);
  assert.equal(jobs[1].payload.email, 'jane@brightsteps.example');
  assert.equal(audits[0].action, 'inquiry.received');
  assert.equal(audits[0].payload.message, undefined, 'the audit trail never carries the message text');
});

test('a filled honeypot returns the same receipt without storing or emailing', async () => {
  const { svc, store, jobs } = makeService();
  const receipt = await svc.submit({ ...VALID, website: 'http://spam.example' });
  assert.deepEqual(receipt, { received: true });
  assert.equal(store.size, 0);
  assert.equal(jobs.length, 0);
});

test('a duplicate inside the window is absorbed; after the window it is accepted again', async () => {
  let now = new Date('2026-09-15T12:00:00Z');
  const { svc, store, jobs } = makeService({ clock: { now: () => now } });
  await svc.submit(VALID);
  await svc.submit({ ...VALID, email: 'JANE@brightsteps.example' });
  assert.equal(store.size, 1);
  assert.equal(jobs.length, 2);
  now = new Date(now.getTime() + DUPLICATE_WINDOW_MS + 1000);
  await svc.submit(VALID);
  assert.equal(store.size, 2);
});

test('status changes stamp contactedAt / closedAt, notes are trimmed, and a missing id 404s', async () => {
  const { svc, store, audits } = makeService();
  await svc.submit(VALID);
  const id = [...store.keys()][0];

  const contacted = await svc.update({ id, actorUserId: 'op-1', input: { status: 'CONTACTED', internalNote: '  Called on Monday.  ' } });
  assert.equal(contacted.status, 'CONTACTED');
  assert.ok(contacted.contactedAt instanceof Date);
  assert.equal(contacted.contactedBy, 'op-1');
  assert.equal(contacted.internalNote, 'Called on Monday.');

  const closed = await svc.update({ id, actorUserId: 'op-2', input: { status: 'CLOSED' } });
  assert.equal(closed.status, 'CLOSED');
  assert.ok(closed.closedAt instanceof Date);
  assert.equal(closed.contactedAt.getTime(), contacted.contactedAt.getTime(), 'contactedAt is preserved');

  const cleared = await svc.update({ id, actorUserId: 'op-2', input: { internalNote: '' } });
  assert.equal(cleared.internalNote, null);

  assert.deepEqual(audits.map((a) => a.action), ['inquiry.received', 'inquiry.status_changed', 'inquiry.note_updated', 'inquiry.status_changed', 'inquiry.note_updated']);
  await assert.rejects(() => svc.update({ id: 'nope', actorUserId: 'op', input: { status: 'CLOSED' } }), (e) => e.code === 'INQUIRY_NOT_FOUND');
  await assert.rejects(() => svc.get('nope'), (e) => e.code === 'INQUIRY_NOT_FOUND');
});

test('list returns items with per-status counts', async () => {
  const { svc } = makeService();
  await svc.submit(VALID);
  await svc.submit({ ...VALID, subject: 'Another question' });
  const out = await svc.list();
  assert.equal(out.items.length, 2);
  assert.deepEqual(out.counts, { NEW: 2, CONTACTED: 0, CLOSED: 0 });
});

function fakeTransports() {
  const sent = [];
  return { sent, transports: { has: (k) => k === 'email', get: () => ({ async send(m) { sent.push(m); } }) } };
}

test('team notification goes to the support inbox with escaped submitter content', async () => {
  const { sent, transports } = fakeTransports();
  const handler = createInquiryTeamNotificationHandler({ transports, notifyEmail: 'info@abstractaba.com', consoleUrl: 'https://console.example/' });
  await handler({ inquiryId: 'inq-1', name: '<script>alert(1)</script>', organization: 'Bright', email: 'jane@example.com', phone: null, subject: 'Hi <b>there</b>', message: 'Hello\n<img src=x onerror=alert(1)>', submittedAt: new Date() });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].recipientEmail, 'info@abstractaba.com');
  assert.equal(sent[0].view.link, 'https://console.example/inquiries');
  assert.ok(!sent[0].view.html.includes('<script>alert(1)</script>'));
  assert.ok(!sent[0].view.html.includes('<img src=x'));
  assert.ok(sent[0].view.html.includes('&lt;script&gt;'));
  assert.ok(sent[0].view.body.includes('Phone: Not provided'));
});

test('confirmation goes to the submitter with the agreed wording', async () => {
  const { sent, transports } = fakeTransports();
  await createInquiryConfirmationHandler({ transports })({ inquiryId: 'inq-1', name: 'Jane Doe', email: 'jane@example.com', subject: 'Demo' });
  assert.equal(sent[0].recipientEmail, 'jane@example.com');
  assert.equal(CONFIRMATION_TEXT, 'Thank you for contacting Abstract ABA. We’ve received your inquiry and our team will connect with you soon.');
  assert.ok(sent[0].view.body.includes(CONFIRMATION_TEXT));
  assert.ok(sent[0].view.html.includes('Hello Jane,'));
});

test('handlers fail loudly (so the job retries) when no email transport exists', async () => {
  const transports = { has: () => false, get: () => null };
  await assert.rejects(() => createInquiryConfirmationHandler({ transports })({ email: 'a@b.co', name: 'A', subject: 'S' }));
});
