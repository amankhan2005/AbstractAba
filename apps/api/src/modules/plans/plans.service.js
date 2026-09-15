import { plansError } from './plans.errors.js';

/**
 * Clinical planning business rules. The repository holds data access; the
 * organization port answers the ACTIVE gate; the clients and staff ports
 * validate the client (must be ACTIVE to create a plan) and the responsible
 * BCBA (must be an active staff member). Dependencies are injected so the
 * orchestration is exercised without a database.
 *
 * Invariants enforced here:
 *   - ACTIVE gate on every write (409 otherwise).
 *   - A plan may only be created for an ACTIVE client.
 *   - The responsible BCBA must be an active staff member.
 *   - An ARCHIVED plan (and anything under it) cannot be modified (409).
 *   - Goals belong to a plan, programs to a goal, targets to a program —
 *     parentage is verified on every nested write.
 *
 * @typedef {{ repository: object, organizations: { getById:(id:string)=>Promise<{state:string}|null> }, clients: { findById:(t:string,id:string)=>Promise<any> }, staff: { findById:(t:string,id:string)=>Promise<any> } }} PlansDeps
 */
export class PlansService {
  /** @param {PlansDeps} deps */
  constructor(deps) {
    this.deps = deps;
  }

  async _assertActive(tenantId) {
    const org = await this.deps.organizations.getById(tenantId);
    if (!org || org.state !== 'ACTIVE') throw plansError('ORG_NOT_ACTIVE');
  }

  async _assertBcba(tenantId, staffId) {
    const staff = await this.deps.staff.findById(tenantId, staffId);
    if (!staff || staff.status !== 'ACTIVE') throw plansError('BCBA_INVALID');
  }

  /** Load a plan and refuse when it is missing or archived (the immutability guard). */
  async _requireMutablePlan(tenantId, planId) {
    const plan = await this.deps.repository.findPlanById(tenantId, planId);
    if (!plan) throw plansError('PLAN_NOT_FOUND');
    if (plan.status === 'ARCHIVED') throw plansError('PLAN_ARCHIVED');
    return plan;
  }

  async _requireProgramInPlan(tenantId, planId, programId) {
    const program = await this.deps.repository.findProgram(tenantId, planId, programId);
    if (!program) throw plansError('PROGRAM_NOT_FOUND');
    return program;
  }

  // --- treatment plans -----------------------------------------------------

  async createPlan({ tenantId, actorUserId, input }) {
    await this._assertActive(tenantId);
    const client = await this.deps.clients.findById(tenantId, input.clientId);
    if (!client || client.status !== 'ACTIVE') throw plansError('CLIENT_NOT_ACTIVE');
    // Responsible BCBA (spec Module 7.1): use the explicitly supplied one, else
    // derive it from the AUTHENTICATED creator's staff profile. The form no
    // longer asks for it — the current BCBA is the responsible clinician.
    let responsibleBcbaStaffId = input.responsibleBcbaStaffId;
    if (!responsibleBcbaStaffId) {
      const me = this.deps.staff.findByUserId
        ? await this.deps.staff.findByUserId(tenantId, actorUserId)
        : null;
      if (!me) throw plansError('BCBA_INVALID');
      responsibleBcbaStaffId = me.id;
    }
    await this._assertBcba(tenantId, responsibleBcbaStaffId);
    // AUTO-ACTIVATE (spec Part 1). A plan created through the normal BCBA
    // create flow is ACTIVE immediately — server-enforced, never trusting the
    // client. Whatever `status` the request carries (including "DRAFT") is
    // ignored here: the create endpoint does not produce a draft.
    //
    // ONE ACTIVE PLAN PER CHILD. There is no DB-level uniqueness on the active
    // plan, and downstream (sessions, RBT panel) reads "the child's ACTIVE
    // plan". Creating a second ACTIVE plan would leave two in that state, so
    // createActivePlan demotes any current ACTIVE plan for this child to DRAFT
    // in the SAME unit of work — a non-destructive supersede (no cascade
    // archive, fully reversible by re-activating). Historical DRAFT/ARCHIVED
    // plans are untouched (§3).
    return this.deps.repository.createActivePlan(tenantId, {
      clientId: input.clientId,
      title: input.title,
      responsibleBcbaStaffId,
      status: 'ACTIVE',
      ...(input.effectiveDate !== undefined ? { effectiveDate: new Date(input.effectiveDate) } : {}),
      ...(input.reviewDate !== undefined ? { reviewDate: new Date(input.reviewDate) } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      createdBy: actorUserId,
      updatedBy: actorUserId,
    }, actorUserId);
  }

  async getPlan({ tenantId, planId }) {
    const plan = await this.deps.repository.findPlanById(tenantId, planId);
    if (!plan) throw plansError('PLAN_NOT_FOUND');
    const goals = await this.deps.repository.listGoals(tenantId, planId);
    const goalsWithTree = await Promise.all(goals.map(async (goal) => {
      const programs = await this.deps.repository.listPrograms(tenantId, goal.id);
      const programsWithTargets = await Promise.all(programs.map(async (program) => ({
        ...program,
        targets: await this.deps.repository.listTargets(tenantId, program.id),
      })));
      return { ...goal, programs: programsWithTargets };
    }));
    // Resolve the plan's real relationships to human names so the detail page
    // never shows a raw id or a generic placeholder ("Child" / "Staff member").
    // Both ports are tenant-scoped (findById runs withTenant), so a plan in
    // tenant A can never resolve a child or BCBA from tenant B — cross-tenant
    // isolation holds. A missing or out-of-scope record resolves to null and the
    // UI shows an intentional fallback rather than an id.
    const [client, bcba] = await Promise.all([
      plan.clientId ? this.deps.clients.findById(tenantId, plan.clientId).catch(() => null) : null,
      plan.responsibleBcbaStaffId ? this.deps.staff.findById(tenantId, plan.responsibleBcbaStaffId).catch(() => null) : null,
    ]);
    const enrichedPlan = {
      ...plan,
      childName: personName(client),
      responsibleBcbaName: personName(bcba),
    };
    return { plan: enrichedPlan, goals: goalsWithTree };
  }

  /**
   * Minimal projection for the by-id scope guard: the client the plan belongs
   * to is what the caseload boundary is decided on.
   */
  async findPlanForScope({ tenantId, planId }) {
    const row = await this.deps.repository.findPlanById(tenantId, planId);
    if (!row) return null;
    return { clientId: row.clientId };
  }

  /**
   * The plan roster, enriched with the SAME display fields the detail page
   * already resolves — client name, responsible BCBA name, and the plan's goal
   * and program counts.
   *
   * These were missing from the list response, so the roster could only ever
   * render a plan's title, status and dates: `toPlan` returns `clientId` and
   * `responsibleBcbaStaffId`, never names, and no content counts at all. The
   * cards render each field conditionally, so nothing broke — those rows simply
   * never appeared.
   *
   * Everything is BATCHED, never per row:
   *   • ids are de-duplicated first, so one client with five plans is looked up
   *     once, not five times;
   *   • goal and program counts come from two grouped queries covering the whole
   *     page (see repository.countPlanContent).
   *
   * A page of 25 plans therefore costs a bounded handful of queries rather than
   * 25 × (client + BCBA + goals + programs).
   *
   * SCOPE IS UNCHANGED. The plan query still applies `dataScope`, and both
   * directory ports are tenant-scoped, so this only puts names on plans the
   * caller was already allowed to see. A record that is missing or out of scope
   * resolves to null and the field is simply omitted — never an id, never a
   * fabricated placeholder.
   */
  async listPlans({ tenantId, limit, cursor, clientId, status, dataScope }) {
    const page = await this.deps.repository.listPlans(tenantId, {
      ...(dataScope !== undefined ? { dataScope } : {}),
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(clientId !== undefined ? { clientId } : {}),
      ...(status !== undefined ? { status } : {}),
    });

    const items = page.items ?? [];
    if (items.length === 0) return page;

    const uniq = (vals) => [...new Set(vals.filter(Boolean))];
    const clientIds = uniq(items.map((p) => p.clientId));
    const staffIds = uniq(items.map((p) => p.responsibleBcbaStaffId));

    const [clients, staff, counts] = await Promise.all([
      Promise.all(clientIds.map((id) => this.deps.clients.findById(tenantId, id).catch(() => null))),
      Promise.all(staffIds.map((id) => this.deps.staff.findById(tenantId, id).catch(() => null))),
      this.deps.repository.countPlanContent
        ? this.deps.repository.countPlanContent(tenantId, items.map((p) => p.id)).catch(() => new Map())
        : new Map(),
    ]);

    const clientNameById = new Map(clientIds.map((id, i) => [id, personName(clients[i])]));
    const staffNameById = new Map(staffIds.map((id, i) => [id, personName(staff[i])]));

    return {
      ...page,
      items: items.map((p) => {
        const content = counts.get?.(p.id) ?? null;
        const clientName = clientNameById.get(p.clientId) ?? null;
        const bcbaName = staffNameById.get(p.responsibleBcbaStaffId) ?? null;
        return {
          ...p,
          // Only present when actually resolved, so the card omits the row
          // rather than rendering "Not available".
          ...(clientName ? { clientName } : {}),
          ...(bcbaName ? { bcbaName } : {}),
          ...(content ? { goalCount: content.goalCount, programCount: content.programCount } : {}),
        };
      }),
    };
  }

  async updatePlan({ tenantId, planId, actorUserId, expectedVersion, input }) {
    await this._assertActive(tenantId);
    const plan = await this._requireMutablePlan(tenantId, planId);
    if (input.responsibleBcbaStaffId !== undefined) await this._assertBcba(tenantId, input.responsibleBcbaStaffId);
    // Activation is a real lifecycle transition (spec Module 7.2), not a free
    // status set. From a mutable (non-ARCHIVED) plan only DRAFT<->ACTIVE are
    // valid; ARCHIVE has its own guarded endpoint. This prevents faking ACTIVE
    // or jumping to an unsupported state.
    if (input.status !== undefined && input.status !== plan.status) {
      const allowed = { DRAFT: ['ACTIVE'], ACTIVE: ['DRAFT'] };
      if (!(allowed[plan.status] ?? []).includes(input.status)) {
        throw plansError('PLAN_TRANSITION_INVALID', { context: { from: plan.status, to: input.status } });
      }
    }
    const patch = { updatedBy: actorUserId };
    for (const key of ['title', 'responsibleBcbaStaffId', 'status', 'notes']) {
      if (input[key] !== undefined) patch[key] = input[key];
    }
    if (input.effectiveDate !== undefined) patch.effectiveDate = new Date(input.effectiveDate);
    if (input.reviewDate !== undefined) patch.reviewDate = new Date(input.reviewDate);
    return this.deps.repository.updatePlan(tenantId, planId, patch, expectedVersion);
  }

  async archivePlan({ tenantId, planId, actorUserId }) {
    await this._assertActive(tenantId);
    const plan = await this.deps.repository.findPlanById(tenantId, planId);
    if (!plan) throw plansError('PLAN_NOT_FOUND');
    return this.deps.repository.archivePlan(tenantId, planId, actorUserId);
  }

  /**
   * Delete a treatment plan (soft-delete — the established removal lifecycle;
   * see repository.deletePlan). Mirrors archivePlan's shape: gated by the org
   * ACTIVE state and a real existence check before the repository cascade.
   * Unlike update, deletion is allowed on any non-deleted plan regardless of its
   * DRAFT/ACTIVE/ARCHIVED status — it is a terminal removal, not a mutation of a
   * live plan. Authorization (authenticated + tenant + plans.archive permission
   * + child/plan scope) is enforced upstream at the route (requirePermission +
   * planInScope); the planId is never trusted on its own.
   */
  async deletePlan({ tenantId, planId, actorUserId }) {
    await this._assertActive(tenantId);
    const plan = await this.deps.repository.findPlanById(tenantId, planId);
    if (!plan) throw plansError('PLAN_NOT_FOUND');
    return this.deps.repository.deletePlan(tenantId, planId, actorUserId);
  }

  // --- goals ---------------------------------------------------------------

  async addGoal({ tenantId, planId, actorUserId, input }) {
    await this._assertActive(tenantId);
    const plan = await this._requireMutablePlan(tenantId, planId);
    return this.deps.repository.addGoal(tenantId, planId, plan.clientId, { ...input, createdBy: actorUserId, updatedBy: actorUserId });
  }

  async updateGoal({ tenantId, planId, goalId, actorUserId, expectedVersion, input }) {
    await this._assertActive(tenantId);
    await this._requireMutablePlan(tenantId, planId);
    return this.deps.repository.updateGoal(tenantId, planId, goalId, { ...input, updatedBy: actorUserId }, expectedVersion);
  }

  async archiveGoal({ tenantId, planId, goalId, actorUserId }) {
    await this._assertActive(tenantId);
    await this._requireMutablePlan(tenantId, planId);
    return this.deps.repository.archiveGoal(tenantId, planId, goalId, actorUserId);
  }

  // --- programs ------------------------------------------------------------

  async addProgram({ tenantId, planId, goalId, actorUserId, input }) {
    await this._assertActive(tenantId);
    await this._requireMutablePlan(tenantId, planId);
    const goal = await this.deps.repository.listGoals(tenantId, planId).then((gs) => gs.find((g) => g.id === goalId));
    if (!goal) throw plansError('GOAL_NOT_FOUND');
    return this.deps.repository.addProgram(tenantId, planId, goalId, { ...input, createdBy: actorUserId, updatedBy: actorUserId });
  }

  async updateProgram({ tenantId, planId, programId, actorUserId, expectedVersion, input }) {
    await this._assertActive(tenantId);
    await this._requireMutablePlan(tenantId, planId);
    return this.deps.repository.updateProgram(tenantId, planId, programId, { ...input, updatedBy: actorUserId }, expectedVersion);
  }

  async archiveProgram({ tenantId, planId, programId, actorUserId }) {
    await this._assertActive(tenantId);
    await this._requireMutablePlan(tenantId, planId);
    return this.deps.repository.archiveProgram(tenantId, planId, programId, actorUserId);
  }

  // --- targets -------------------------------------------------------------

  async addTarget({ tenantId, planId, programId, actorUserId, input }) {
    await this._assertActive(tenantId);
    await this._requireMutablePlan(tenantId, planId);
    await this._requireProgramInPlan(tenantId, planId, programId);
    return this.deps.repository.addTarget(tenantId, planId, programId, { ...input, createdBy: actorUserId, updatedBy: actorUserId });
  }

  async updateTarget({ tenantId, planId, programId, targetId, actorUserId, expectedVersion, input }) {
    await this._assertActive(tenantId);
    await this._requireMutablePlan(tenantId, planId);
    await this._requireProgramInPlan(tenantId, planId, programId);
    return this.deps.repository.updateTarget(tenantId, programId, targetId, { ...input, updatedBy: actorUserId }, expectedVersion);
  }

  async archiveTarget({ tenantId, planId, programId, targetId, actorUserId }) {
    await this._assertActive(tenantId);
    await this._requireMutablePlan(tenantId, planId);
    await this._requireProgramInPlan(tenantId, planId, programId);
    return this.deps.repository.archiveTarget(tenantId, programId, targetId, actorUserId);
  }
}

/**
 * Build a human display name from a client or staff projection, or null when
 * there is nothing real to show. Never returns an id or a generic placeholder —
 * the caller decides the fallback copy.
 */
function personName(rec) {
  if (!rec) return null;
  const full = [rec.firstName, rec.lastName].filter(Boolean).join(' ').trim();
  return full || rec.displayName || rec.preferredName || null;
}
