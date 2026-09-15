import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResendEmailTransport } from '../src/modules/notifications/resend-email-transport.js';

function fakeResendClient(behavior) {
  return { emails: { send: async (mail) => behavior(mail) } };
}

test('isConfigured requires apiKey and fromEmail', () => {
  assert.equal(new ResendEmailTransport({ apiKey: '', fromEmail: '' }).isConfigured(), false);
  assert.equal(new ResendEmailTransport({ apiKey: 'k', fromEmail: '' }).isConfigured(), false);
  assert.equal(new ResendEmailTransport({ apiKey: 'k', fromEmail: 'a@b.co' }).isConfigured(), true);
});

test('send throws clearly when Resend is not configured (no silent success)', async () => {
  const t = new ResendEmailTransport({ apiKey: '', fromEmail: '' });
  await assert.rejects(
    () => t.send({ recipientEmail: 'x@y.co', view: { subject: 's', link: 'http://l' } }),
    /Resend is not configured/,
  );
});

test('send delivers via Resend with from/to/subject and the onboarding link', async () => {
  let received = null;
  const client = fakeResendClient(async (mail) => { received = mail; return { data: { id: 'resend-1' }, error: null }; });
  const t = new ResendEmailTransport(
    { apiKey: 'k', fromEmail: 'noreply@x.co', fromName: 'Abstract ABA' },
    { client },
  );
  const res = await t.send({
    recipientEmail: 'owner@company.example',
    view: { subject: 'Company onboarding invitation', link: 'http://localhost:3000/onboarding/tok', body: 'Open http://localhost:3000/onboarding/tok' },
  });
  assert.equal(res.ok, true);
  assert.equal(res.messageId, 'resend-1');
  assert.equal(received.from, 'Abstract ABA <noreply@x.co>');
  assert.equal(received.to, 'owner@company.example');
  assert.match(received.html, /onboarding\/tok/);
});

test('send surfaces a Resend error instead of faking success', async () => {
  const client = fakeResendClient(async () => ({ data: null, error: { message: 'domain not verified' } }));
  const t = new ResendEmailTransport({ apiKey: 'k', fromEmail: 'noreply@x.co' }, { client });
  await assert.rejects(
    () => t.send({ recipientEmail: 'a@b.co', view: { subject: 's', link: 'http://l' } }),
    /Resend delivery failed: domain not verified/,
  );
});

test('send requires a recipient', async () => {
  const client = fakeResendClient(async () => ({ data: { id: 'x' }, error: null }));
  const t = new ResendEmailTransport({ apiKey: 'k', fromEmail: 'a@b.co' }, { client });
  await assert.rejects(() => t.send({ view: { subject: 's' } }), /recipientEmail/);
});
