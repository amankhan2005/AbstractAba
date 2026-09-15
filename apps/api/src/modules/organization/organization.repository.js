import mongoose from 'mongoose';
import {
  Organization,
  OrganizationStateTransition,
  Membership,
  UsageEvent,
} from '../../models/index.js';
import { withPlatform, withTenant } from '../../tenancy/tenantContext.js';
import { supportsTransactions } from '../../config/db.js';
import { auditService } from '../audit/audit.service.js';
import { orgError } from './organization.errors.js';

/**
 * Persistence for the organization module (MongoDB/Mongoose).
 *
 * Scope discipline mirrors the original repository port:
 *   - organization / state-transition / usage are PLATFORM-scoped collections
 *     (the tenant plugin is not applied to them), reached via withPlatform().
 *   - membership IS tenant-owned; a user's memberships span tenants, so that one
 *     deliberate cross-tenant read runs under withPlatform() and is filtered by
 *     user identity — exactly the original's "platform scope by necessity".
 *
 * Optimistic concurrency replaces the original's `version` guard: every mutation
 * matches on the expected version and $inc's it, so a concurrent writer is told
 * the record changed rather than silently overwriting it.
 */
export class OrganizationRepository {
  async create(input) {
    return withPlatform(async () => {
      const doc = await Organization.create({
        _id: input.id,
        slug: input.slug,
        legalName: input.legalName,
        tradingName: input.tradingName,
        countryCode: input.countryCode,
        stateCode: input.stateCode ?? null,
        timezone: input.timezone,
        locale: input.locale ?? 'en-US',
        primaryContactName: input.primaryContactName,
        primaryContactEmail: input.primaryContactEmail,
        planCode: input.planCode ?? null,
        serviceStates: Array.isArray(input.serviceStates) ? input.serviceStates : [],
        logoUrl: input.logoUrl ?? null,
        state: 'PROVISIONING',
      });
      return toDomain(doc.toObject());
    });
  }

  async findById(id) {
    return withPlatform(async () => {
      const doc = await Organization.findById(id).lean();
      return doc ? toDomain(doc) : null;
    });
  }

  async findBySlug(slug) {
    return withPlatform(async () => {
      const doc = await Organization.findOne({ slug }).lean();
      return doc ? toDomain(doc) : null;
    });
  }

  /**
   * Resolves the organization behind a request host for pre-auth branding.
   * A configured custom domain wins; otherwise the leftmost label is treated as
   * the slug (e.g. `clinic.aba1on1.com` -> slug `clinic`).
   */
  async findByHost(host) {
    return withPlatform(async () => {
      const byDomain = await Organization.findOne({ customDomain: host }).lean();
      if (byDomain) return toDomain(byDomain);
      const label = host.split('.')[0];
      if (!label) return null;
      const bySlug = await Organization.findOne({ slug: label }).lean();
      return bySlug ? toDomain(bySlug) : null;
    });
  }

  async slugExists(slug) {
    return withPlatform(async () => (await Organization.exists({ slug })) !== null);
  }

  async list(query) {
    return withPlatform(async () => {
      const filter = {};
      if (query.state) filter.state = query.state;
      if (query.search) {
        const rx = new RegExp(escapeRegExp(query.search), 'i');
        filter.$or = [{ slug: rx }, { tradingName: rx }, { legalName: rx }];
      }
      // _id is UUID v7 (time-ordered), so keyset pagination on _id is chronological.
      if (query.cursor) filter._id = { $lt: query.cursor };

      const limit = query.limit ?? 25;
      const rows = await Organization.find(filter)
        .sort({ _id: -1 })
        .limit(limit + 1)
        .lean();

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? items[items.length - 1]._id : null;
      return { items: items.map(toDomain), nextCursor };
    });
  }

  /**
   * Applies a lifecycle transition and records it atomically: the organization
   * row and its immutable state-transition log entry move together. The
   * hash-chained audit entry is appended after commit through the AuditService
   * (its own tenant-scoped, retrying writer), the sole audit integration point.
   */
  async applyTransition(input) {
    const now = new Date();
    const set = { state: input.toState, updatedBy: input.actorUserId };
    if (input.toState === 'ACTIVE') set.activatedAt = now;
    if (input.toState === 'SUSPENDED') set.suspendedAt = now;
    if (input.toState === 'OFFBOARDING') set.offboardingAt = now;
    if (input.toState === 'DESTROYED') set.destroyedAt = now;

    const updated = await withPlatform(async () => {
      if (supportsTransactions()) {
        const session = await mongoose.startSession();
        try {
          let result;
          await session.withTransaction(async () => {
            result = await this._transitionCore(input, set, session);
          });
          return result;
        } finally {
          await session.endSession();
        }
      }
      // Standalone mongod fallback: the version guard is still the integrity
      // anchor; the transition log follows the successful state change.
      return this._transitionCore(input, set, null);
    });

    // Append-only, hash-chained audit of the lifecycle change (metadata only).
    await auditService.record({
      tenantId: input.organizationId,
      actorId: input.actorUserId,
      action: 'organization.state.transitioned',
      entityType: 'organization',
      entityId: input.organizationId,
      outcome: 'success',
      payload: { fromState: input.fromState, toState: input.toState, reason: input.reason },
    });

    return updated;
  }

  async _transitionCore(input, set, session) {
    const opts = session ? { new: true, session } : { new: true };
    const updated = await Organization.findOneAndUpdate(
      { _id: input.organizationId, version: input.expectedVersion },
      { $set: set, $inc: { version: 1 } },
      opts,
    ).lean();

    if (!updated) {
      // Either the row is gone or the version moved. Distinguish for a clear error.
      const exists = await Organization.exists({ _id: input.organizationId });
      throw exists ? orgError('VERSION_CONFLICT') : orgError('TENANT_RESOURCE_NOT_FOUND');
    }

    await OrganizationStateTransition.create(
      session
        ? [{
            _id: input.transitionId,
            organizationId: input.organizationId,
            fromState: input.fromState,
            toState: input.toState,
            reason: input.reason,
            actorUserId: input.actorUserId,
            occurredAt: new Date(),
          }]
        : [{
            _id: input.transitionId,
            organizationId: input.organizationId,
            fromState: input.fromState,
            toState: input.toState,
            reason: input.reason,
            actorUserId: input.actorUserId,
            occurredAt: new Date(),
          }],
      session ? { session } : {},
    );

    return toDomain(updated);
  }

  async updateProfile(input) {
    return withPlatform(async () => {
      const updated = await Organization.findOneAndUpdate(
        { _id: input.organizationId, version: input.expectedVersion },
        { $set: { ...input.changes, updatedBy: input.actorUserId }, $inc: { version: 1 } },
        { new: true },
      ).lean();
      if (!updated) {
        const exists = await Organization.exists({ _id: input.organizationId });
        throw exists ? orgError('VERSION_CONFLICT') : orgError('TENANT_RESOURCE_NOT_FOUND');
      }
      return toDomain(updated);
    });
  }

  async findMembership({ tenantId, userId }) {
    return withTenant(tenantId, async () => {
      const m = await Membership.findOne({ userId }).lean();
      if (!m) return null;
      return { id: m._id, tenantId: m.tenantId, userId: m.userId, status: m.status, isOwner: !!m.isOwner };
    });
  }

  /**
   * A user's memberships across every tenant — the deliberate cross-tenant read.
   * Runs at platform scope (plugin bypass) and is filtered by user identity.
   */
  async listMembershipsForUser(userId) {
    return withPlatform(async () => {
      const memberships = await Membership.find({ userId }).lean();
      if (memberships.length === 0) return [];
      const orgIds = [...new Set(memberships.map((m) => m.tenantId))];
      const orgs = await Organization.find({ _id: { $in: orgIds } })
        .select({ slug: 1, tradingName: 1, state: 1 })
        .lean();
      const orgById = new Map(orgs.map((o) => [o._id, o]));
      return memberships
        .map((m) => {
          const org = orgById.get(m.tenantId);
          if (!org) return null;
          return {
            membershipId: m._id,
            organizationId: m.tenantId,
            organizationSlug: org.slug,
            organizationTradingName: org.tradingName,
            organizationState: org.state,
            isOwner: !!m.isOwner,
            status: m.status,
          };
        })
        .filter((x) => x !== null);
    });
  }

  async summariseUsage(tenantId) {
    return withPlatform(async () => {
      const rows = await UsageEvent.aggregate([
        { $match: { organizationId: tenantId } },
        { $group: { _id: '$metricKey', total: { $sum: '$quantity' } } },
        { $sort: { _id: 1 } },
      ]);
      return rows.map((r) => ({ metricKey: r._id, total: String(r.total) }));
    });
  }
}

function toDomain(doc) {
  return {
    id: doc._id,
    slug: doc.slug,
    legalName: doc.legalName,
    tradingName: doc.tradingName,
    state: doc.state,
    countryCode: doc.countryCode,
    stateCode: doc.stateCode ?? null,
    serviceStates: Array.isArray(doc.serviceStates) ? doc.serviceStates : [],
    timezone: doc.timezone,
    locale: doc.locale ?? 'en-US',
    primaryContactName: doc.primaryContactName,
    primaryContactEmail: doc.primaryContactEmail,
    planCode: doc.planCode ?? null,
    logoUrl: doc.logoUrl ?? null,
    customDomain: doc.customDomain ?? null,
    parentOrganizationId: doc.parentOrganizationId ?? null,
    destructionGraceDays: doc.destructionGraceDays ?? null,
    agreementId: doc.agreementId ?? null,
    activatedAt: doc.activatedAt ?? null,
    offboardingAt: doc.offboardingAt ?? null,
    destroyedAt: doc.destroyedAt ?? null,
    createdAt: doc.createdAt ?? null,
    version: doc.version ?? 1,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const organizationRepository = new OrganizationRepository();
