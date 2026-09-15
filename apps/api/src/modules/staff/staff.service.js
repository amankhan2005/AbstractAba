import { staffError } from './staff.errors.js';
import { STAFF_WELCOME_EMAIL_JOB } from './staff-welcome.email.js';

/** How far ahead the expiry scan looks, in days. */
export const CREDENTIAL_EXPIRY_WINDOW_DAYS = 30;

/**
 * Staff & credentials business rules. The repository holds data access; the
 * organization port answers the ACTIVE gate; the notifications port raises the
 * credential-expiry notification. Dependencies are injected so the service runs
 * without a database.
 *
 * The ACTIVE gate applies to every write (consistent with the clients module):
 * staff records are clinical-spine data and may only be changed while the
 * organization is ACTIVE — otherwise a 409.
 *
 * @typedef {{ repository: object, organizations: { getById:(id:string)=>Promise<{state:string}|null> }, notifications: { dispatch:(type:string, ctx:object)=>Promise<void> }, now?: ()=>Date }} StaffDeps
 */
export class StaffService {
  /** @param {StaffDeps} deps */
  constructor(deps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  async _assertActive(tenantId) {
    const org = await this.deps.organizations.getById(tenantId);
    if (!org || org.state !== 'ACTIVE') throw staffError('ORG_NOT_ACTIVE');
  }

  async _requireStaff(tenantId, staffId) {
    const staff = await this.deps.repository.findStaffById(tenantId, staffId);
    if (!staff) throw staffError('STAFF_NOT_FOUND');
    return staff;
  }

  // --- staff ---------------------------------------------------------------

  /**
   * Provision a new staff member (BCBA/RBT) end to end. The ORDER is critical:
   *   1) generate a temporary password server-side and hash it;
   *   2) create the ACTIVE user (temp password + mustChangePassword) + ACTIVE
   *      membership + role — this REJECTS a duplicate email BEFORE any write, so
   *      a failure never sends a credential email and never orphans a profile;
   *   3) create the StaffProfile linked to the GENERATED userId;
   *   4) ONLY after the account is persisted, enqueue the welcome/login email
   *      carrying the temporary password.
   * The caller never supplies a userId; the temporary password is never returned
   * to the API caller/admin, only delivered to the staff member by email.
   */
  async provisionStaff({ tenantId, actorUserId, input }) {
    await this._assertActive(tenantId);
    if (!this.deps.usersRepository || typeof this.deps.usersRepository.provisionStaffAccount !== 'function') {
      throw staffError('STAFF_PROVISIONING_UNAVAILABLE');
    }
    const fullName = [input.firstName, input.middleName, input.lastName].filter((p) => p != null && String(p).trim() !== '').join(' ').trim();
    const roleKey = input.roleKey;
    const email = String(input.email).toLowerCase().trim();

    // 1) temporary password — random, server-side, policy-compliant, hashed now.
    const temporaryPassword = this.deps.passwords.generateTemporary();
    const passwordHash = await this.deps.passwords.hash(temporaryPassword);
    const userId = this.deps.newId();
    const membershipId = this.deps.newId();

    // 2) create the account (throws DUPLICATE_STAFF_EMAIL before any write if the
    //    email is already taken — no orphan StaffProfile, no email sent).
    await this.deps.usersRepository.provisionStaffAccount({
      userId, membershipId, tenantId, email, fullName, passwordHash, roleKey, actorUserId,
    });

    // 3) link the StaffProfile to the generated userId.
    const staff = await this.createStaff({
      tenantId,
      actorUserId,
      input: {
        userId,
        firstName: input.firstName,
        ...(input.middleName !== undefined ? { middleName: input.middleName } : {}),
        lastName: input.lastName,
        discipline: input.discipline ?? (roleKey === 'bcba' ? 'BCBA' : 'RBT'),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
    });

    // 3b) persist the Hourly Pay Rate (spec Module 1) to the authoritative,
    //     effective-dated staff PayRate model — the SINGLE source of pay truth
    //     that payroll reads. It lives on the staff member, never on a care-team
    //     assignment. Best-effort: a rate-write failure never rolls back the
    //     created account.
    await this._setHourlyPayRate({
      tenantId, staffProfileId: staff.id, actorUserId,
      amount: input.hourlyPayRate, effectiveFrom: input.startDate,
    });

    // 4) account exists — now deliver the welcome email. Best-effort: a delivery
    //    failure never rolls back the created account and is reported honestly
    //    (emailQueued=false) so the UI does not claim "sent" when it wasn't.
    const emailQueued = await this._enqueueWelcomeEmail({ tenantId, actorUserId, email, temporaryPassword, fullName, roleKey, userId });
    return { staff, userId, membershipId, emailQueued };
  }

  /**
   * Resend the initial login email — only BEFORE the member has completed their
   * first login. Rotates the temporary password (invalidating the previous one),
   * re-arms mustChangePassword, and re-enqueues the welcome email. Refused once
   * first login is complete (use Reset Password for an active account instead).
   */
  async resendLoginEmail({ tenantId, staffId, actorUserId }) {
    await this._assertActive(tenantId);
    const staff = await this._requireStaff(tenantId, staffId);
    const account = await this.deps.usersRepository.findStaffAccountByUserId(tenantId, staff.userId);
    if (!account) throw staffError('STAFF_NOT_FOUND');
    if (account.firstLoginCompleted) throw staffError('STAFF_ALREADY_ACTIVATED');

    const temporaryPassword = this.deps.passwords.generateTemporary();
    const passwordHash = await this.deps.passwords.hash(temporaryPassword);
    await this.deps.usersRepository.rotateStaffTempPassword({ userId: staff.userId, passwordHash });

    const fullName = `${staff.firstName} ${staff.lastName}`.trim();
    const roleKey = account.roleKeys?.[0] ?? String(staff.discipline ?? '').toLowerCase();
    const emailQueued = await this._enqueueWelcomeEmail({
      tenantId, actorUserId, email: account.loginEmail, temporaryPassword, fullName, roleKey,
      userId: staff.userId, rotate: true,
    });
    return { staffId, emailQueued };
  }

  /** Enqueue the welcome/login email through the shared job queue. Never logs the password. */
  async _enqueueWelcomeEmail({ tenantId, actorUserId, email, temporaryPassword, fullName, roleKey, userId, rotate = false }) {
    if (!this.deps.jobQueue || typeof this.deps.jobQueue.enqueue !== 'function') return false;
    try {
      await this.deps.jobQueue.enqueue({
        type: STAFF_WELCOME_EMAIL_JOB,
        tenantId,
        actorId: actorUserId,
        payload: { email, temporaryPassword, fullName, roleKey },
        idempotencyKey: rotate ? `staff-welcome:${userId}:${this.now().getTime()}` : `staff-welcome:${userId}`,
      });
      return true;
    } catch {
      return false;
    }
  }

  async createStaff({ tenantId, actorUserId, input }) {
    await this._assertActive(tenantId);
    // Employee ID is SERVER-generated (spec §6): use a provided value only for a
    // pre-existing/migrated record; otherwise generate a unique one. Never
    // regenerated on update, so existing IDs are preserved.
    const employeeNumber = input.employeeNumber ?? await this.deps.repository.nextEmployeeNumber(tenantId);
    const doc = {
      userId: input.userId,
      firstName: input.firstName,
      ...opt('middleName', input.middleName),
      lastName: input.lastName,
      ...opt('title', input.title),
      ...opt('discipline', input.discipline),
      employeeNumber,
      ...opt('status', input.status),
      ...opt('notes', input.notes),
      ...(input.startDate !== undefined ? { startDate: new Date(input.startDate) } : {}),
      createdBy: actorUserId,
      updatedBy: actorUserId,
    };
    return this.deps.repository.createStaff(tenantId, doc);
  }

  /**
   * Staff detail. `dataScope` narrows WHO may be read: a caller whose staff.read
   * scope is not tenant-wide (a BCBA's team, an RBT's own record) gets
   * STAFF_NOT_FOUND for anyone outside it — the same answer as a missing record,
   * so existence is never disclosed. `viewer` gates the sensitive sections:
   *   canViewPay       hourly pay rate (payroll.read / staff.manage)
   *   canViewCaseload  the staff member's ACTIVE client assignments
   * Both default to the historical behaviour (pay shown, no caseload) for
   * internal callers that pass nothing.
   */
  async getStaff({ tenantId, staffId, dataScope, viewer = {} }) {
    if (Array.isArray(dataScope?.staffIds) && !dataScope.staffIds.includes(staffId)) {
      throw staffError('STAFF_NOT_FOUND');
    }
    const canViewPay = viewer.canViewPay !== false;
    const canViewCaseload = viewer.canViewCaseload === true;
    const staff = await this._requireStaff(tenantId, staffId);
    const [credentials, supervisees, supervisors, account, hourlyPayRate, caseload] = await Promise.all([
      this.deps.repository.listCredentials(tenantId, staffId),
      this.deps.repository.listSupervisees(tenantId, staffId),
      this.deps.repository.listSupervisors(tenantId, staffId),
      this.deps.usersRepository?.findStaffAccountByUserId
        ? this.deps.usersRepository.findStaffAccountByUserId(tenantId, staff.userId)
        : Promise.resolve(null),
      canViewPay && this.deps.payRates?.getCurrentHourlyRate
        ? this.deps.payRates.getCurrentHourlyRate({ tenantId, staffProfileId: staffId }).catch(() => null)
        : Promise.resolve(null),
      canViewCaseload && this.deps.repository.listActiveAssignmentsForStaff
        ? this.deps.repository.listActiveAssignmentsForStaff(tenantId, staffId)
        : Promise.resolve(null),
    ]);
    // Merge SAFE login metadata onto the staff record so the Company Panel can
    // render an Account/Login section (login email, statuses, first-login) and
    // enable Reset Password / Resend Login Email. Only non-secret fields — never
    // a password, hash, reset token, or invitation token.
    const enrichedStaff = account
      ? {
          ...staff,
          hourlyPayRate: hourlyPayRate ?? null,
          membershipId: account.membershipId,
          roleKeys: account.roleKeys,
          loginEmail: account.loginEmail,
          accountStatus: account.accountStatus,
          membershipStatus: account.membershipStatus,
          firstLoginCompleted: account.firstLoginCompleted,
          firstLoginAt: account.firstLoginAt,
          lastLoginAt: account.lastLoginAt,
        }
      : { ...staff, hourlyPayRate: hourlyPayRate ?? null };
    // A caller without pay visibility receives no pay field at all (not a null
    // that reads as "no rate configured").
    if (!canViewPay) delete enrichedStaff.hourlyPayRate;
    const detail = { staff: enrichedStaff, account: account ?? null, credentials, supervisees, supervisors };
    if (caseload) detail.caseload = { activeClientCount: new Set(caseload.map((a) => a.clientId)).size, assignments: caseload };
    return detail;
  }

  async listStaff({ tenantId, limit, cursor, status, search, dataScope }) {
    return this.deps.repository.listStaff(tenantId, {
      ...(dataScope !== undefined ? { dataScope } : {}),
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(search !== undefined ? { search } : {}),
    });
  }

  async updateStaff({ tenantId, staffId, actorUserId, expectedVersion, input }) {
    await this._assertActive(tenantId);
    const patch = { updatedBy: actorUserId };
    // hourlyPayRate is NOT a StaffProfile column — it is compensation and lives on
    // the PayRate model. Route it there (append a new effective-dated rate) rather
    // than onto the profile row, so there is one source of pay truth (spec Module 1).
    // employeeNumber is server-managed and never updated here (spec §6).
    for (const key of ['firstName', 'middleName', 'lastName', 'title', 'discipline', 'status', 'notes']) {
      if (input[key] !== undefined) patch[key] = input[key];
    }
    if (input.startDate !== undefined) patch.startDate = new Date(input.startDate);
    // Company Admin email update (spec §7): the canonical email lives on the User
    // row, never duplicated onto StaffProfile. Resolve the linked user and update
    // it there, with the same normalization + uniqueness the account creation
    // path enforces. Done before the profile write so a duplicate email fails
    // cleanly without a partial change.
    if (input.email !== undefined) {
      const current = await this.deps.repository.findStaffById(tenantId, staffId);
      if (!current) throw staffError('STAFF_NOT_FOUND');
      if (!this.deps.usersRepository?.updateUserEmail) throw staffError('STAFF_PROVISIONING_UNAVAILABLE');
      await this.deps.usersRepository.updateUserEmail({ tenantId, userId: current.userId, email: String(input.email).toLowerCase().trim(), actorUserId });
    }
    const updated = await this.deps.repository.updateStaff(tenantId, staffId, patch, expectedVersion);
    if (input.hourlyPayRate !== undefined) {
      await this._setHourlyPayRate({ tenantId, staffProfileId: staffId, actorUserId, amount: input.hourlyPayRate });
    }
    return updated;
  }

  /**
   * Persist an Hourly Pay Rate for a staff member to the authoritative PayRate
   * model (spec Module 1). `amount` is whole dollars/hour as entered in the Staff
   * form; the port converts to minor units and stores an effective-dated HOURLY
   * rate. Best-effort and injected, so the DB-free service tests run without it
   * and a rate-write failure never breaks staff create/update.
   */
  async _setHourlyPayRate({ tenantId, staffProfileId, actorUserId, amount, effectiveFrom }) {
    if (amount === undefined || amount === null) return false;
    if (!this.deps.payRates || typeof this.deps.payRates.setHourlyRate !== 'function') return false;
    try {
      await this.deps.payRates.setHourlyRate({
        tenantId, staffProfileId, actorUserId,
        amount: Number(amount),
        effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : this.now(),
      });
      return true;
    } catch {
      return false;
    }
  }

  async deactivateStaff({ tenantId, staffId, actorUserId }) {
    await this._assertActive(tenantId);
    return this.deps.repository.deactivateStaff(tenantId, staffId, actorUserId);
  }

  // --- credentials ---------------------------------------------------------

  async listCredentials({ tenantId, staffId }) {
    await this._requireStaff(tenantId, staffId);
    return this.deps.repository.listCredentials(tenantId, staffId);
  }

  async addCredential({ tenantId, staffId, actorUserId, input }) {
    await this._assertActive(tenantId);
    await this._requireStaff(tenantId, staffId);
    const doc = {
      credentialType: input.credentialType,
      ...opt('number', input.number),
      ...opt('issuingAuthority', input.issuingAuthority),
      ...opt('status', input.status),
      ...(input.issuedDate !== undefined ? { issuedDate: new Date(input.issuedDate) } : {}),
      ...(input.expiresDate !== undefined ? { expiresDate: new Date(input.expiresDate) } : {}),
      createdBy: actorUserId,
      updatedBy: actorUserId,
    };
    return this.deps.repository.addCredential(tenantId, staffId, doc);
  }

  async updateCredential({ tenantId, staffId, credentialId, actorUserId, input }) {
    await this._assertActive(tenantId);
    const patch = { updatedBy: actorUserId };
    for (const key of ['credentialType', 'number', 'issuingAuthority', 'status']) {
      if (input[key] !== undefined) patch[key] = input[key];
    }
    if (input.issuedDate !== undefined) patch.issuedDate = new Date(input.issuedDate);
    if (input.expiresDate !== undefined) patch.expiresDate = new Date(input.expiresDate);
    return this.deps.repository.updateCredential(tenantId, staffId, credentialId, patch);
  }

  async removeCredential({ tenantId, staffId, credentialId, actorUserId }) {
    await this._assertActive(tenantId);
    return this.deps.repository.removeCredential(tenantId, staffId, credentialId, actorUserId);
  }

  // --- supervision ---------------------------------------------------------

  async assignSupervisee({ tenantId, staffId, actorUserId, input }) {
    await this._assertActive(tenantId);
    if (staffId === input.superviseeStaffId) throw staffError('SELF_SUPERVISION');
    await this._requireStaff(tenantId, staffId);
    await this._requireStaff(tenantId, input.superviseeStaffId);
    return this.deps.repository.assignSupervisee(
      tenantId,
      staffId,
      input.superviseeStaffId,
      input.startDate !== undefined ? new Date(input.startDate) : undefined,
    );
  }

  async endSupervision({ tenantId, staffId, superviseeStaffId }) {
    await this._assertActive(tenantId);
    return this.deps.repository.endSupervision(tenantId, staffId, superviseeStaffId);
  }

  // --- credential-expiry scan (job producer) --------------------------------

  /**
   * Scans for active credentials expiring within the window and raises one
   * staff.credential_expiring notification per credential. Carries no PHI — the
   * notification references the credential type, the staff name (the clinic's
   * own staff, not a patient), the expiry date, and a link to the staff record.
   * Returns the number of notifications raised. Invoked by the scheduled job
   * handler; also directly callable.
   */
  async scanExpiringCredentials(tenantId) {
    const before = new Date(this.now().getTime() + CREDENTIAL_EXPIRY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const expiring = await this.deps.repository.listExpiringCredentials(tenantId, before);
    let raised = 0;
    for (const credential of expiring) {
      const staff = await this.deps.repository.findStaffById(tenantId, credential.staffProfileId);
      const who = staff ? `${staff.firstName} ${staff.lastName}` : 'a staff member';
      const on = credential.expiresDate ? new Date(credential.expiresDate).toISOString().slice(0, 10) : 'soon';
      await this.deps.notifications.dispatch('staff.credential_expiring', {
        tenantId,
        content: {
          subject: `Credential expiring: ${credential.credentialType} for ${who}`,
          inAppBody: `The ${credential.credentialType} credential for ${who} expires on ${on}.`,
          link: staff ? `/staff/${staff.id}` : '/staff',
        },
      });
      raised += 1;
    }
    return { scanned: expiring.length, raised };
  }
}

function opt(key, value) {
  return value !== undefined ? { [key]: value } : {};
}
