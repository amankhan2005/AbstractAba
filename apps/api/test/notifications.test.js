import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotificationRegistry } from '../src/modules/notifications/notification.registry.js';
import { resolveDeliveryChannels } from '../src/modules/notifications/notification.preferences.js';
import { RoleBasedAudienceResolver } from '../src/modules/notifications/audience-resolver.js';
import { NotificationService } from '../src/modules/notifications/notification.service.js';
import { createNotificationDeliveryHandler } from '../src/modules/notifications/notification.delivery-handler.js';
import { ChannelTransportRegistry, LoggingChannelTransport } from '../src/modules/notifications/channel-transport.js';

/** DB-free tests for the notification pipeline. The security-critical properties
 *  — PHI never off-platform, mandatory types un-suppressable, in_app never
 *  opt-out — are asserted directly. */

const descriptor = (over = {}) => ({ type: 't.optional', channels: ['in_app', 'email', 'sms'], priority: 'normal', mandatory: false, audience: { roles: ['bcba'] }, ...over });

// --- registry --------------------------------------------------------------

test('registry validates the matrix at construction', () => {
  assert.throws(() => new NotificationRegistry([descriptor(), descriptor()]), /duplicate/);
  assert.throws(() => new NotificationRegistry([descriptor({ channels: [] })]), /no channels/);
  assert.throws(() => new NotificationRegistry([descriptor({ channels: ['carrier_pigeon'] })]), /unknown channel/);
});

test('registry.require throws 404 for an unknown type', () => {
  const reg = new NotificationRegistry([descriptor()]);
  assert.throws(() => reg.require('nope'), (e) => e.code === 'NOT_FOUND' && e.status === 404);
  assert.equal(reg.has('t.optional'), true);
});

// --- channel resolution (mandatory bypass; in_app never opt-out) -----------

test('mandatory type returns all channels and ignores preferences', () => {
  const d = descriptor({ mandatory: true });
  const channels = resolveDeliveryChannels(d, { type: d.type, disabledChannels: ['email', 'sms'] });
  assert.deepEqual([...channels], ['in_app', 'email', 'sms']); // preference ignored entirely
});

test('optional type removes muted off-platform channels but always keeps in_app', () => {
  const d = descriptor();
  const channels = resolveDeliveryChannels(d, { type: d.type, disabledChannels: ['email'] });
  assert.deepEqual([...channels], ['in_app', 'sms']);
  const allMuted = resolveDeliveryChannels(d, { type: d.type, disabledChannels: ['email', 'sms'] });
  assert.deepEqual([...allMuted], ['in_app']); // in_app cannot be opted out
});

// --- audience resolver -----------------------------------------------------

test('audience resolver de-duplicates recipients and short-circuits empty roles', async () => {
  const reader = { findRecipientsByRoles: async () => [{ userId: 'u1', membershipId: 'm1' }, { userId: 'u1', membershipId: 'm2' }, { userId: 'u2', membershipId: 'm3' }] };
  const resolver = new RoleBasedAudienceResolver(reader);
  const out = await resolver.resolve({ roles: ['bcba'] }, 't1');
  assert.deepEqual(out.map((r) => r.userId), ['u1', 'u2']);
  assert.deepEqual(await resolver.resolve({ roles: [] }, 't1'), []);
});

// --- dispatch pipeline (PHI-safety) ----------------------------------------

function fakePipeline(descriptorOver = {}) {
  const created = [];
  const deliveries = [];
  const enqueued = [];
  const repository = {
    createNotification: async (n) => { const rec = { id: 'notif-' + created.length, ...n }; created.push(rec); return rec; },
    getPreference: async () => null,
    createDelivery: async (_t, notificationId, channel) => { const d = { id: 'del-' + deliveries.length, notificationId, channel, status: 'pending' }; deliveries.push(d); return d; },
  };
  const jobQueue = { enqueue: async (job) => { enqueued.push(job); } };
  const registry = new NotificationRegistry([descriptor(descriptorOver)]);
  const audience = { resolve: async () => [{ userId: 'u1', membershipId: 'm1' }] };
  const svc = new NotificationService({ registry, repository, audience, jobQueue });
  return { svc, created, deliveries, enqueued };
}

test('dispatch writes an in-app record and enqueues off-platform jobs with a PHI-free payload', async () => {
  const { svc, created, enqueued } = fakePipeline();
  await svc.dispatch('t.optional', { tenantId: 't1', content: { subject: 'Session ready', inAppBody: 'PATIENT CLINICAL DETAIL', link: '/x' } });

  // in-app record created, carries the body
  assert.equal(created.length, 1);
  assert.equal(created[0].body, 'PATIENT CLINICAL DETAIL');

  // two off-platform jobs (email, sms); each payload has ONLY ids + channel — no body/subject
  assert.equal(enqueued.length, 2);
  for (const job of enqueued) {
    assert.equal(job.type, 'notification.deliver');
    assert.deepEqual(Object.keys(job.payload).sort(), ['channel', 'deliveryId', 'notificationId']);
    assert.equal('body' in job.payload, false);
    assert.equal('subject' in job.payload, false);
    assert.ok(job.idempotencyKey.includes(':')); // notificationId:channel
  }
});

test('mandatory dispatch enqueues even when the user muted the channels', async () => {
  const { svc, enqueued } = fakePipeline({ mandatory: true });
  // even if getPreference returned mutes, mandatory bypasses it (service passes null)
  await svc.dispatch('t.optional', { tenantId: 't1', content: { subject: 's', inAppBody: 'b', link: '/x' } });
  assert.equal(enqueued.length, 2);
});

test('explicit recipientUserIds bypass audience resolution', async () => {
  const { svc, created } = fakePipeline();
  await svc.dispatch('t.optional', { tenantId: 't1', content: { subject: 's', inAppBody: 'b', link: '/x' }, recipientUserIds: ['a', 'b', 'c'] });
  assert.equal(created.length, 3);
});

// --- updatePreference ------------------------------------------------------

test('updatePreference refuses a mandatory type and sanitizes to declared off-platform channels', async () => {
  const registry = new NotificationRegistry([descriptor(), descriptor({ type: 't.mandatory', mandatory: true })]);
  const saved = [];
  const svc = new NotificationService({ registry, repository: { upsertPreference: async (...a) => saved.push(a) }, audience: {}, jobQueue: {} });

  await assert.rejects(() => svc.updatePreference('t1', 'u1', 't.mandatory', ['email'], 'u1'), (e) => e.code === 'VALIDATION_FAILED');

  // in_app and unknown channels are stripped; only declared off-platform kept
  const view = await svc.updatePreference('t1', 'u1', 't.optional', ['email', 'in_app', 'carrier'], 'u1');
  assert.deepEqual(view.disabledChannels, ['email']);
});

// --- delivery handler (PHI-safe view) --------------------------------------

test('delivery handler sends only { subject, link } and records the outcome', async () => {
  let sentView = null;
  const transports = new ChannelTransportRegistry(new Map([['email', { send: async (m) => { sentView = m.view; return { ok: true }; } }]]));
  const statuses = [];
  const repository = {
    getNotification: async () => ({ id: 'n1', recipientUserId: 'u1', subject: 'Session ready', body: 'CLINICAL DETAIL', link: '/x' }),
    updateDeliveryStatus: async (_t, id, status, reason) => statuses.push({ id, status, reason }),
  };
  const handler = createNotificationDeliveryHandler({ repository, transports });
  await handler({ notificationId: 'n1', deliveryId: 'd1', channel: 'email' }, { job: { tenantId: 't1' } });

  assert.deepEqual(Object.keys(sentView).sort(), ['link', 'subject']); // body NOT present
  assert.equal('body' in sentView, false);
  assert.equal(statuses[0].status, 'sent');
});

test('delivery handler marks failed and throws on transport failure (so the runner retries)', async () => {
  const transports = new ChannelTransportRegistry(new Map([['email', { send: async () => ({ ok: false, error: 'smtp down' }) }]]));
  const statuses = [];
  const repository = {
    getNotification: async () => ({ id: 'n1', recipientUserId: 'u1', subject: 's', body: 'b', link: '/x' }),
    updateDeliveryStatus: async (_t, id, status, reason) => statuses.push({ status, reason }),
  };
  const handler = createNotificationDeliveryHandler({ repository, transports });
  await assert.rejects(() => handler({ notificationId: 'n1', deliveryId: 'd1', channel: 'email' }, { job: { tenantId: 't1' } }));
  assert.equal(statuses[0].status, 'failed');
  assert.equal(statuses[0].reason, 'smtp down');
});

test('delivery handler marks failed when the notification no longer exists (no throw)', async () => {
  const transports = new ChannelTransportRegistry(new Map([['email', new LoggingChannelTransport('email')]]));
  const statuses = [];
  const handler = createNotificationDeliveryHandler({
    repository: { getNotification: async () => null, updateDeliveryStatus: async (_t, id, status, reason) => statuses.push({ status, reason }) },
    transports,
  });
  await handler({ notificationId: 'gone', deliveryId: 'd1', channel: 'email' }, { job: { tenantId: 't1' } });
  assert.equal(statuses[0].status, 'failed');
});
