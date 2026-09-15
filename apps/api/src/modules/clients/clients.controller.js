import { AppError } from '../../common/errors/AppError.js';
import { scopeAllowsClient } from '../rbac/dataScope.js';
import { insuranceService } from './insurance.service.js';
import { guardianInvitationService } from './guardian-invitation.js';
import { sendCreated, sendNoContent, sendPaginated, sendSuccess } from '../../common/http/responder.js';
import { clientsError } from './clients.errors.js';

/**
 * Translates HTTP to the domain and back for the clients module. Holds no rules
 * — the ACTIVE gate, PHI sealing, and invariants live in the service. Follows
 * the established controller conventions: the {data} envelope, sendCreated with
 * a Location header, sendPaginated for lists, and the mandatory If-Match version
 * on client updates.
 */
export class ClientsController {
  constructor(service) {
    this.service = service;
  }

  // --- clients --------------------------------------------------------------

  list = async (req, res) => {
    const tenantId = ClientsController.requireTenantId(req);
    const q = req.query;
    const page = await this.service.listClients({
      tenantId,
      // req.dataScope is set by requirePermission. clientIds === null means the
      // caller holds ORGANIZATION scope; an array narrows to the caseload.
      ...(req.dataScope?.clientIds != null ? { clientIds: req.dataScope.clientIds } : {}),
      limit: q.limit,
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
      ...(q.accountStatus !== undefined ? { accountStatus: q.accountStatus } : {}),
      ...(q.search !== undefined ? { search: q.search } : {}),
    });
    sendPaginated(res, page.items, { nextCursor: page.nextCursor, limit: q.limit });
  };

  /** GET /clients/summary — counts within the caller's resolved client scope. */
  summary = async (req, res) => {
    const summary = await this.service.summarizeClients({
      tenantId: ClientsController.requireTenantId(req),
      ...(req.dataScope?.clientIds != null ? { clientIds: req.dataScope.clientIds } : {}),
    });
    sendSuccess(res, summary);
  };

  create = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    const client = await this.service.createClient({
      tenantId: ClientsController.requireTenantId(req),
      actorUserId: principal.userId,
      input: req.body,
    });
    sendCreated(res, client, `/api/v1/clients/${client.id}`);
  };

  get = async (req, res) => {
    ClientsController.assertClientInScope(req);
    const detail = await this.service.getClient({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      viewer: ClientsController.viewerFrom(req),
    });
    sendSuccess(res, detail);
  };

  update = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    ClientsController.assertClientInScope(req);
    const client = await this.service.updateClient({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      actorUserId: principal.userId,
      expectedVersion: ClientsController.requireVersion(req),
      input: req.body,
    });
    sendSuccess(res, client);
  };

  attentionRoster = async (req, res) => {
    ClientsController.requirePrincipal(req);
    const out = await this.service.getAttentionRoster({
      tenantId: ClientsController.requireTenantId(req),
    });
    sendSuccess(res, out);
  };

  childAlerts = async (req, res) => {
    ClientsController.requirePrincipal(req);
    ClientsController.assertClientInScope(req);
    const out = await this.service.getChildAlerts({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
    });
    sendSuccess(res, out);
  };

  parentEmailTemplates = async (req, res) => {
    ClientsController.requirePrincipal(req);
    ClientsController.assertClientInScope(req);
    sendSuccess(res, this.service.listParentEmailTemplates());
  };

  previewParentEmail = async (req, res) => {
    ClientsController.requirePrincipal(req);
    ClientsController.assertClientInScope(req);
    const out = await this.service.previewParentEmail({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      templateId: req.body.templateId, subject: req.body.subject, body: req.body.body,
    });
    sendSuccess(res, out);
  };

  sendParentEmail = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    ClientsController.assertClientInScope(req);
    const out = await this.service.sendParentEmail({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId, actorUserId: principal.userId,
      templateId: req.body.templateId, subject: req.body.subject, body: req.body.body,
    });
    sendSuccess(res, out);
  };

  messageCareTeam = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    ClientsController.assertClientInScope(req);
    const out = await this.service.messageCareTeam({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      actorUserId: principal.userId,
      memberIds: req.body.memberIds,
      subject: req.body.subject,
      message: req.body.message,
    });
    sendSuccess(res, out);
  };

  childProgress = async (req, res) => {
    ClientsController.requirePrincipal(req);
    ClientsController.assertClientInScope(req);
    const out = await this.service.getChildProgress({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
    });
    sendSuccess(res, out);
  };

  transitionIntake = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    ClientsController.assertClientInScope(req);
    const client = await this.service.transitionIntakeWorkflow({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      actorUserId: principal.userId,
      target: req.body.target,
      expectedVersion: ClientsController.requireVersion(req),
    });
    sendSuccess(res, client);
  };

  listAuthorizations = async (req, res) => {
    ClientsController.requirePrincipal(req);
    ClientsController.assertClientInScope(req);
    const items = await this.service.listServiceAuthorizations({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
    });
    sendSuccess(res, items);
  };

  createAuthorization = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    ClientsController.assertClientInScope(req);
    const auth = await this.service.createServiceAuthorization({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      actorUserId: principal.userId,
      input: req.body,
    });
    sendSuccess(res, auth, 201);
  };

  updateAuthorization = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    ClientsController.assertClientInScope(req);
    const auth = await this.service.updateServiceAuthorization({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      authorizationId: req.params.authorizationId,
      actorUserId: principal.userId,
      input: req.body,
    });
    sendSuccess(res, auth);
  };

  transitionAuthorization = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    ClientsController.assertClientInScope(req);
    const auth = await this.service.transitionServiceAuthorization({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      authorizationId: req.params.authorizationId,
      actorUserId: principal.userId,
      target: req.body.target,
      reason: req.body.reason,
    });
    sendSuccess(res, auth);
  };

  archiveAuthorization = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    ClientsController.assertClientInScope(req);
    const result = await this.service.archiveServiceAuthorization({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      authorizationId: req.params.authorizationId,
      actorUserId: principal.userId,
    });
    sendSuccess(res, result);
  };

  archive = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    const result = await this.service.archiveClient({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      actorUserId: principal.userId,
    });
    sendSuccess(res, result);
  };

  // --- guardians ------------------------------------------------------------

  addGuardian = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    const guardian = await this.service.addGuardian({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      actorUserId: principal.userId,
      input: req.body,
    });
    sendCreated(res, guardian, `/api/v1/clients/${req.params.clientId}/guardians/${guardian.id}`);
  };

  updateGuardian = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    const guardian = await this.service.updateGuardian({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      guardianId: req.params.guardianId,
      actorUserId: principal.userId,
      input: req.body,
    });
    sendSuccess(res, guardian);
  };

  removeGuardian = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    await this.service.removeGuardian({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      guardianId: req.params.guardianId,
      actorUserId: principal.userId,
    });
    sendNoContent(res);
  };

  // --- medical entries (conditions + history) -------------------------------

  listMedical = async (req, res) => {
    ClientsController.assertClientInScope(req);
    const entries = await this.service.listMedical({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      ...(req.query.type !== undefined ? { type: req.query.type } : {}),
    });
    // Same field-level policy as the child detail: an RBT reaching this endpoint
    // directly gets NO history and only a minimal conditions summary.
    const viewer = ClientsController.viewerFrom(req);
    const shaped = viewer.scope === 'SELF'
      ? entries.filter((m) => m.type === 'CONDITION').map((m) => ({ id: m.id, type: m.type, label: m.label, status: m.status }))
      : entries;
    sendSuccess(res, shaped);
  };

  addMedical = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    const entry = await this.service.addMedical({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      actorUserId: principal.userId,
      input: req.body,
    });
    sendCreated(res, entry, `/api/v1/clients/${req.params.clientId}/medical/${entry.id}`);
  };

  updateMedical = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    const entry = await this.service.updateMedical({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      entryId: req.params.entryId,
      actorUserId: principal.userId,
      input: req.body,
    });
    sendSuccess(res, entry);
  };

  removeMedical = async (req, res) => {
    await this.service.removeMedical({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      entryId: req.params.entryId,
    });
    sendNoContent(res);
  };

  // --- care team ------------------------------------------------------------

  listCareTeam = async (req, res) => {
    ClientsController.assertClientInScope(req);
    const careTeam = await this.service.listCareTeam({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      viewer: ClientsController.viewerFrom(req),
    });
    sendSuccess(res, careTeam);
  };

  assignCareTeam = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    const assignment = await this.service.assignCareTeam({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      actorUserId: principal.userId,
      input: req.body,
    });
    sendCreated(res, assignment, `/api/v1/clients/${req.params.clientId}/care-team/${assignment.id}`);
  };

  updateAssignment = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    ClientsController.assertClientInScope(req);
    const assignment = await this.service.updateAssignment({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      assignmentId: req.params.assignmentId,
      actorUserId: principal.userId,
      input: req.body,
    });
    sendSuccess(res, assignment);
  };

  endAssignment = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    ClientsController.assertClientInScope(req);
    const assignment = await this.service.endAssignment({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      assignmentId: req.params.assignmentId,
      actorUserId: principal.userId,
      effectiveEndDate: req.body.effectiveEndDate,
    });
    sendSuccess(res, assignment);
  };

  removeCareTeam = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    await this.service.removeCareTeam({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      assignmentId: req.params.assignmentId,
      actorUserId: principal.userId,
    });
    sendNoContent(res);
  };

  // --- contacts -------------------------------------------------------------

  addContact = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    const contact = await this.service.addContact({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      actorUserId: principal.userId,
      input: req.body,
    });
    sendCreated(res, contact, `/api/v1/clients/${req.params.clientId}/contacts/${contact.id}`);
  };

  updateContact = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    const contact = await this.service.updateContact({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      contactId: req.params.contactId,
      actorUserId: principal.userId,
      input: req.body,
    });
    sendSuccess(res, contact);
  };

  removeContact = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    await this.service.removeContact({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      contactId: req.params.contactId,
      actorUserId: principal.userId,
    });
    sendNoContent(res);
  };

  // --- intake ---------------------------------------------------------------

  upsertIntake = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    const intake = await this.service.upsertIntake({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      actorUserId: principal.userId,
      input: req.body,
    });
    sendSuccess(res, intake);
  };

  // --- guards ---------------------------------------------------------------

  static requirePrincipal(req) {
    if (!req.principal) throw AppError.unauthorized('AUTH-401', 'Authentication required');
    return req.principal;
  }

  /**
   * Builds the field-visibility viewer for serialization from the caller's
   * already-resolved permission scope and payroll capability. Company/front-desk
   * (ORGANIZATION scope) see everything; a BCBA (TEAM) loses guardian private
   * contact; an RBT (SELF) gets the minimal child view. Compensation is gated on
   * payroll.read regardless of scope (a BCBA holds clients.update but must never
   * receive pay rates). See clients.visibility.js.
   */
  static viewerFrom(req) {
    return {
      scope: req.dataScope?.scope ?? 'ORGANIZATION',
      canSeeCompensation: req.principal?.permissions?.has?.('payroll.read') ?? false,
    };
  }

  /**
   * Refuses a by-id request for a client outside the caller's data scope.
   *
   * NOT FOUND, not FORBIDDEN: telling an unassigned technician that client
   * 4f2a exists in this clinic is itself a disclosure. The blueprint's
   * isolation contract models exactly this probe ("attempt to read tenant B's
   * records by identifier"); the same reasoning applies within a tenant.
   */
  static assertClientInScope(req) {
    const clientId = req.params?.clientId;
    if (!clientId) return;
    if (!scopeAllowsClient(req.dataScope, clientId)) {
      throw AppError.notFound('CLIENT-404', 'We couldn\u2019t find that client.');
    }
  }

  // --- insurance coverage (blueprint 6.2 / 6.9) ---------------------------
  //
  // Every handler asserts client scope first: coverage is PHI-adjacent and a
  // technician with no assignment to this child must not reach it, whether by
  // list or by identifier.

  listCoverage = async (req, res) => {
    ClientsController.assertClientInScope(req);
    const items = await insuranceService.listForClient({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
    });
    // Always an array. React Query rejects undefined, and "no coverage yet" is
    // an empty list, not a broken query.
    sendSuccess(res, { items, status: await insuranceService.statusForClient({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
    }) });
  };

  createCoverage = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    ClientsController.assertClientInScope(req);
    const coverage = await insuranceService.create({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      actorUserId: principal.userId,
      input: req.body,
    });
    sendCreated(res, coverage);
  };

  updateCoverage = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    ClientsController.assertClientInScope(req);
    const coverage = await insuranceService.update({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      coverageId: req.params.coverageId,
      actorUserId: principal.userId,
      input: req.body,
    });
    sendSuccess(res, coverage);
  };

  /** Record the outcome of a check performed with the payer (6.9, version one). */
  verifyCoverage = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    ClientsController.assertClientInScope(req);
    const coverage = await insuranceService.verify({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      coverageId: req.params.coverageId,
      actorUserId: principal.userId,
      status: req.body.status,
      note: req.body.note ?? null,
      benefitNotes: req.body.benefitNotes ?? null,
      reverificationDueAt: req.body.reverificationDueAt ?? null,
    });
    sendSuccess(res, coverage);
  };

  removeCoverage = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    ClientsController.assertClientInScope(req);
    const result = await insuranceService.remove({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      coverageId: req.params.coverageId,
      actorUserId: principal.userId,
    });
    sendSuccess(res, result);
  };

  // --- guardian invitations (blueprint 2.6 / 6.2) -------------------------
  //
  // A guardian is invited to supply information about ONE child, once. There
  // is no account and no portal — 2.6 excludes a family portal, and 5.1
  // records that the underlying need is met without one.

  listGuardianInvitations = async (req, res) => {
    ClientsController.assertClientInScope(req);
    const items = await guardianInvitationService.listForClient({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
    });
    sendSuccess(res, { items });
  };

  inviteGuardian = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    ClientsController.assertClientInScope(req);
    const invitation = await guardianInvitationService.invite({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      guardianId: req.params.guardianId,
      actorUserId: principal.userId,
    });
    // 201 even when delivery failed: the invitation WAS created and is valid.
    // The delivery outcome is in the body so the UI can say "we couldn't send
    // this" rather than "sent" — never report a success the transport did not
    // actually achieve.
    sendCreated(res, invitation);
  };

  resendGuardianInvitation = async (req, res) => {
    const principal = ClientsController.requirePrincipal(req);
    ClientsController.assertClientInScope(req);
    const invitation = await guardianInvitationService.resend({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      invitationId: req.params.invitationId,
      actorUserId: principal.userId,
    });
    sendSuccess(res, invitation);
  };

  revokeGuardianInvitation = async (req, res) => {
    ClientsController.assertClientInScope(req);
    const invitation = await guardianInvitationService.revoke({
      tenantId: ClientsController.requireTenantId(req),
      clientId: req.params.clientId,
      invitationId: req.params.invitationId,
    });
    sendSuccess(res, invitation);
  };

  static requireTenantId(req) {
    const tenantId = req.principal?.activeTenantId;
    if (tenantId === undefined || tenantId === null) throw clientsError('TENANT_CONTEXT_MISSING');
    return tenantId;
  }

  static requireVersion(req) {
    const header = req.get('if-match');
    if (header === undefined || !/^\d+$/.test(header)) {
      throw AppError.validation('Supply the version you read in an If-Match header.', [
        { path: 'headers.if-match', message: 'Required' },
      ]);
    }
    return Number.parseInt(header, 10);
  }
}
