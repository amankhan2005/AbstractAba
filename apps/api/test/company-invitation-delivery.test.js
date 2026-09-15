import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCompanyInvitationDeliveryHandler } from '../src/modules/company-invitations/company-invitation.routes.js';
import { JobRegistry } from '../src/modules/jobs/job.registry.js';
import { JobWorker } from '../src/modules/jobs/job.worker.js';
import { jobRegistry } from '../src/modules/jobs/index.js';
import { COMPANY_INVITATION_DELIVERY_JOB } from '../src/modules/company-invitations/index.js'; // import composes + registers

// A transport double that records exactly what it was asked to send.
function fakeTransport() {
  const sent = [];
  return { registry: { has: (k) => k === 'email', get: () => ({ send: async (m) => { sent.push(m); return { ok: true, messageId: 'm_1' }; } }) }, sent };
}

// A minimal in-memory job repo matching the JobWorker's port. Records outcomes.
function fakeRepo(jobs) {
  const outcomes = { succeeded: [], dead: [], retried: [] };
  const queue = [...jobs];
  return {
    outcomes,
    async claimNext() { return queue.shift() ?? null; },
    async markSucceeded(id) { outcomes.succeeded.push(id); },
    async markDead(id, err) { outcomes.dead.push({ id, err }); },
    async markRetry(id, runAt, err) { outcomes.retried.push({ id, err }); },
  };
}

// ============================================================================
// RUNTIME WORKER PATH — the path the previous tests did NOT exercise.
// The worker invokes handler(job.payload, { job }); a handler that read `.payload`
// off its first arg got undefined and threw, so a correctly-registered job still
// dead-lettered. These tests drive the REAL JobWorker so that mismatch fails loudly.
// ============================================================================

test('WORKER PATH: a company_invitation.deliver job is processed to SUCCESS (not dead-lettered)', async () => {
  const t = fakeTransport();
  const registry = new JobRegistry();
  registry.register({
    type: COMPANY_INVITATION_DELIVERY_JOB,
    handler: createCompanyInvitationDeliveryHandler({ transports: t.registry, webAppUrl: 'https://app.aba1on1.test' }),
    maxAttempts: 5,
  });
  const job = {
    _id: 'job-1', type: COMPANY_INVITATION_DELIVERY_JOB, tenantId: null, attempts: 0,
    payload: { email: 'owner@example.com', token: 'new-token-abc', expiresAt: new Date(Date.now() + 3600_000), companyName: 'sunrise aba', contactName: 'aman khan' },
  };
  const repo = fakeRepo([job]);
  const worker = new JobWorker(registry, { repo });

  await worker.run(job); // drive the real worker execution path

  assert.deepEqual(repo.outcomes.dead, [], 'job must NOT be dead-lettered');
  assert.deepEqual(repo.outcomes.retried, [], 'job must NOT be retried');
  assert.deepEqual(repo.outcomes.succeeded, ['job-1'], 'job must be marked succeeded');
  // and the transport actually received the right message via the worker path:
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].recipientEmail, 'owner@example.com');           // exact owner recipient
  assert.equal(t.sent[0].view.link, 'https://app.aba1on1.test/onboarding/new-token-abc'); // NEW token in link
  assert.match(t.sent[0].view.subject, /Welcome to Sunrise Aba/);
  assert.match(t.sent[0].view.body, /Hello Aman,/);
});

test('WORKER PATH: transport failure RETRIES first, dead-letters only after maxAttempts', async () => {
  const registry = new JobRegistry();
  const throwing = { has: () => true, get: () => ({ send: async () => { throw new Error('Resend delivery failed: domain not verified'); } }) };
  registry.register({ type: COMPANY_INVITATION_DELIVERY_JOB, handler: createCompanyInvitationDeliveryHandler({ transports: throwing, webAppUrl: 'https://x.test' }), maxAttempts: 5 });
  const worker = new JobWorker(registry, { repo: null });

  const early = fakeRepo([]); worker.repo = early;
  await worker.run({ _id: 'j', type: COMPANY_INVITATION_DELIVERY_JOB, tenantId: null, attempts: 0, payload: { email: 'o@e.co', token: 't', expiresAt: new Date() } });
  assert.equal(early.outcomes.retried.length, 1, 'early failure retries');
  assert.equal(early.outcomes.dead.length, 0);

  const exhausted = fakeRepo([]); worker.repo = exhausted;
  await worker.run({ _id: 'j', type: COMPANY_INVITATION_DELIVERY_JOB, tenantId: null, attempts: 5, payload: { email: 'o@e.co', token: 't', expiresAt: new Date() } });
  assert.equal(exhausted.outcomes.dead.length, 1, 'exhausted attempts dead-letters');
  assert.doesNotMatch(exhausted.outcomes.dead[0].err ?? '', /token|apiKey|password/i); // no secrets in the recorded error
});

// --- registry wiring guards (previous fix) -----------------------------------
test('company_invitation.deliver handler IS registered on the shared jobRegistry', () => {
  assert.equal(jobRegistry.has(COMPANY_INVITATION_DELIVERY_JOB), true);
  assert.equal(typeof jobRegistry.get(COMPANY_INVITATION_DELIVERY_JOB)?.handler, 'function');
});

test('server.js wires the worker to the shared jobRegistry (regression guard)', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  assert.match(src, /import\s*\{\s*jobRegistry\s*\}\s*from\s*'\.\/modules\/jobs\/index\.js'/);
  assert.match(src, /new JobWorker\(jobRegistry/);
  assert.doesNotMatch(src, /new JobRegistry\(\)/);
});

// --- clean fallbacks (no undefined/null in the email) ------------------------
test('greeting/company fall back cleanly when optional fields are absent', async () => {
  const t = fakeTransport();
  const handler = createCompanyInvitationDeliveryHandler({ transports: t.registry, webAppUrl: 'https://x.test' });
  await handler({ email: 'o@e.co', token: 't', expiresAt: new Date(Date.now() + 1000), companyName: null, contactName: null });
  assert.doesNotMatch(t.sent[0].view.body, /undefined|null/);
  assert.match(t.sent[0].view.body, /Hello there,/);
});
