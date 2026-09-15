import { AppError } from '../../common/errors/AppError.js';
import { sendCreated, sendNoContent, sendPaginated, sendSuccess } from '../../common/http/responder.js';
import { staffError } from './staff.errors.js';

/**
 * Translates HTTP to the domain and back for staff & credentials. Holds no
 * rules — the ACTIVE gate, supervision guards, and the expiry scan live in the
 * service. Follows the established conventions: {data} envelope, sendCreated
 * with Location, sendPaginated for lists, mandatory If-Match on staff updates.
 */
export class StaffController {
  constructor(service) {
    this.service = service;
  }

  // --- staff ---------------------------------------------------------------

  list = async (req, res) => {
    const tenantId = StaffController.requireTenantId(req);
    const q = req.query;
    const page = await this.service.listStaff({
      tenantId,
      dataScope: req.dataScope,
      limit: q.limit,
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
      ...(q.search !== undefined ? { search: q.search } : {}),
    });
    sendPaginated(res, page.items, { nextCursor: page.nextCursor, limit: q.limit });
  };

  create = async (req, res) => {
    const principal = StaffController.requirePrincipal(req);
    const result = await this.service.provisionStaff({
      tenantId: StaffController.requireTenantId(req),
      actorUserId: principal.userId,
      input: req.body,
    });
    const staff = result.staff;
    // Include the honest delivery outcome so the UI only claims "login
    // instructions sent" when the welcome email was actually queued. The
    // temporary password is NEVER included — it is delivered only by email.
    sendCreated(res, { ...staff, emailQueued: result.emailQueued }, `/api/v1/staff/${staff.id}`);
  };

  get = async (req, res) => {
    const principal = StaffController.requirePrincipal(req);
    const perms = principal.permissions;
    const has = (k) => Boolean(perms?.has ? perms.has(k) : Array.isArray(perms) && perms.includes(k));
    const scopeOf = (k) => principal.permissionScopes?.get?.(k) ?? 'ORGANIZATION';
    const detail = await this.service.getStaff({
      tenantId: StaffController.requireTenantId(req),
      staffId: req.params.staffId,
      // Who may be read comes from the resolved staff.read scope, never the request.
      dataScope: req.dataScope,
      viewer: {
        canViewPay: has('payroll.read') || has('staff.manage'),
        canViewCaseload: has('clients.read') && scopeOf('clients.read') === 'ORGANIZATION',
      },
    });
    sendSuccess(res, detail);
  };
  // Resend the initial login email. The admin never sees the password; the
  // response carries only whether delivery was accepted (queued), never a
  // credential — so the UI can report honestly.
  resendLoginEmail = async (req, res) => {
    const principal = StaffController.requirePrincipal(req);
    const result = await this.service.resendLoginEmail({
      tenantId: StaffController.requireTenantId(req),
      staffId: req.params.staffId,
      actorUserId: principal.userId,
    });
    sendSuccess(res, { staffId: result.staffId, emailQueued: result.emailQueued });
  };

  update = async (req, res) => {
    const principal = StaffController.requirePrincipal(req);
    const staff = await this.service.updateStaff({
      tenantId: StaffController.requireTenantId(req),
      staffId: req.params.staffId,
      actorUserId: principal.userId,
      expectedVersion: StaffController.requireVersion(req),
      input: req.body,
    });
    sendSuccess(res, staff);
  };

  deactivate = async (req, res) => {
    const principal = StaffController.requirePrincipal(req);
    const result = await this.service.deactivateStaff({
      tenantId: StaffController.requireTenantId(req),
      staffId: req.params.staffId,
      actorUserId: principal.userId,
    });
    sendSuccess(res, result);
  };

  // --- credentials ---------------------------------------------------------

  getCredentials = async (req, res) => {
    const credentials = await this.service.listCredentials({
      tenantId: StaffController.requireTenantId(req),
      staffId: req.params.staffId,
    });
    sendSuccess(res, credentials);
  };

  addCredential = async (req, res) => {
    const principal = StaffController.requirePrincipal(req);
    const credential = await this.service.addCredential({
      tenantId: StaffController.requireTenantId(req),
      staffId: req.params.staffId,
      actorUserId: principal.userId,
      input: req.body,
    });
    sendCreated(res, credential, `/api/v1/staff/${req.params.staffId}/credentials/${credential.id}`);
  };

  updateCredential = async (req, res) => {
    const principal = StaffController.requirePrincipal(req);
    const credential = await this.service.updateCredential({
      tenantId: StaffController.requireTenantId(req),
      staffId: req.params.staffId,
      credentialId: req.params.credentialId,
      actorUserId: principal.userId,
      input: req.body,
    });
    sendSuccess(res, credential);
  };

  removeCredential = async (req, res) => {
    const principal = StaffController.requirePrincipal(req);
    await this.service.removeCredential({
      tenantId: StaffController.requireTenantId(req),
      staffId: req.params.staffId,
      credentialId: req.params.credentialId,
      actorUserId: principal.userId,
    });
    sendNoContent(res);
  };

  // --- supervision ---------------------------------------------------------

  assignSupervisee = async (req, res) => {
    const principal = StaffController.requirePrincipal(req);
    const link = await this.service.assignSupervisee({
      tenantId: StaffController.requireTenantId(req),
      staffId: req.params.staffId,
      actorUserId: principal.userId,
      input: req.body,
    });
    sendCreated(res, link, `/api/v1/staff/${req.params.staffId}/supervisees/${link.superviseeStaffId}`);
  };

  endSupervision = async (req, res) => {
    StaffController.requirePrincipal(req);
    await this.service.endSupervision({
      tenantId: StaffController.requireTenantId(req),
      staffId: req.params.staffId,
      superviseeStaffId: req.params.superviseeStaffId,
    });
    sendNoContent(res);
  };

  // --- guards ---------------------------------------------------------------

  static requirePrincipal(req) {
    if (!req.principal) throw AppError.unauthorized('AUTH-401', 'Authentication required');
    return req.principal;
  }

  static requireTenantId(req) {
    const tenantId = req.principal?.activeTenantId;
    if (tenantId === undefined || tenantId === null) throw staffError('TENANT_CONTEXT_MISSING');
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
