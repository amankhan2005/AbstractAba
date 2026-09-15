import { AppError } from '../../common/errors/AppError.js';
import { sendCreated, sendPaginated, sendSuccess } from '../../common/http/responder.js';
import { orgError } from './organization.errors.js';

/**
 * Translates HTTP to the domain and back for the organization module. Holds no
 * business rules — reads the request, calls the service, shapes the response.
 * Mirrors the original controller, including the If-Match optimistic-concurrency
 * header and the platform/tenant/public response shapes.
 */
export class OrganizationController {
  constructor(service) {
    this.service = service;
  }

  // --- platform console -----------------------------------------------------

  create = async (req, res) => {
    const organization = await this.service.create(req.body);
    sendCreated(
      res,
      { id: organization.id, slug: organization.slug, state: organization.state, version: organization.version },
      `/api/v1/platform/organizations/${organization.id}`,
    );
  };

  list = async (req, res) => {
    const query = req.query;
    const page = await this.service.list(query);
    sendPaginated(
      res,
      page.items.map((o) => ({
        id: o.id, slug: o.slug, tradingName: o.tradingName,
        state: o.state, planCode: o.planCode, createdAt: o.createdAt,
        // Owner identity for the Companies list Owner column. These are the
        // organization's own primary-contact fields (already loaded by list()),
        // so this adds no query and exposes no credential/token/auth data.
        primaryContactName: o.primaryContactName ?? null,
        primaryContactEmail: o.primaryContactEmail ?? null,
        activatedAt: o.activatedAt ?? null,
      })),
      { nextCursor: page.nextCursor, limit: query.limit },
    );
  };

  getById = async (req, res) => {
    const o = await this.service.getById(req.params.id);
    sendSuccess(res, {
      id: o.id, slug: o.slug, legalName: o.legalName, tradingName: o.tradingName,
      state: o.state, countryCode: o.countryCode, stateCode: o.stateCode,
      timezone: o.timezone, planCode: o.planCode, customDomain: o.customDomain,
      parentOrganizationId: o.parentOrganizationId,
      primaryContactName: o.primaryContactName ?? null,
      primaryContactEmail: o.primaryContactEmail ?? null,
      logoUrl: o.logoUrl ?? null,
      agreementExecuted: o.agreementId !== null,
      activatedAt: o.activatedAt, offboardingAt: o.offboardingAt,
      createdAt: o.createdAt, version: o.version,
    });
  };

  transition = async (req, res) => {
    const principal = OrganizationController.requirePrincipal(req);
    const body = req.body;
    const organization = await this.service.transition({
      organizationId: req.params.id,
      toState: body.toState,
      reason: body.reason,
      actorUserId: principal.userId,
      expectedVersion: OrganizationController.requireVersion(req),
      ...(body.destruction ? { destruction: body.destruction } : {}),
    });
    sendSuccess(res, { id: organization.id, state: organization.state, version: organization.version });
  };

  // --- tenant application ---------------------------------------------------

  getProfile = async (req, res) => {
    sendSuccess(res, await this.service.getProfile(OrganizationController.requireTenantId(req)));
  };

  updateProfile = async (req, res) => {
    const principal = OrganizationController.requirePrincipal(req);
    const profile = await this.service.updateProfile({
      tenantId: OrganizationController.requireTenantId(req),
      actorUserId: principal.userId,
      expectedVersion: OrganizationController.requireVersion(req),
      changes: req.body,
    });
    sendSuccess(res, profile);
  };

  usage = async (req, res) => {
    sendSuccess(res, await this.service.summariseUsage(OrganizationController.requireTenantId(req)));
  };

  // --- membership -----------------------------------------------------------

  listMemberships = async (req, res) => {
    const principal = OrganizationController.requirePrincipal(req);
    sendSuccess(res, await this.service.listMembershipsForUser(principal.userId));
  };

  switchOrganization = async (req, res) => {
    const principal = OrganizationController.requirePrincipal(req);
    const target = await this.service.resolveSwitchTarget({
      principal,
      targetOrganizationId: req.body.organizationId,
    });
    sendSuccess(res, {
      organizationId: target.organizationId,
      membershipId: target.membershipId,
      organizationTradingName: target.organizationTradingName,
      requiresTokenReissue: true,
    });
  };

  // --- public ---------------------------------------------------------------

  branding = async (req, res) => {
    sendSuccess(res, await this.service.getBrandingForHost(req.query.host));
  };

  // --- helpers --------------------------------------------------------------

  static requirePrincipal(req) {
    if (!req.principal) throw AppError.unauthorized('AUTH-401', 'Authentication required');
    return req.principal;
  }

  static requireTenantId(req) {
    const tenantId = req.principal?.activeTenantId;
    if (tenantId === undefined || tenantId === null) {
      throw orgError('TENANT_CONTEXT_MISSING');
    }
    return tenantId;
  }

  /** Reads and validates the mandatory If-Match version header. */
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
