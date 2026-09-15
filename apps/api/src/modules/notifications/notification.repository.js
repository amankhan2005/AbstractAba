import { Notification, NotificationDelivery, NotificationPreference, Membership, MembershipRole, Role } from '../../models/index.js';
import { withTenant } from '../../tenancy/tenantContext.js';
import { newId } from '../../utils/id.js';

/**
 * Reads active memberships by role within a tenant — the narrow view of the
 * membership model the notification audience needs. A dedicated port keeps
 * notifications decoupled from users/RBAC internals. Tenant-scoped.
 */
export class MongoRoleMembershipReader {
  async findRecipientsByRoles(tenantId, roleKeys) {
    return withTenant(tenantId, async () => {
      const roles = await Role.find({ key: { $in: [...roleKeys] } }).select({ _id: 1 }).lean();
      if (roles.length === 0) return [];
      const roleIds = roles.map((r) => r._id);
      const assignments = await MembershipRole.find({ roleId: { $in: roleIds } }).select({ membershipId: 1 }).lean();
      if (assignments.length === 0) return [];
      const membershipIds = [...new Set(assignments.map((a) => a.membershipId))];
      const memberships = await Membership.find({ _id: { $in: membershipIds }, status: 'ACTIVE' })
        .select({ _id: 1, userId: 1 }).lean();
      return memberships.map((m) => ({ userId: m.userId, membershipId: m._id }));
    });
  }
}

/**
 * Persistence for notifications, deliveries and preferences (MongoDB/Mongoose).
 * Every method is tenant-scoped and inherits the tenant plugin's isolation on
 * the three collections. There is no delete — a notification and its delivery
 * record persist so "I never got it" stays answerable. Ported from the original.
 */
export class NotificationRepository {
  async createNotification(input) {
    return withTenant(input.tenantId, async () => {
      const doc = await Notification.create({
        _id: newId(),
        recipientUserId: input.recipientUserId,
        type: input.type,
        priority: input.priority,
        subject: input.subject,
        body: input.body,
        link: input.link,
      });
      return toNotification(doc.toObject());
    });
  }

  async createDelivery(tenantId, notificationId, channel) {
    return withTenant(tenantId, async () => {
      const doc = await NotificationDelivery.create({ _id: newId(), notificationId, channel, status: 'pending' });
      return { id: doc._id, notificationId, channel, status: 'pending', failureReason: null };
    });
  }

  async updateDeliveryStatus(tenantId, deliveryId, status, failureReason) {
    await withTenant(tenantId, async () =>
      NotificationDelivery.updateOne({ _id: deliveryId }, { $set: { status, failureReason } }),
    );
  }

  async getNotification(tenantId, id) {
    return withTenant(tenantId, async () => {
      const doc = await Notification.findById(id).lean();
      return doc ? toNotification(doc) : null;
    });
  }

  async listForRecipient(tenantId, recipientUserId, query) {
    return withTenant(tenantId, async () => {
      const filter = { recipientUserId };
      if (query.unreadOnly) filter.readAt = null;
      const docs = await Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip(query.offset ?? 0)
        .limit(query.limit ?? 50)
        .lean();
      return docs.map(toNotification);
    });
  }

  async unreadCount(tenantId, recipientUserId) {
    return withTenant(tenantId, async () => Notification.countDocuments({ recipientUserId, readAt: null }));
  }

  async markRead(tenantId, recipientUserId, id) {
    // Scoped to the recipient: a user can only mark their own notifications read.
    await withTenant(tenantId, async () =>
      Notification.updateOne({ _id: id, recipientUserId, readAt: null }, { $set: { readAt: new Date() } }),
    );
  }

  async markAllRead(tenantId, recipientUserId) {
    await withTenant(tenantId, async () =>
      Notification.updateMany({ recipientUserId, readAt: null }, { $set: { readAt: new Date() } }),
    );
  }

  async getPreference(tenantId, userId, type) {
    return withTenant(tenantId, async () => {
      const doc = await NotificationPreference.findOne({ userId, type }).lean();
      return doc ? { type: doc.type, disabledChannels: doc.disabledChannels ?? [] } : null;
    });
  }

  async listPreferences(tenantId, userId) {
    return withTenant(tenantId, async () => {
      const docs = await NotificationPreference.find({ userId }).lean();
      return docs.map((d) => ({ type: d.type, disabledChannels: d.disabledChannels ?? [] }));
    });
  }

  async upsertPreference(tenantId, userId, type, disabledChannels, actorId) {
    await withTenant(tenantId, async () =>
      NotificationPreference.updateOne(
        { userId, type },
        { $set: { disabledChannels: [...disabledChannels], updatedBy: actorId }, $setOnInsert: { _id: newId() } },
        { upsert: true },
      ),
    );
  }
}

function toNotification(doc) {
  return {
    id: doc._id,
    tenantId: doc.tenantId,
    recipientUserId: doc.recipientUserId,
    type: doc.type,
    priority: doc.priority,
    subject: doc.subject,
    body: doc.body,
    link: doc.link,
    readAt: doc.readAt ? new Date(doc.readAt).toISOString() : null,
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
  };
}

export const notificationRepository = new NotificationRepository();
export const roleMembershipReader = new MongoRoleMembershipReader();
