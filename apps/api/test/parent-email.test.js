import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderParentEmail, unsupportedVariablesIn, getParentEmailTemplate, SUPPORTED_EMAIL_VARIABLES } from '../src/modules/clients/parent-email.templates.js';
import { ClientsService } from '../src/modules/clients/clients.service.js';

const CTX = { childFirstName: 'Mia', parentFirstName: 'Sarah', companyName: 'Example ABA' };

// --- pure renderer ---------------------------------------------------------

test('renders supported variables from context', () => {
  const t = getParentEmailTemplate('child_approved');
  const out = renderParentEmail({ subject: t.subject, body: t.body }, CTX);
  assert.equal(out.subject, 'Your child Mia has been approved');
  assert.ok(out.text.includes('Hello Sarah,'));
  assert.ok(out.text.includes('Example ABA'));
});

test('unsupported variables are rejected (browser is not the authority)', () => {
  assert.deepEqual(unsupportedVariablesIn('Hi {{childFirstName}} and {{ssn}}'), ['ssn']);
  assert.throws(() => renderParentEmail({ subject: 'Hi {{ssn}}', body: 'x' }, CTX), (e) => Array.isArray(e.unsupported) && e.unsupported.includes('ssn'));
});

test('a supported-but-missing value renders "Not available", never undefined', () => {
  const out = renderParentEmail({ subject: 'Appt {{appointmentDate}}', body: 'b' }, CTX);
  assert.equal(out.subject, 'Appt Not available');
  assert.ok(!out.subject.toLowerCase().includes('undefined'));
  assert.deepEqual(out.unavailable, ['appointmentDate']);
});

test('substituted values are HTML-escaped (no injection from edited content)', () => {
  const out = renderParentEmail({ subject: 's', body: '{{parentFirstName}}' }, { parentFirstName: '<script>bad()</script>' });
  assert.ok(out.html.includes('&lt;script&gt;'));
  assert.ok(!out.html.includes('<script>'));
});

// --- service preview / send (resolution server-side) -----------------------

function makeService({ guardians = [{ isPrimary: true, firstName: 'Sarah', lastName: 'T', email: 'sarah@example.com' }], email } = {}) {
  const repo = {
    findClientById: async () => ({ id: 'c1', clientNumber: 'AB-1', firstName: 'Mia', lastName: 'Thompson', status: 'ACTIVE', version: 1, sensitive: { ssn: null } }),
    listGuardians: async () => guardians,
  };
  const sent = [];
  const svc = new ClientsService({
    repository: repo,
    organizations: { getById: async () => ({ state: 'ACTIVE', name: 'Example ABA' }) },
    phi: { seal: (x) => x, open: (x) => x },
    email: email ?? { send: async (m) => { sent.push(m); return { ok: true, messageId: 'msg_1' }; } },
  });
  svc.__sent = sent;
  return svc;
}

test('previewParentEmail resolves recipient + sender server-side and sends nothing', async () => {
  const svc = makeService();
  const out = await svc.previewParentEmail({ tenantId: 't', clientId: 'c1', templateId: 'child_approved' });
  assert.equal(out.recipient.email, 'sarah@example.com');
  assert.equal(out.recipient.available, true);
  assert.equal(out.sender.resolved, 'server');
  assert.equal(out.subject, 'Your child Mia has been approved');
  assert.equal(svc.__sent.length, 0, 'preview must not send');
});

test('sendParentEmail sends via the injected transport with the resolved guardian recipient', async () => {
  const svc = makeService();
  const out = await svc.sendParentEmail({ tenantId: 't', clientId: 'c1', actorUserId: 'u', templateId: 'child_approved' });
  assert.equal(out.status, 'SENT');
  assert.equal(out.messageId, 'msg_1');
  assert.equal(svc.__sent.length, 1);
  assert.equal(svc.__sent[0].recipientEmail, 'sarah@example.com'); // server-resolved, not client-supplied
});

test('sending with no guardian email is a clean 422, never a fake success', async () => {
  const svc = makeService({ guardians: [{ isPrimary: true, firstName: 'Sarah', lastName: 'T', email: null }] });
  await assert.rejects(
    () => svc.sendParentEmail({ tenantId: 't', clientId: 'c1', actorUserId: 'u', templateId: 'child_approved' }),
    (e) => e.code === 'GUARDIAN_EMAIL_UNAVAILABLE',
  );
  assert.equal(svc.__sent.length, 0);
});

test('a provider failure propagates — success is never fabricated', async () => {
  const svc = makeService({ email: { send: async () => { throw new Error('Resend delivery failed: rejected'); } } });
  await assert.rejects(() => svc.sendParentEmail({ tenantId: 't', clientId: 'c1', actorUserId: 'u', templateId: 'child_approved' }));
});

test('edited body with an unsupported variable is rejected at send', async () => {
  const svc = makeService();
  await assert.rejects(
    () => svc.sendParentEmail({ tenantId: 't', clientId: 'c1', actorUserId: 'u', templateId: 'custom_admin_message', body: 'Hello {{parentFirstName}} {{accountNumber}}' }),
    (e) => e.code === 'EMAIL_UNSUPPORTED_VARIABLE',
  );
  assert.equal(svc.__sent.length, 0);
});
