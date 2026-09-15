import { AppError } from '../../common/errors/AppError.js';
import { sendSuccess } from '../../common/http/responder.js';
import { dashboardsError } from './dashboards.errors.js';

/**
 * HTTP boundary for the role dashboards.
 *
 * SECURITY FIX. The previous implementation read `?staffProfileId` straight
 * from the query string and passed it to the service. Because every shipped
 * role holds `dashboards.read`, that made two disclosures possible:
 *
 *   GET /v1/dashboards/rbt?staffProfileId=<someone-else>  → another
 *        technician's clients, sessions and hours
 *   GET /v1/dashboards/organization                       → company-wide
 *        executive figures, to an RBT
 *
 * Blueprint 4.5 is explicit that an RBT has "no financial visibility beyond
 * their own hours", and 5.2 that a dashboard is a permission-scoped view, not a
 * destination anyone may address.
 *
 * The identity of the clinician a board is drawn for is now DERIVED from the
 * authenticated principal (req.dataScope.staffProfileId), never accepted from
 * the client. A caller holding TEAM or ORGANIZATION scope may still request
 * another clinician's board, but only one inside their scope — a supervising
 * BCBA reviewing a supervisee, an admin reviewing anyone in the clinic.
 */
export class DashboardsController {
  constructor(service) {
    this.service = service;
  }

  /**
   * GET /dashboards/company — the Company Admin dashboard. Tenant and scope come
   * from the authenticated principal only (no tenant, date or clinician is read
   * from the request). The BCBA Appointment Notes section is included only for a
   * caller who could read the notes overview itself (documents.read or
   * scheduling.read, the note routes' own grade).
   */
  company = async (req, res) => {
    DashboardsController.requireOrganizationScope(req);
    const perms = req.principal?.permissions;
    const has = (k) => !!(perms?.has ? perms.has(k) : Array.isArray(perms) && perms.includes(k));
    const data = await this.service.companyDashboard({
      tenantId: DashboardsController.requireTenantId(req),
      includeNotes: has('documents.read') || has('scheduling.read'),
    });
    sendSuccess(res, data);
  };

  organization = async (req, res) => {
    DashboardsController.requireOrganizationScope(req);
    const data = await this.service.organizationDashboard({
      tenantId: DashboardsController.requireTenantId(req),
    });
    sendSuccess(res, data);
  };

  admin = async (req, res) => {
    DashboardsController.requireOrganizationScope(req);
    const data = await this.service.adminDashboard({
      tenantId: DashboardsController.requireTenantId(req),
    });
    sendSuccess(res, data);
  };

  bcba = async (req, res) => {
    const data = await this.service.bcbaDashboard({
      tenantId: DashboardsController.requireTenantId(req),
      ...DashboardsController.subjectStaff(req),
    });
    sendSuccess(res, data);
  };

  rbt = async (req, res) => {
    const data = await this.service.rbtDashboard({
      tenantId: DashboardsController.requireTenantId(req),
      ...DashboardsController.subjectStaff(req),
    });
    sendSuccess(res, data);
  };

  // --- guards --------------------------------------------------------------

  /**
   * Whose board is this? Default: the caller's own. A requested
   * `?staffProfileId` is honoured only when it falls inside the caller's
   * resolved data scope; otherwise it is refused rather than silently ignored,
   * so a mis-scoped client never renders someone else's numbers believing they
   * are its own.
   */
  static subjectStaff(req) {
    const ds = req.dataScope;
    const requested = req.query?.staffProfileId;

    if (requested === undefined) {
      // Tenant-wide callers with no clinician record (a pure admin account)
      // legitimately see the unscoped board; everyone else sees their own.
      if (ds?.staffProfileId) return { staffProfileId: ds.staffProfileId };
      if (ds?.clientIds === null) return {};
      // A narrowing scope (TEAM/SELF) that resolved to NO clinician profile.
      // This is a legitimate principal (they hold dashboards.read) whose
      // user↔StaffProfile link is missing — the BCBA-dashboard-403 bug. The
      // fail-closed answer is an EMPTY personal board, never a hard 403 (which
      // blocks a valid BCBA, blueprint §5.2) and never a fall-through to the
      // service's unscoped/tenant-wide branch (which would disclose whole-clinic
      // figures). `subjectMissing` forces the service to short-circuit to zeros.
      return { subjectMissing: true };
    }

    if (ds?.staffIds === null || ds?.staffIds?.includes(requested)) {
      return { staffProfileId: requested };
    }
    throw AppError.forbidden('AUTH-403', 'You don\u2019t have access to this dashboard.');
  }

  /** Company-wide boards require tenant scope on dashboards.read. */
  static requireOrganizationScope(req) {
    if (req.dataScope?.clientIds !== null) {
      throw AppError.forbidden('AUTH-403', 'You don\u2019t have access to this dashboard.');
    }
  }

  static requireTenantId(req) {
    if (!req.principal) throw AppError.unauthorized('AUTH-401', 'Authentication required');
    const tenantId = req.principal?.activeTenantId;
    if (tenantId === undefined || tenantId === null) throw dashboardsError('TENANT_CONTEXT_MISSING');
    return tenantId;
  }
}
