import { AppError } from '../../common/errors/AppError.js';
import { sendSuccess } from '../../common/http/responder.js';

/**
 * Reads and writes the active tenant's settings. Every endpoint acts on the
 * tenant in the verified principal's context, never one named in the path/body,
 * so the isolation policy and the request's authorization agree on scope.
 */
export class SettingsController {
  constructor(service) {
    this.service = service;
  }

  getSettings = async (req, res) => {
    sendSuccess(res, await this.service.getEffectiveSettings(SettingsController.requireTenantId(req)));
  };

  getNamespace = async (req, res) => {
    sendSuccess(res, await this.service.getNamespace(SettingsController.requireTenantId(req), req.params.namespace));
  };

  updateNamespace = async (req, res) => {
    const principal = SettingsController.requirePrincipal(req);
    const tenantId = SettingsController.requireTenantId(req);
    sendSuccess(res, await this.service.updateNamespace(tenantId, req.params.namespace, req.body, principal.userId));
  };

  static requirePrincipal(req) {
    if (!req.principal) throw AppError.unauthorized('AUTH-401', 'Authentication required');
    return req.principal;
  }

  static requireTenantId(req) {
    const tenantId = req.principal?.activeTenantId;
    if (tenantId === undefined || tenantId === null) {
      throw new AppError('TENANT_CONTEXT_MISSING', { status: 500, message: 'Tenant context missing' });
    }
    return tenantId;
  }
}
