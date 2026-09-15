import mongoose from 'mongoose';
import { TreatmentPlan, Goal, Program, Target } from '../../models/index.js';
import { withTenant } from '../../tenancy/tenantContext.js';
import { supportsTransactions } from '../../config/db.js';
import { plansError } from './plans.errors.js';
import { scopeToClients } from '../rbac/scopeFilters.js';

/**
 * Persistence for the clinical planning module (plan → goal → program →
 * target). Every tenant-owned operation runs under withTenant(); the tenant
 * plugin stamps and scopes it and fails closed without a context. Archive is a
 * status transition (not a soft-delete), so archived records stay readable and
 * filterable; cascade archive uses the denormalised treatmentPlanId that every
 * descendant carries, in a transaction where the deployment supports it.
 */
export class PlansRepository {
  // --- treatment plans -----------------------------------------------------

  async createPlan(tenantId, doc) {
    return withTenant(tenantId, async () => {
      const created = await TreatmentPlan.create(doc);
      return toPlan(created.toObject());
    });
  }

  /**
   * Create a plan as ACTIVE while guaranteeing exactly one ACTIVE plan per
   * child (spec Part 1 §4). Any current ACTIVE plan for the same client is
   * demoted to DRAFT in the SAME unit of work, then the new ACTIVE plan is
   * inserted — so a reader can never observe two active plans, and a failure
   * cannot leave the child with zero (the demote and insert commit together
   * where the deployment supports transactions).
   *
   * Demote-to-DRAFT (not archive) is deliberate: it is non-destructive (no
   * cascade over the superseded plan's goal/program/target tree) and fully
   * reversible, and it never touches historical DRAFT or ARCHIVED plans — only
   * the one plan that is currently ACTIVE. Tenant scoping is the tenantPlugin's;
   * both writes run inside withTenant, so isolation holds.
   */
  async createActivePlan(tenantId, doc, actorUserId) {
    return withTenant(tenantId, async () => {
      let created;
      await this._maybeTx(async (session) => {
        const opt = session ? { session } : {};
        await TreatmentPlan.updateMany(
          { clientId: doc.clientId, status: 'ACTIVE', deletedAt: null },
          { $set: { status: 'DRAFT', updatedBy: actorUserId } },
          opt,
        );
        const rows = await TreatmentPlan.create([doc], session ? { session } : {});
        created = rows[0];
      });
      return toPlan(created.toObject());
    });
  }

  async findPlanById(tenantId, planId) {
    return withTenant(tenantId, async () => {
      const doc = await TreatmentPlan.findOne({ _id: planId, deletedAt: null }).lean();
      return doc ? toPlan(doc) : null;
    });
  }

  async listPlans(tenantId, query) {
    return withTenant(tenantId, async () => {
      const filter = { deletedAt: null };
      if (query.clientId) filter.clientId = query.clientId;
      // Blueprint 4.11: treatment plans are `own` scope for both BCBA and RBT
      // — a BCBA authors for their caseload, a technician reads only the plan
      // behind a child they are assigned to. Applied to the QUERY so a direct
      // ?clientId= cannot widen it.
      if (query.dataScope) scopeToClients(filter, query.dataScope);
      if (query.status) filter.status = query.status;
      if (query.cursor) filter._id = { $lt: query.cursor };
      const limit = query.limit ?? 25;
      const rows = await TreatmentPlan.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return { items: page.map(toPlan), nextCursor: hasMore ? page[page.length - 1]._id : null };
    });
  }

  /**
   * Goal and program counts for a PAGE of plans, in two grouped queries.
   *
   * The /plans roster shows each plan's content ("3 goals · 2 programs"), and
   * fetching that per row would be an N+1 — 25 plans would mean 50 extra round
   * trips. Both collections carry `treatmentPlanId` and are indexed on
   * (tenantId, treatmentPlanId), so one $group per collection covers the whole
   * page regardless of its size.
   *
   * Archived goals and programs are excluded, matching what the plan detail
   * page counts, so the roster and the plan itself never disagree.
   *
   * Returns a Map: planId -> { goalCount, programCount }.
   */
  async countPlanContent(tenantId, planIds) {
    if (!planIds || planIds.length === 0) return new Map();
    return withTenant(tenantId, async () => {
      const [goalRows, programRows] = await Promise.all([
        Goal.aggregate([
          { $match: { treatmentPlanId: { $in: planIds }, status: { $ne: 'ARCHIVED' }, deletedAt: null } },
          { $group: { _id: '$treatmentPlanId', n: { $sum: 1 } } },
        ]),
        Program.aggregate([
          { $match: { treatmentPlanId: { $in: planIds }, archivedAt: null } },
          { $group: { _id: '$treatmentPlanId', n: { $sum: 1 } } },
        ]),
      ]);
      const out = new Map(planIds.map((id) => [id, { goalCount: 0, programCount: 0 }]));
      for (const r of goalRows) if (out.has(r._id)) out.get(r._id).goalCount = r.n;
      for (const r of programRows) if (out.has(r._id)) out.get(r._id).programCount = r.n;
      return out;
    });
  }

  async updatePlan(tenantId, planId, patch, expectedVersion) {
    return withTenant(tenantId, async () => {
      const updated = await TreatmentPlan.findOneAndUpdate(
        { _id: planId, deletedAt: null, version: expectedVersion },
        { $set: patch, $inc: { version: 1 } },
        { new: true },
      ).lean();
      if (updated) return toPlan(updated);
      const exists = await TreatmentPlan.exists({ _id: planId, deletedAt: null });
      throw plansError(exists ? 'VERSION_CONFLICT' : 'PLAN_NOT_FOUND');
    });
  }

  async archivePlan(tenantId, planId, actorUserId) {
    return withTenant(tenantId, async () => {
      const now = new Date();
      await this._maybeTx(async (session) => {
        const opt = session ? { session } : {};
        await TreatmentPlan.updateOne({ _id: planId, deletedAt: null }, { $set: { status: 'ARCHIVED', updatedBy: actorUserId } }, opt);
        await Goal.updateMany({ treatmentPlanId: planId, status: { $ne: 'ARCHIVED' } }, { $set: { status: 'ARCHIVED', updatedBy: actorUserId } }, opt);
        await Program.updateMany({ treatmentPlanId: planId, archivedAt: null }, { $set: { archivedAt: now, updatedBy: actorUserId } }, opt);
        await Target.updateMany({ treatmentPlanId: planId, archivedAt: null }, { $set: { archivedAt: now, status: 'INACTIVE', updatedBy: actorUserId } }, opt);
      });
      return { planId, status: 'ARCHIVED' };
    });
  }

  /**
   * Delete a treatment plan. This is a soft-delete — the established removal
   * pattern across the app (clients, staff, sessions, guardians all set
   * `deletedAt`/`deletedBy`; every read in this repository already filters
   * `deletedAt: null`). Setting it makes the plan — and its whole goal /
   * program / target subtree — vanish from every list and detail read and stay
   * gone across a refresh, without physically destroying data (reversible,
   * audit-friendly). The cascade uses the denormalised treatmentPlanId every
   * descendant carries, committed together where the deployment supports
   * transactions, mirroring archivePlan. Tenant scoping is the tenantPlugin's:
   * the write runs inside withTenant, so a plan in one tenant can never be
   * deleted from another.
   */
  async deletePlan(tenantId, planId, actorUserId) {
    return withTenant(tenantId, async () => {
      const plan = await TreatmentPlan.findOne({ _id: planId, deletedAt: null }).lean();
      if (!plan) throw plansError('PLAN_NOT_FOUND');
      const now = new Date();
      await this._maybeTx(async (session) => {
        const opt = session ? { session } : {};
        await TreatmentPlan.updateOne({ _id: planId, deletedAt: null }, { $set: { deletedAt: now, deletedBy: actorUserId, updatedBy: actorUserId } }, opt);
        await Goal.updateMany({ treatmentPlanId: planId, deletedAt: null }, { $set: { deletedAt: now, deletedBy: actorUserId, updatedBy: actorUserId } }, opt);
        await Program.updateMany({ treatmentPlanId: planId, deletedAt: null }, { $set: { deletedAt: now, deletedBy: actorUserId, updatedBy: actorUserId } }, opt);
        await Target.updateMany({ treatmentPlanId: planId, deletedAt: null }, { $set: { deletedAt: now, deletedBy: actorUserId, updatedBy: actorUserId } }, opt);
      });
      return { planId, deleted: true };
    });
  }

  // --- goals ---------------------------------------------------------------

  async listGoals(tenantId, planId) {
    return withTenant(tenantId, async () => {
      const rows = await Goal.find({ treatmentPlanId: planId, deletedAt: null }).sort({ priority: 1, _id: 1 }).lean();
      return rows.map(toGoal);
    });
  }

  async addGoal(tenantId, planId, clientId, input) {
    return withTenant(tenantId, async () => {
      const doc = await Goal.create({ ...input, treatmentPlanId: planId, clientId });
      return toGoal(doc.toObject());
    });
  }

  async updateGoal(tenantId, planId, goalId, patch, expectedVersion) {
    return withTenant(tenantId, async () => {
      const query = { _id: goalId, treatmentPlanId: planId, deletedAt: null };
      if (expectedVersion !== undefined) query.version = expectedVersion;
      const updated = await Goal.findOneAndUpdate(query, { $set: patch, $inc: { version: 1 } }, { new: true }).lean();
      if (updated) return toGoal(updated);
      const exists = await Goal.exists({ _id: goalId, treatmentPlanId: planId, deletedAt: null });
      throw plansError(exists ? 'VERSION_CONFLICT' : 'GOAL_NOT_FOUND');
    });
  }

  async archiveGoal(tenantId, planId, goalId, actorUserId) {
    return withTenant(tenantId, async () => {
      const goal = await Goal.findOne({ _id: goalId, treatmentPlanId: planId, deletedAt: null }).lean();
      if (!goal) throw plansError('GOAL_NOT_FOUND');
      const now = new Date();
      await this._maybeTx(async (session) => {
        const opt = session ? { session } : {};
        await Goal.updateOne({ _id: goalId }, { $set: { status: 'ARCHIVED', updatedBy: actorUserId } }, opt);
        const programs = await Program.find({ goalId, deletedAt: null }, { _id: 1 }, opt).lean();
        const programIds = programs.map((p) => p._id);
        await Program.updateMany({ goalId, archivedAt: null }, { $set: { archivedAt: now, updatedBy: actorUserId } }, opt);
        if (programIds.length > 0) {
          await Target.updateMany({ programId: { $in: programIds }, archivedAt: null }, { $set: { archivedAt: now, status: 'INACTIVE', updatedBy: actorUserId } }, opt);
        }
      });
      return { goalId, status: 'ARCHIVED' };
    });
  }

  // --- programs ------------------------------------------------------------

  async listPrograms(tenantId, goalId) {
    return withTenant(tenantId, async () => {
      const rows = await Program.find({ goalId, deletedAt: null }).sort({ _id: 1 }).lean();
      return rows.map(toProgram);
    });
  }

  async findProgram(tenantId, planId, programId) {
    return withTenant(tenantId, async () => {
      const doc = await Program.findOne({ _id: programId, treatmentPlanId: planId, deletedAt: null }).lean();
      return doc ? toProgram(doc) : null;
    });
  }

  async addProgram(tenantId, planId, goalId, input) {
    return withTenant(tenantId, async () => {
      const doc = await Program.create({ ...input, goalId, treatmentPlanId: planId });
      return toProgram(doc.toObject());
    });
  }

  async updateProgram(tenantId, planId, programId, patch, expectedVersion) {
    return withTenant(tenantId, async () => {
      const query = { _id: programId, treatmentPlanId: planId, deletedAt: null };
      if (expectedVersion !== undefined) query.version = expectedVersion;
      const updated = await Program.findOneAndUpdate(query, { $set: patch, $inc: { version: 1 } }, { new: true }).lean();
      if (updated) return toProgram(updated);
      const exists = await Program.exists({ _id: programId, treatmentPlanId: planId, deletedAt: null });
      throw plansError(exists ? 'VERSION_CONFLICT' : 'PROGRAM_NOT_FOUND');
    });
  }

  async archiveProgram(tenantId, planId, programId, actorUserId) {
    return withTenant(tenantId, async () => {
      const program = await Program.findOne({ _id: programId, treatmentPlanId: planId, deletedAt: null }).lean();
      if (!program) throw plansError('PROGRAM_NOT_FOUND');
      const now = new Date();
      await this._maybeTx(async (session) => {
        const opt = session ? { session } : {};
        await Program.updateOne({ _id: programId }, { $set: { archivedAt: now, updatedBy: actorUserId } }, opt);
        await Target.updateMany({ programId, archivedAt: null }, { $set: { archivedAt: now, status: 'INACTIVE', updatedBy: actorUserId } }, opt);
      });
      return { programId, archivedAt: now };
    });
  }

  // --- targets -------------------------------------------------------------

  async listTargets(tenantId, programId) {
    return withTenant(tenantId, async () => {
      const rows = await Target.find({ programId, deletedAt: null }).sort({ _id: 1 }).lean();
      return rows.map(toTarget);
    });
  }

  /**
   * Additive read used by the session-capture module (Phase 2 · Step 6) to
   * verify a data point's target belongs to the session's plan and is active.
   * Pure lookup by id — no existing behaviour changes.
   */
  async findTargetById(tenantId, targetId) {
    return withTenant(tenantId, async () => {
      const doc = await Target.findOne({ _id: targetId, deletedAt: null }).lean();
      return doc ? toTarget(doc) : null;
    });
  }

  async addTarget(tenantId, planId, programId, input) {
    return withTenant(tenantId, async () => {
      const doc = await Target.create({ ...input, programId, treatmentPlanId: planId });
      return toTarget(doc.toObject());
    });
  }

  async updateTarget(tenantId, programId, targetId, patch, expectedVersion) {
    return withTenant(tenantId, async () => {
      const query = { _id: targetId, programId, deletedAt: null };
      if (expectedVersion !== undefined) query.version = expectedVersion;
      const updated = await Target.findOneAndUpdate(query, { $set: patch, $inc: { version: 1 } }, { new: true }).lean();
      if (updated) return toTarget(updated);
      const exists = await Target.exists({ _id: targetId, programId, deletedAt: null });
      throw plansError(exists ? 'VERSION_CONFLICT' : 'TARGET_NOT_FOUND');
    });
  }

  async archiveTarget(tenantId, programId, targetId, actorUserId) {
    return withTenant(tenantId, async () => {
      const res = await Target.findOneAndUpdate(
        { _id: targetId, programId, deletedAt: null },
        { $set: { archivedAt: new Date(), status: 'INACTIVE', updatedBy: actorUserId } },
        { new: true },
      ).lean();
      if (!res) throw plansError('TARGET_NOT_FOUND');
      return toTarget(res);
    });
  }

  async _maybeTx(fn) {
    if (!supportsTransactions()) return fn(null);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => { await fn(session); });
    } finally {
      await session.endSession();
    }
  }
}

// --- mappers ---------------------------------------------------------------

function toPlan(doc) {
  return {
    id: doc._id,
    clientId: doc.clientId,
    title: doc.title,
    responsibleBcbaStaffId: doc.responsibleBcbaStaffId,
    status: doc.status,
    effectiveDate: doc.effectiveDate ?? null,
    reviewDate: doc.reviewDate ?? null,
    notes: doc.notes ?? null,
    createdAt: doc.createdAt,
    // Mongoose `timestamps` stamps updatedAt on every save; it was previously
    // dropped from the projection, so the detail page's "Last updated" and the
    // /plans roster's "Updated" line had no value to render and fell back to a
    // broken placeholder. Surface the real persisted value.
    updatedAt: doc.updatedAt ?? null,
    version: doc.version,
  };
}
function toGoal(doc) {
  return {
    id: doc._id,
    treatmentPlanId: doc.treatmentPlanId,
    clientId: doc.clientId,
    description: doc.description,
    term: doc.term,
    priority: doc.priority,
    status: doc.status,
    progress: doc.progress,
    version: doc.version,
  };
}
function toProgram(doc) {
  return {
    id: doc._id,
    goalId: doc.goalId,
    treatmentPlanId: doc.treatmentPlanId,
    name: doc.name,
    instructions: doc.instructions ?? null,
    teachingProcedure: doc.teachingProcedure ?? null,
    reinforcementStrategy: doc.reinforcementStrategy ?? null,
    promptHierarchy: doc.promptHierarchy ?? [],
    measurementMethod: doc.measurementMethod ?? null,
    archivedAt: doc.archivedAt ?? null,
    version: doc.version,
  };
}
function toTarget(doc) {
  return {
    id: doc._id,
    programId: doc.programId,
    treatmentPlanId: doc.treatmentPlanId,
    label: doc.label,
    measurementType: doc.measurementType,
    baseline: doc.baseline ?? null,
    masteryCriteria: doc.masteryCriteria ?? null,
    currentProgress: doc.currentProgress,
    status: doc.status,
    weeklyFocus: doc.weeklyFocus ?? false,
    weeklyInstructions: doc.weeklyInstructions ?? null,
    archivedAt: doc.archivedAt ?? null,
    version: doc.version,
  };
}

export const plansRepository = new PlansRepository();
