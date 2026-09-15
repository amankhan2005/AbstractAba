import { unitsToHours } from '../../domain/units.js';
import { clientsError } from './clients.errors.js';
import { INTAKE_WORKFLOW_TRANSITIONS, SERVICE_AUTH_TRANSITIONS } from '../../models/enums.js';
import { computeChildAlerts, alertsSummary, isValidParent, deriveAccountStatus } from './clients.alerts.js';
import { isUsableServiceAuthorization } from '../scheduling/authAdapter.js';
import { getParentEmailTemplate, renderParentEmail, PARENT_EMAIL_TEMPLATES, SUPPORTED_EMAIL_VARIABLES } from './parent-email.templates.js';
import { appendCompanyFooter } from './company-footer.js';
import { formatPersonName, formatDate } from '../../utils/format.js';
import { applyClientDetailVisibility, resolveViewer, redactCareTeam } from './clients.visibility.js';

/**
 * Where an ACTIVE client goes when it loses its last valid parent (spec Module 2
 * Part 15/20). ON_HOLD is a real, reversible CLIENT_STATUS — the record stays,
 * all child data is preserved, and it can return to ACTIVE once a valid parent is
 * added again. Never a fabricated status, never a delete.
 */
const PARENTLESS_DEMOTION_STATUS = 'ON_HOLD';

/**
 * Clients module business rules. The repository holds data access; the
 * organization port answers "is this tenant ACTIVE?"; the phi port seals and
 * opens the sealed PHI envelope. Dependencies are injected so the whole service
 * is exercised without a database.
 *
 * Two guarantees run through every write:
 *   1. ACTIVE gate — clinical records may only be written while the organization
 *      is ACTIVE (mayStoreClinicalData). A write against any other state is a
 *      409, structurally enforced here rather than left to each caller.
 *   2. PHI containment — sensitive identifiers are sealed before they reach the
 *      repository and opened only when a detail view returns to an authorised
 *      caller. They never appear in list responses.
 *
 * @typedef {{ repository: object, organizations: { getById: (id:string)=>Promise<{state:string}|null> }, phi: { seal:(v:any)=>any, open:(v:any)=>any } }} ClientsDeps
 */
export class ClientsService {
  /** @param {ClientsDeps} deps */
  constructor(deps) {
    this.deps = deps;
  }

  async _assertActive(tenantId) {
    const org = await this.deps.organizations.getById(tenantId);
    if (!org || org.state !== 'ACTIVE') throw clientsError('ORG_NOT_ACTIVE');
  }

  // --- clients --------------------------------------------------------------

  async createClient({ tenantId, actorUserId, input }) {
    await this._assertActive(tenantId);
    // Activation rule (spec Module 2 Parts 10/11): a client may only be ACTIVE
    // when at least one VALID parent exists. On create there are no guardians yet,
    // so requesting ACTIVE up front is refused with a friendly, actionable error.
    if (input.status === 'ACTIVE') {
      throw clientsError('CLIENT_ACTIVATION_REQUIRES_PARENT');
    }
    const doc = {
      firstName: input.firstName,
      lastName: input.lastName,
      ...optional('middleName', input.middleName),
      ...optional('preferredName', input.preferredName),
      ...optional('sexAtBirth', input.sexAtBirth),
      ...optional('pronouns', input.pronouns),
      ...optional('status', input.status),
      ...optional('approvedWeeklyHours', input.approvedWeeklyHours),
      ...optional('primaryLanguage', input.primaryLanguage),
      ...optional('email', input.email),
      ...optional('phone', input.phone),
      ...optional('address', input.address),
      ...(input.dateOfBirth !== undefined ? { dateOfBirth: new Date(input.dateOfBirth) } : {}),
      sensitive: { ssn: input.ssn !== undefined ? this.deps.phi.seal(input.ssn) : null },
      createdBy: actorUserId,
      updatedBy: actorUserId,
    };
    const created = await this.deps.repository.createClient(tenantId, doc);
    return this._present(created);
  }

  async getClient({ tenantId, clientId, viewer }) {
    const client = await this.deps.repository.findClientById(tenantId, clientId);
    if (!client) throw clientsError('CLIENT_NOT_FOUND');
    const [guardians, contacts, intake, careTeam, serviceAuthorizations, medical] = await Promise.all([
      this.deps.repository.listGuardians(tenantId, clientId),
      this.deps.repository.listContacts(tenantId, clientId),
      this.deps.repository.findIntake(tenantId, clientId),
      this.deps.repository.listAssignments(tenantId, clientId),
      this.deps.repository.listServiceAuthorizations(tenantId, clientId),
      this.deps.repository.listMedicalEntries(tenantId, clientId),
    ]);
    // Field-level role-based serialization happens on the SERVER (Parts 8/27/29):
    // compensation and guardian private contact are stripped for clinical roles
    // here, never fetched to the browser to be hidden.
    return applyClientDetailVisibility({
      // Account status is derived from the same rule as the list (never stored).
      client: { ...this._present(client), accountStatus: deriveAccountStatus({ status: client.status, hasValidParent: (guardians ?? []).some(isValidParent) }) },
      guardians,
      contacts,
      intake: intake ? this._presentIntake(intake) : null,
      careTeam,
      serviceAuthorizations,
      medical,
    }, viewer);
  }

  /** Roster summary (total, account status, referral stage) within the caller's scope. */
  async summarizeClients({ tenantId, clientIds }) {
    return this.deps.repository.summarizeClients(tenantId, { ...(clientIds !== undefined ? { clientIds } : {}) });
  }

  async listClients({ tenantId, limit, cursor, status, accountStatus, search, clientIds }) {
    return this.deps.repository.listClients(tenantId, {
      ...(accountStatus !== undefined ? { accountStatus } : {}),
      ...(clientIds !== undefined ? { clientIds } : {}),
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(search !== undefined ? { search } : {}),
    });
  }

  async updateClient({ tenantId, clientId, actorUserId, expectedVersion, input }) {
    await this._assertActive(tenantId);
    // Activation rule (spec Module 2 Parts 10/11): promoting a client to ACTIVE
    // requires at least one VALID parent (name + mobile + email) belonging to this
    // client+tenant. Enforced on the SERVER — the browser-supplied status is never
    // trusted. Other status changes are unaffected.
    if (input.status === 'ACTIVE') {
      await this._requireClient(tenantId, clientId);
      if (!(await this._hasValidParent(tenantId, clientId))) {
        throw clientsError('CLIENT_ACTIVATION_REQUIRES_PARENT');
      }
    }
    const patch = { updatedBy: actorUserId };
    for (const key of ['firstName', 'lastName', 'middleName', 'preferredName', 'sexAtBirth', 'pronouns', 'status', 'primaryLanguage', 'email', 'phone', 'address', 'approvedWeeklyHours']) {
      if (input[key] !== undefined) patch[key] = input[key];
    }
    if (input.dateOfBirth !== undefined) patch.dateOfBirth = new Date(input.dateOfBirth);
    if (input.ssn !== undefined) patch['sensitive.ssn'] = this.deps.phi.seal(input.ssn);
    const updated = await this.deps.repository.updateClient(tenantId, clientId, patch, expectedVersion);
    return this._present(updated);
  }

  async archiveClient({ tenantId, clientId, actorUserId }) {
    await this._assertActive(tenantId);
    return this.deps.repository.archiveClient(tenantId, clientId, actorUserId);
  }

  // --- guardians ------------------------------------------------------------

  async addGuardian({ tenantId, clientId, actorUserId, input }) {
    await this._assertActive(tenantId);
    await this._requireClient(tenantId, clientId);
    // No duplicate guardian records: re-submitting the SAME person for this
    // client (a retried intake step, a double click) returns the existing
    // guardian instead of creating a second one. Different people — even ones
    // sharing a family email — are still separate guardians.
    const existing = (await this.deps.repository.listGuardians(tenantId, clientId)) ?? [];
    const same = existing.find((g) => ClientsService.sameGuardian(g, input));
    if (same) return same;
    return this.deps.repository.addGuardian(tenantId, clientId, { ...input, createdBy: actorUserId, updatedBy: actorUserId });
  }

  /** Same person: first + last name, email (case-insensitive) and phone digits all match. */
  static sameGuardian(a, b) {
    const text = (v) => (v == null ? '' : String(v).trim().toLowerCase());
    const digits = (v) => (v == null ? '' : String(v).replace(/\D/g, ''));
    return text(a?.firstName) === text(b?.firstName)
      && text(a?.lastName) === text(b?.lastName)
      && text(a?.email) === text(b?.email)
      && digits(a?.phone) === digits(b?.phone);
  }

  async updateGuardian({ tenantId, clientId, guardianId, actorUserId, input }) {
    await this._assertActive(tenantId);
    const result = await this.deps.repository.updateGuardian(tenantId, clientId, guardianId, { ...input, updatedBy: actorUserId });
    // An edit can invalidate the last valid parent (e.g. clearing the email), so
    // re-check the activation invariant (spec Module 2 Part 15/20).
    await this._enforceParentActivationInvariant({ tenantId, clientId, actorUserId });
    return result;
  }

  async removeGuardian({ tenantId, clientId, guardianId, actorUserId }) {
    await this._assertActive(tenantId);
    const result = await this.deps.repository.removeGuardian(tenantId, clientId, guardianId, actorUserId);
    // Removing the last valid parent must not leave an ACTIVE client parent-less
    // (spec Module 2 Part 15/20): demote to ON_HOLD. The client is never deleted
    // and no child data is destroyed — the record simply leaves ACTIVE until a
    // valid parent is restored.
    await this._enforceParentActivationInvariant({ tenantId, clientId, actorUserId });
    return result;
  }

  /**
   * A VALID parent (spec Module 2 Part 9) is a guardian with a name AND a mobile
   * number AND an email. Empty/partial guardians do not satisfy activation.
   */
  static isValidParent(g) {
    return isValidParent(g);
  }

  /** True when the client has at least one valid parent in this tenant. */
  async _hasValidParent(tenantId, clientId) {
    const guardians = await this.deps.repository.listGuardians(tenantId, clientId);
    return (guardians ?? []).some((g) => ClientsService.isValidParent(g));
  }

  /**
   * Keep the client status consistent with the parent rule after a guardian
   * change. If an ACTIVE client no longer has any valid parent, demote it to
   * ON_HOLD (a real, reversible CLIENT_STATUS — never a fabricated state, never a
   * delete). No-op for clients that are not ACTIVE.
   */
  async _enforceParentActivationInvariant({ tenantId, clientId, actorUserId }) {
    const client = await this.deps.repository.findClientById(tenantId, clientId);
    if (!client || client.status !== 'ACTIVE') return null;
    if (await this._hasValidParent(tenantId, clientId)) return null;
    return this.deps.repository.updateClient(
      tenantId, clientId,
      { status: PARENTLESS_DEMOTION_STATUS, updatedBy: actorUserId },
      client.version,
    );
  }

  // --- medical entries (conditions + history) -------------------------------
  // Company/Admin owns writes (route gate clients.medical.manage); clinicians
  // read via getClient (scoped + field-filtered). Persisted through the real
  // repository/DB — no local-only state, no second medical model.

  async listMedical({ tenantId, clientId, type }) {
    await this._requireClient(tenantId, clientId);
    return this.deps.repository.listMedicalEntries(tenantId, clientId, type);
  }

  async addMedical({ tenantId, clientId, actorUserId, input }) {
    await this._assertActive(tenantId);
    await this._requireClient(tenantId, clientId);
    const attachments = await this._validateAttachments(tenantId, clientId, input.attachmentDocumentIds);
    const { attachmentDocumentIds, ...rest } = input;
    return this.deps.repository.addMedicalEntry(tenantId, clientId, { ...rest, attachments, createdBy: actorUserId, updatedBy: actorUserId });
  }

  async updateMedical({ tenantId, clientId, entryId, actorUserId, input }) {
    await this._assertActive(tenantId);
    await this._requireClient(tenantId, clientId);
    const { attachmentDocumentIds, ...rest } = input;
    const patch = { ...rest, updatedBy: actorUserId };
    if (attachmentDocumentIds !== undefined) {
      patch.attachments = await this._validateAttachments(tenantId, clientId, attachmentDocumentIds);
    }
    return this.deps.repository.updateMedicalEntry(tenantId, clientId, entryId, patch);
  }

  /** Attachments must be existing documents for THIS client+tenant (reuses the
   *  documents system). Rejects unknown/cross-child/cross-tenant ids. */
  async _validateAttachments(tenantId, clientId, ids) {
    if (ids === undefined || ids === null) return [];
    const bad = await this.deps.repository.invalidAttachmentIds(tenantId, clientId, ids);
    if (bad.length > 0) throw clientsError('MEDICAL_ATTACHMENT_INVALID');
    return [...new Set(ids)];
  }

  async removeMedical({ tenantId, clientId, entryId }) {
    await this._assertActive(tenantId);
    await this._requireClient(tenantId, clientId);
    return this.deps.repository.removeMedicalEntry(tenantId, clientId, entryId);
  }

  // --- contacts -------------------------------------------------------------

  // --- care team (persistent staff assignment) ------------------------------

  async listCareTeam({ tenantId, clientId, viewer }) {
    // Ensure the client exists (and is in-tenant) before returning its team.
    await this._requireClient(tenantId, clientId);
    const assignments = await this.deps.repository.listAssignments(tenantId, clientId);
    return redactCareTeam(assignments, resolveViewer(viewer));
  }

  async assignCareTeam({ tenantId, clientId, actorUserId, input }) {
    await this._assertActive(tenantId);
    const client = await this._requireClient(tenantId, clientId);
    const staff = await this.deps.repository.findStaffProfile(tenantId, input.staffProfileId);
    if (!staff) throw clientsError('STAFF_NOT_FOUND');
    if (staff.status !== 'ACTIVE') throw clientsError('STAFF_INACTIVE');
    // Role eligibility: a BCBA/RBT assignment must match the staff discipline
    // when the discipline is recorded (BR-ASSIGN-role). MANAGER/THERAPIST are
    // not discipline-gated. The backend is authoritative regardless of the UI.
    this._assertRoleEligible(input.role, staff);
    this._assertHoursAndRate(input);
    // One active BCBA and one active RBT per client (BR-CARE-ONE-PER-ROLE).
    // A replacement must END the current assignment first (history preserved);
    // this never silently supersedes. MANAGER/THERAPIST roles are not limited.
    if (input.role === 'BCBA' || input.role === 'RBT') {
      const assignments = await this.deps.repository.listAssignments(tenantId, clientId);
      const hasActiveSameRole = (assignments ?? []).some(
        (a) => a.role === input.role && (a.status ?? 'ACTIVE') === 'ACTIVE',
      );
      if (hasActiveSameRole) {
        throw clientsError(input.role === 'BCBA' ? 'CLIENT_ALREADY_HAS_BCBA' : 'CLIENT_ALREADY_HAS_RBT');
      }
    }
    if (input.effectiveStartDate && input.effectiveEndDate && new Date(input.effectiveEndDate) < new Date(input.effectiveStartDate)) {
      throw clientsError('ASSIGNMENT_DATES_INVALID');
    }
    // Capacity: the sum of ACTIVE assigned weekly hours may not exceed the
    // child's approved weekly hours (when both are set).
    if (input.weeklyAssignedHours != null && client.approvedWeeklyHours != null) {
      const already = await this.deps.repository.sumActiveAssignedHours(tenantId, clientId);
      if (already + input.weeklyAssignedHours > client.approvedWeeklyHours) {
        throw clientsError('ASSIGNMENT_OVER_CAPACITY', { context: { approved: client.approvedWeeklyHours, alreadyAssigned: already, requested: input.weeklyAssignedHours } });
      }
    }
    // Compensation is NOT part of a care-team assignment (spec Module 1/4). A new
    // assignment carries no pay rate; the staff PayRate model is the single source
    // of pay truth and payroll resolves the rate from there by service date. The
    // legacy hourlyPayRate/rateHistory columns are left at their defaults (null/[])
    // so historical rows remain readable without a second write path.
    return this.deps.repository.addAssignment(tenantId, clientId, {
      staffProfileId: input.staffProfileId,
      role: input.role,
      isPrimary: input.isPrimary ?? false,
      weeklyAssignedHours: input.weeklyAssignedHours ?? null,
      hourlyPayRate: null,
      effectiveStartDate: input.effectiveStartDate ? new Date(input.effectiveStartDate) : null,
      effectiveEndDate: input.effectiveEndDate ? new Date(input.effectiveEndDate) : null,
      status: 'ACTIVE',
      rateHistory: [],
      notes: input.notes ?? null,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });
  }

  /**
   * Edit an assignment. A changed pay rate APPENDS to rateHistory (never
   * rewrites) so past payroll resolves by service date. Capacity is re-checked
   * against the child's approved hours, excluding this row.
   */
  async updateAssignment({ tenantId, clientId, assignmentId, actorUserId, input }) {
    await this._assertActive(tenantId);
    const client = await this._requireClient(tenantId, clientId);
    const assignment = await this.deps.repository.findAssignmentById(tenantId, assignmentId);
    if (!assignment || assignment.clientId !== clientId) throw clientsError('ASSIGNMENT_NOT_FOUND');
    this._assertHoursAndRate(input);
    const patch = { updatedBy: actorUserId };
    if (input.weeklyAssignedHours !== undefined) {
      if (input.weeklyAssignedHours != null && client.approvedWeeklyHours != null) {
        const others = await this.deps.repository.sumActiveAssignedHours(tenantId, clientId, assignmentId);
        if (others + input.weeklyAssignedHours > client.approvedWeeklyHours) {
          throw clientsError('ASSIGNMENT_OVER_CAPACITY', { context: { approved: client.approvedWeeklyHours, alreadyAssigned: others, requested: input.weeklyAssignedHours } });
        }
      }
      patch.weeklyAssignedHours = input.weeklyAssignedHours;
    }
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.effectiveEndDate !== undefined) patch.effectiveEndDate = input.effectiveEndDate ? new Date(input.effectiveEndDate) : null;
    // Pay rate is never edited through a care-team assignment (spec Module 1/4):
    // the schema rejects hourlyPayRate, so there is nothing to append here. Rate
    // changes flow through the staff PayRate model only.
    return this.deps.repository.updateAssignment(tenantId, assignmentId, patch, null);
  }

  /** End an assignment (soft — status ENDED + end date). History is preserved. */
  async endAssignment({ tenantId, clientId, assignmentId, actorUserId, effectiveEndDate }) {
    await this._assertActive(tenantId);
    await this._requireClient(tenantId, clientId);
    const assignment = await this.deps.repository.findAssignmentById(tenantId, assignmentId);
    if (!assignment || assignment.clientId !== clientId) throw clientsError('ASSIGNMENT_NOT_FOUND');
    return this.deps.repository.updateAssignment(tenantId, assignmentId, {
      status: 'ENDED',
      effectiveEndDate: effectiveEndDate ? new Date(effectiveEndDate) : new Date(),
      updatedBy: actorUserId,
    }, null);
  }

  /**
   * Role eligibility for a BCBA/RBT care-team seat. Role truth is CANONICAL: the
   * staff member's RBAC roleKeys (spec Module 4 Parts 8/12) decide eligibility.
   * A member is eligible for a BCBA seat iff they hold the `bcba` role key, and
   * for an RBT seat iff they hold `rbt`. When roleKeys are unavailable (a legacy
   * StaffProfile with no resolvable membership), we fall back to the historical
   * free-text `discipline` so old data keeps working — but roleKeys win whenever
   * present. MANAGER seats are not discipline/role-gated here.
   */
  _assertRoleEligible(role, staff) {
    if (role !== 'BCBA' && role !== 'RBT') return;
    const roleKeys = Array.isArray(staff?.roleKeys) ? staff.roleKeys.map((k) => String(k).toLowerCase()) : [];
    if (roleKeys.length > 0) {
      if (!roleKeys.includes(role.toLowerCase())) {
        throw clientsError('ASSIGNMENT_ROLE_INELIGIBLE', { context: { role, roleKeys } });
      }
      return;
    }
    const discipline = staff?.discipline;
    if (discipline && discipline.toUpperCase() !== role) {
      throw clientsError('ASSIGNMENT_ROLE_INELIGIBLE', { context: { role, discipline } });
    }
  }

  _assertHoursAndRate(input) {
    if (input.weeklyAssignedHours != null && (input.weeklyAssignedHours < 0 || input.weeklyAssignedHours > 168)) {
      throw clientsError('ASSIGNMENT_HOURS_INVALID');
    }
  }

  /**
   * Resolve the pay rate applicable to a service/work date (Phase 4 payroll
   * hook). Picks the rateHistory entry with the latest effectiveDate on or
   * before `date`; falls back to the current hourlyPayRate. Never uses "today"
   * blindly — a Mar-20 session uses the rate effective on Mar 20, not the newest.
   */
  static resolveRateOnDate(assignment, date) {
    if (!assignment) return null;
    const target = new Date(date).getTime();
    const history = Array.isArray(assignment.rateHistory) ? assignment.rateHistory : [];
    const eligible = history
      .filter((r) => new Date(r.effectiveDate).getTime() <= target)
      .sort((a, b) => new Date(b.effectiveDate) - new Date(a.effectiveDate));
    if (eligible.length > 0) return eligible[0].rate;
    return assignment.hourlyPayRate ?? null;
  }

  async removeCareTeam({ tenantId, clientId, assignmentId, actorUserId }) {
    await this._assertActive(tenantId);
    await this._requireClient(tenantId, clientId);
    return this.deps.repository.removeAssignment(tenantId, clientId, assignmentId, actorUserId);
  }

  /**
   * Downstream port for billing/payroll: the standing care-team role(s) a staff
   * member holds for a client. Callers (claim/payroll enrichment, reporting) can
   * attribute a session's staff to their assigned role without changing the
   * per-appointment assignment that governs the actual delivered work.
   */
  async rolesForStaffOnClient({ tenantId, clientId, staffProfileId }) {
    return this.deps.repository.rolesForStaffOnClient(tenantId, clientId, staffProfileId);
  }

  async addContact({ tenantId, clientId, actorUserId, input }) {
    await this._assertActive(tenantId);
    await this._requireClient(tenantId, clientId);
    return this.deps.repository.addContact(tenantId, clientId, { ...input, createdBy: actorUserId, updatedBy: actorUserId });
  }

  async updateContact({ tenantId, clientId, contactId, actorUserId, input }) {
    await this._assertActive(tenantId);
    return this.deps.repository.updateContact(tenantId, clientId, contactId, { ...input, updatedBy: actorUserId });
  }

  async removeContact({ tenantId, clientId, contactId, actorUserId }) {
    await this._assertActive(tenantId);
    return this.deps.repository.removeContact(tenantId, clientId, contactId, actorUserId);
  }

  // --- intake ---------------------------------------------------------------

  async upsertIntake({ tenantId, clientId, actorUserId, input }) {
    await this._assertActive(tenantId);
    await this._requireClient(tenantId, clientId);
    const patch = { updatedBy: actorUserId };
    for (const key of ['referralSource', 'presentingConcerns', 'status']) {
      if (input[key] !== undefined) patch[key] = input[key];
    }
    if (input.referralDate !== undefined) patch.referralDate = new Date(input.referralDate);
    if (input.insurance !== undefined) {
      if (input.insurance.payerName !== undefined) patch['insurance.payerName'] = input.insurance.payerName;
      if (input.insurance.planName !== undefined) patch['insurance.planName'] = input.insurance.planName;
      if (input.insurance.memberId !== undefined) patch['insurance.memberId'] = this.deps.phi.seal(input.insurance.memberId);
    }
    if (input.consents !== undefined) {
      if (input.consents.hipaaAcknowledged !== undefined) patch['consents.hipaaAcknowledged'] = input.consents.hipaaAcknowledged;
      if (input.consents.treatmentConsent !== undefined) patch['consents.treatmentConsent'] = input.consents.treatmentConsent;
      patch['consents.consentedAt'] = new Date();
    }
    const intake = await this.deps.repository.upsertIntake(tenantId, clientId, patch);
    return this._presentIntake(intake);
  }

  // --- internals ------------------------------------------------------------

  async _requireClient(tenantId, clientId) {
    const client = await this.deps.repository.findClientById(tenantId, clientId);
    if (!client) throw clientsError('CLIENT_NOT_FOUND');
    return client;
  }

  /** Open the sealed PHI envelope for an authorised detail response. */
  /**
   * Move a child's intake pipeline to `target`, but only if the transition is
   * allowed from the current state (BR-INTAKE-1). Invalid jumps are rejected so
   * the pipeline can't be forged (e.g. NOT_SENT -> COMPLETE). Persists the new
   * state and returns the presented client.
   */
  async transitionIntakeWorkflow({ tenantId, clientId, actorUserId, target, expectedVersion }) {
    await this._assertActive(tenantId);
    const client = await this.deps.repository.findClientById(tenantId, clientId);
    if (!client) throw clientsError('CLIENT_NOT_FOUND');
    const current = client.intakeWorkflowStatus ?? 'NOT_SENT';
    if (current === target) return this._present(client);
    const allowed = INTAKE_WORKFLOW_TRANSITIONS[current] ?? [];
    if (!allowed.includes(target)) {
      throw clientsError('INTAKE_TRANSITION_INVALID', { from: current, to: target });
    }
    const updated = await this.deps.repository.updateClient(
      tenantId,
      clientId,
      { intakeWorkflowStatus: target, updatedBy: actorUserId },
      expectedVersion,
    );
    return this._present(updated);
  }

  // --- FBA/ABA service authorizations (Phase 2) ----------------------------

  /** True iff `date` falls within [startDate, endDate] of a usable (saved, not
   *  denied) auth. Reusable by scheduling/billing so they never use today's
   *  date blindly. */
  static isAuthorizationActiveOn(auth, date) {
    if (!isUsableServiceAuthorization(auth)) return false;
    const t = new Date(date).getTime();
    const start = auth.startDate ? new Date(auth.startDate).getTime() : -Infinity;
    const end = auth.endDate ? new Date(auth.endDate).getTime() : Infinity;
    return t >= start && t <= end;
  }

  async listServiceAuthorizations({ tenantId, clientId }) {
    await this._assertClientExists(tenantId, clientId);
    return this.deps.repository.listServiceAuthorizations(tenantId, clientId);
  }

  async createServiceAuthorization({ tenantId, clientId, actorUserId, input }) {
    await this._assertActive(tenantId);
    await this._assertClientExists(tenantId, clientId);
    // Parent prerequisite: like insurance, a new authorization is recorded only
    // once the client has a VALID parent/guardian (the rule that gates
    // activation). Editing an existing authorization is not gated.
    if (!(await this._hasValidParent(tenantId, clientId))) throw clientsError('PARENT_DETAILS_REQUIRED');
    if (input.startDate && input.endDate && new Date(input.endDate) < new Date(input.startDate)) {
      throw clientsError('AUTHORIZATION_DATES_INVALID');
    }
    // Multiple ABA/FBA authorizations per child are allowed (spec: multiple valid
    // authorization periods). The only duplicate we reject is a repeated
    // authorization NUMBER for the same child — the real business identity.
    if (input.authorizationNumber) {
      const dupe = await this.deps.repository.findServiceAuthorizationByNumber(
        tenantId, clientId, input.authorizationNumber,
      );
      if (dupe) throw clientsError('AUTHORIZATION_EXISTS', { context: { authorizationNumber: input.authorizationNumber } });
    }
    const doc = {
      clientId,
      serviceType: input.serviceType,
      status: 'NOT_SENT',
      authorizationNumber: input.authorizationNumber ?? null,
      billingCode: input.billingCode ?? null,
      startDate: input.startDate ? new Date(input.startDate) : null,
      endDate: input.endDate ? new Date(input.endDate) : null,
      units: input.units ?? null,
      // Hours are derived from units (1 unit = 15 min) so the stored value can
      // never conflict with units (spec Module 6 Part 9). Client-supplied hours
      // are ignored when units are present.
      hours: input.units != null ? unitsToHours(input.units) : (input.hours ?? null),
      unitPrice: input.unitPrice ?? null,
      comments: input.comments ?? null,
      history: [],
      createdBy: actorUserId,
      updatedBy: actorUserId,
    };
    return this.deps.repository.createServiceAuthorization(tenantId, doc);
  }

  async updateServiceAuthorization({ tenantId, clientId, authorizationId, actorUserId, input }) {
    await this._assertActive(tenantId);
    const auth = await this.deps.repository.findServiceAuthorizationById(tenantId, authorizationId);
    if (!auth || auth.clientId !== clientId) throw clientsError('AUTHORIZATION_NOT_FOUND');
    const startDate = input.startDate !== undefined ? input.startDate : auth.startDate;
    const endDate = input.endDate !== undefined ? input.endDate : auth.endDate;
    if (startDate && endDate && new Date(endDate) < new Date(startDate)) {
      throw clientsError('AUTHORIZATION_DATES_INVALID');
    }
    const patch = { updatedBy: actorUserId };
    for (const k of ['authorizationNumber', 'billingCode', 'units', 'hours', 'unitPrice', 'comments']) {
      if (input[k] !== undefined) patch[k] = input[k];
    }
    // Keep hours consistent with units (spec Module 6 Part 9): whenever units are
    // being set, derive hours from them and ignore any client-supplied hours.
    if (input.units !== undefined && input.units !== null) patch.hours = unitsToHours(input.units);
    if (input.startDate !== undefined) patch.startDate = input.startDate ? new Date(input.startDate) : null;
    if (input.endDate !== undefined) patch.endDate = input.endDate ? new Date(input.endDate) : null;
    return this.deps.repository.updateServiceAuthorization(tenantId, authorizationId, patch, null);
  }

  /** Guarded status transition. Invalid jumps throw and write nothing — no
   *  history, no partial persist. Valid ones append an append-only history row. */
  async transitionServiceAuthorization({ tenantId, clientId, authorizationId, actorUserId, target, reason }) {
    await this._assertActive(tenantId);
    const auth = await this.deps.repository.findServiceAuthorizationById(tenantId, authorizationId);
    if (!auth || auth.clientId !== clientId) throw clientsError('AUTHORIZATION_NOT_FOUND');
    const allowed = SERVICE_AUTH_TRANSITIONS[auth.status] ?? [];
    if (!allowed.includes(target)) {
      throw clientsError('AUTHORIZATION_TRANSITION_INVALID', { context: { from: auth.status, to: target, serviceType: auth.serviceType } });
    }
    if (target === 'DENIED' && !reason) throw clientsError('AUTHORIZATION_DENY_REASON_REQUIRED');
    const historyEntry = { from: auth.status, to: target, actorUserId, reason: reason ?? null, at: new Date() };
    return this.deps.repository.updateServiceAuthorization(
      tenantId,
      authorizationId,
      { status: target, updatedBy: actorUserId },
      historyEntry,
    );
  }

  /**
   * Archive a single authorization (soft-delete, spec Fix 1). Verifies it belongs
   * to this child + tenant before removing it; other authorizations for the child
   * are untouched and history is retained (never hard-deleted).
   */
  async archiveServiceAuthorization({ tenantId, clientId, authorizationId, actorUserId }) {
    await this._assertActive(tenantId);
    const auth = await this.deps.repository.findServiceAuthorizationById(tenantId, authorizationId);
    if (!auth || auth.clientId !== clientId) throw clientsError('AUTHORIZATION_NOT_FOUND');
    return this.deps.repository.softDeleteServiceAuthorization(tenantId, authorizationId, actorUserId);
  }

  async _assertClientExists(tenantId, clientId) {
    const client = await this.deps.repository.findClientById(tenantId, clientId);
    if (!client) throw clientsError('CLIENT_NOT_FOUND');
    return client;
  }

  async getChildAlerts({ tenantId, clientId }) {
    const client = await this.deps.repository.findClientById(tenantId, clientId);
    if (!client) throw clientsError('CLIENT_NOT_FOUND');
    const [careTeam, serviceAuthorizations, assignedWeeklyHours, guardians] = await Promise.all([
      this.deps.repository.listAssignments(tenantId, clientId),
      this.deps.repository.listServiceAuthorizations(tenantId, clientId),
      this.deps.repository.sumActiveAssignedHours(tenantId, clientId),
      this.deps.repository.listGuardians(tenantId, clientId),
    ]);
    const alerts = computeChildAlerts({
      guardians: guardians ?? [],
      intakeWorkflowStatus: client.intakeWorkflowStatus ?? 'NOT_SENT',
      approvedWeeklyHours: client.approvedWeeklyHours ?? null,
      assignedWeeklyHours,
      careTeam,
      serviceAuthorizations,
    });
    return { alerts, summary: alertsSummary(alerts) };
  }

  async getChildProgress({ tenantId, clientId }) {
    const client = await this.deps.repository.findClientById(tenantId, clientId);
    if (!client) throw clientsError('CLIENT_NOT_FOUND');
    const goals = await this.deps.repository.listGoalsForClient(tenantId, clientId);
    const withProgress = goals.filter((g) => typeof g.progress === 'number');
    const averageProgress = withProgress.length
      ? Math.round(withProgress.reduce((s, g) => s + g.progress, 0) / withProgress.length)
      : null;
    const byStatus = goals.reduce((acc, g) => { acc[g.status] = (acc[g.status] ?? 0) + 1; return acc; }, {});
    return { goals, totalGoals: goals.length, metGoals: byStatus.MET ?? 0, inProgressGoals: byStatus.IN_PROGRESS ?? 0, averageProgress, byStatus };
  }

  /**
   * Send an admin-authored message to a child's care team through the existing
   * notification framework (in-app record + email channel via the shared Resend
   * transport). Recipients are re-resolved server-side from the CURRENT active
   * assignment — the client's memberIds only NARROW that set, never widen it, and
   * a sender/recipient email is never accepted from the client. Returns who was
   * notified. No provider send is faked: the notification job carries the real
   * delivery through the existing transport.
   */
  async messageCareTeam({ tenantId, clientId, actorUserId, memberIds, subject, message }) {
    await this._assertActive(tenantId);
    const client = await this._requireClient(tenantId, clientId);
    const recipients = await this.deps.repository.listCareTeamRecipients(tenantId, clientId);
    if (recipients.length === 0) throw clientsError('CARE_TEAM_EMPTY');
    // memberIds (assignmentIds) may only narrow the authoritative set.
    const selected = Array.isArray(memberIds) && memberIds.length
      ? recipients.filter((r) => memberIds.includes(r.assignmentId))
      : recipients;
    if (selected.length === 0) throw clientsError('CARE_TEAM_NO_RECIPIENTS');
    const recipientUserIds = [...new Set(selected.map((r) => r.userId))];
    if (!this.deps.notifications || typeof this.deps.notifications.dispatch !== 'function') {
      throw clientsError('COMMUNICATION_UNAVAILABLE');
    }
    const childName = [client.firstName, client.lastName].filter(Boolean).join(' ') || 'a child';
    await this.deps.notifications.dispatch('care_team.message', {
      tenantId,
      recipientUserIds,
      actorUserId,
      content: {
        subject: subject && subject.trim() ? subject.trim() : `Message about ${childName}`,
        inAppBody: message,
        link: `/clients/${clientId}`,
      },
    });
    return {
      notified: selected.map((r) => ({ assignmentId: r.assignmentId, role: r.role, staffName: r.staffName })),
      recipientCount: recipientUserIds.length,
    };
  }

  listParentEmailTemplates() {
    return PARENT_EMAIL_TEMPLATES.map((t) => ({ id: t.id, name: t.name, category: t.category, description: t.description, subject: t.subject, body: t.body, supportedVariables: SUPPORTED_EMAIL_VARIABLES }));
  }

  /**
   * The template a preview/send is based on: a platform catalog template, or one
   * of this company's saved templates (tenant-scoped lookup). Unknown ids — or
   * another company's template — are EMAIL_TEMPLATE_NOT_FOUND.
   */
  async _resolveEmailTemplate(tenantId, templateId) {
    const catalog = getParentEmailTemplate(templateId);
    if (catalog) return catalog;
    const saved = this.deps.emailTemplates?.findById ? await this.deps.emailTemplates.findById(tenantId, templateId) : null;
    if (!saved) throw clientsError('EMAIL_TEMPLATE_NOT_FOUND');
    return saved;
  }

  /** Resolve the child's email context (child, primary guardian, company) — all
   *  server-side. The recipient is the child's primary guardian's email; the
   *  sender is the platform/company transport identity (never from the client). */
  async _resolveParentEmailContext(tenantId, clientId) {
    const client = await this._requireClient(tenantId, clientId);
    const guardians = await this.deps.repository.listGuardians(tenantId, clientId);
    const primary = guardians.find((g) => g.isPrimary) ?? guardians[0] ?? null;
    // Resolve the full organization server-side (never trust the frontend). The
    // company display name is the trading name, falling back to legal name.
    let org = null;
    try { org = await this.deps.organizations.getById(tenantId); } catch { /* keep null */ }
    const companyName = (org?.tradingName || org?.legalName || org?.name || 'your provider');
    const context = {
      // Presentation-normalized to match the web app (Title Case names,
      // MM/DD/YYYY dates). Identity keys and emails are never touched.
      childFirstName: formatPersonName(client.firstName) || null,
      parentFirstName: formatPersonName(primary?.firstName) || null,
      companyName,
      appointmentDate: null,
      appointmentTime: null,
    };
    return { client, primary, org, companyName, context };
  }

  /** Read-only preview: renders the (optionally edited) subject/body against the
   *  real child context and returns the resolved recipient/sender. Sends nothing. */
  async previewParentEmail({ tenantId, clientId, templateId, subject, body }) {
    const tpl = await this._resolveEmailTemplate(tenantId, templateId);
    const { primary, org, companyName, context } = await this._resolveParentEmailContext(tenantId, clientId);
    const finalSubject = subject !== undefined ? subject : tpl.subject;
    const finalBody = body !== undefined ? body : tpl.body;
    let rendered;
    try { rendered = renderParentEmail({ subject: finalSubject, body: finalBody }, context); }
    catch (e) { throw clientsError('EMAIL_UNSUPPORTED_VARIABLE', { context: { unsupported: e.unsupported ?? [] } }); }
    // Append the reusable, server-resolved company footer — identical to send.
    rendered = appendCompanyFooter(rendered, org ?? {});
    return {
      templateId: tpl.id, templateName: tpl.name,
      recipient: { name: primary ? `${primary.firstName ?? ''} ${primary.lastName ?? ''}`.trim() : null, email: primary?.email ?? null, available: Boolean(primary?.email) },
      sender: { name: companyName, resolved: 'server' },
      subject: rendered.subject, bodyText: rendered.text, bodyHtml: rendered.html,
      footer: rendered.footer,
      unavailableVariables: rendered.unavailable,
    };
  }

  /** Resolve + render + send through the injected email port (the existing Resend
   *  transport). Never fakes success: a missing guardian email is a clean 422,
   *  and a provider failure propagates. */
  async sendParentEmail({ tenantId, clientId, actorUserId, templateId, subject, body }) {
    const tpl = await this._resolveEmailTemplate(tenantId, templateId);
    const { primary, org, companyName, context } = await this._resolveParentEmailContext(tenantId, clientId);
    if (!primary?.email) throw clientsError('GUARDIAN_EMAIL_UNAVAILABLE');
    const finalSubject = subject !== undefined ? subject : tpl.subject;
    const finalBody = body !== undefined ? body : tpl.body;
    let rendered;
    try { rendered = renderParentEmail({ subject: finalSubject, body: finalBody }, context); }
    catch (e) { throw clientsError('EMAIL_UNSUPPORTED_VARIABLE', { context: { unsupported: e.unsupported ?? [] } }); }
    // Same footer the preview showed — composed from the CURRENT org profile.
    rendered = appendCompanyFooter(rendered, org ?? {});
    if (!this.deps.email || typeof this.deps.email.send !== 'function') throw clientsError('COMMUNICATION_UNAVAILABLE');
    const result = await this.deps.email.send({
      recipientEmail: primary.email,
      view: { subject: rendered.subject, body: rendered.text, html: rendered.html },
    });
    return {
      status: result?.ok ? 'SENT' : 'FAILED',
      messageId: result?.messageId ?? null,
      templateId: tpl.id,
      recipient: { name: primary ? `${primary.firstName ?? ''} ${primary.lastName ?? ''}`.trim() : null },
      sender: { name: companyName },
      subject: rendered.subject,
    };
  }

  /** Org-wide attention view: runs the SAME alerts engine across every active
   *  child and returns those with at least one alert, worst-first. Read-only. */
  async getAttentionRoster({ tenantId }) {
    const rows = await this.deps.repository.listActiveClientsWithAlertState(tenantId, { limit: 500 });
    const order = { CRITICAL: 3, WARNING: 2, INFO: 1 };
    const children = [];
    let critical = 0, warning = 0, info = 0;
    for (const row of rows) {
      const alerts = computeChildAlerts({
        intakeWorkflowStatus: row.intakeWorkflowStatus,
        approvedWeeklyHours: row.approvedWeeklyHours,
        assignedWeeklyHours: row.assignedWeeklyHours,
        careTeam: row.careTeam,
        serviceAuthorizations: row.serviceAuthorizations,
      });
      if (alerts.length === 0) continue;
      const summary = alertsSummary(alerts);
      if (summary.severity === 'CRITICAL') critical += 1;
      else if (summary.severity === 'WARNING') warning += 1;
      else info += 1;
      children.push({
        clientId: row.id, clientNumber: row.clientNumber,
        name: `${row.lastName}, ${row.firstName}`,
        topSeverity: summary.severity, alertCount: alerts.length, alerts,
      });
    }
    children.sort((a, b) => (order[b.topSeverity] - order[a.topSeverity]) || (b.alertCount - a.alertCount));
    return {
      generatedAt: new Date().toISOString(),
      totalActive: rows.length,
      needsAttention: children.length,
      bySeverity: { CRITICAL: critical, WARNING: warning, INFO: info },
      children,
    };
  }

  _present(client) {
    const ssn = client.sensitive ? this.deps.phi.open(client.sensitive.ssn) : null;
    const { sensitive, ...rest } = client;
    return { ...rest, ssn: ssn ?? null };
  }

  _presentIntake(intake) {
    const insurance = intake.insurance ?? {};
    return {
      ...intake,
      insurance: {
        payerName: insurance.payerName ?? null,
        planName: insurance.planName ?? null,
        memberId: this.deps.phi.open(insurance.memberId) ?? null,
      },
    };
  }
}

function optional(key, value) {
  return value !== undefined ? { [key]: value } : {};
}
