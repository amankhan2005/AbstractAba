import { AppError } from '../../common/errors/AppError.js';
import { isOffPlatformChannel } from './notification.tokens.js';
import { resolveDeliveryChannels } from './notification.preferences.js';

/** The job type the delivery worker handles; enqueued for off-platform channels. */
export const NOTIFICATION_DELIVERY_JOB = 'notification.deliver';

/**
 * Raises notifications and serves the in-app centre and preferences. dispatch()
 * writes the in-app record for every recipient (the synchronous delivery), then
 * for each off-platform channel the recipient should receive — preferences
 * applied, mandatory types bypassing them — enqueues a delivery job through the
 * JobQueue port. Nothing about the clinical body is ever placed on a job
 * payload. Ported from the original; enqueue adapted to the MERN queue signature.
 */
export class NotificationService {
  constructor(deps) {
    this.registry = deps.registry;
    this.repository = deps.repository;
    this.audience = deps.audience;
    this.jobQueue = deps.jobQueue;
  }

  async dispatch(type, context) {
    const descriptor = this.registry.require(type);
    const recipients = await this.resolveRecipients(descriptor, context);

    for (const recipient of recipients) {
      const notification = await this.repository.createNotification({
        tenantId: context.tenantId,
        recipientUserId: recipient.userId,
        type,
        priority: descriptor.priority,
        subject: context.content.subject,
        body: context.content.inAppBody,
        link: context.content.link,
      });

      const preference = descriptor.mandatory
        ? null
        : await this.repository.getPreference(context.tenantId, recipient.userId, type);
      const channels = resolveDeliveryChannels(descriptor, preference);

      for (const channel of channels) {
        if (!isOffPlatformChannel(channel)) continue; // in-app delivery is the row itself
        const delivery = await this.repository.createDelivery(context.tenantId, notification.id, channel);
        await this.jobQueue.enqueue({
          type: NOTIFICATION_DELIVERY_JOB,
          tenantId: context.tenantId,
          payload: { notificationId: notification.id, deliveryId: delivery.id, channel },
          idempotencyKey: `${notification.id}:${channel}`,
        });
      }
    }
  }

  async resolveRecipients(descriptor, context) {
    if (context.recipientUserIds !== undefined) {
      return context.recipientUserIds.map((userId) => ({ userId, membershipId: '' }));
    }
    return this.audience.resolve(descriptor.audience, context.tenantId);
  }

  // --- in-app centre --------------------------------------------------------
  listForRecipient(tenantId, userId, query) { return this.repository.listForRecipient(tenantId, userId, query); }
  unreadCount(tenantId, userId) { return this.repository.unreadCount(tenantId, userId); }
  markRead(tenantId, userId, id) { return this.repository.markRead(tenantId, userId, id); }
  markAllRead(tenantId, userId) { return this.repository.markAllRead(tenantId, userId); }

  // --- preferences ----------------------------------------------------------
  async getPreferences(tenantId, userId) {
    const stored = await this.repository.listPreferences(tenantId, userId);
    const disabledByType = new Map(stored.map((p) => [p.type, p.disabledChannels]));
    return this.registry.list().map((d) => ({
      type: d.type,
      mandatory: d.mandatory,
      channels: d.channels,
      disabledChannels: d.mandatory ? [] : (disabledByType.get(d.type) ?? []),
    }));
  }

  async updatePreference(tenantId, userId, type, disabledChannels, actorId) {
    const descriptor = this.registry.require(type);
    if (descriptor.mandatory) {
      throw new AppError('VALIDATION_FAILED', { status: 422, message: 'This notification is mandatory and cannot be disabled.' });
    }
    // Only off-platform channels this type declares may be muted; in_app never.
    const declared = new Set(descriptor.channels);
    const sanitized = [...new Set(disabledChannels)].filter((c) => isOffPlatformChannel(c) && declared.has(c));
    await this.repository.upsertPreference(tenantId, userId, type, sanitized, actorId);
    return { type: descriptor.type, mandatory: false, channels: descriptor.channels, disabledChannels: sanitized };
  }
}
