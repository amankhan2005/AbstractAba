import { AppError } from '../../common/errors/AppError.js';
import { sendNoContent, sendSuccess } from '../../common/http/responder.js';
import { uploadLogo } from './logo-upload.service.js';

/**
 * Reads and writes the two mutable token layers. Preference endpoints act on the
 * caller alone (user id from the verified principal, never path/body — BR-UI-5);
 * brand endpoints act on the active tenant; the resolved-theme endpoint composes
 * all three layers. Ported from the original controller.
 */
export class ThemingController {
  constructor(service) {
    this.service = service;
  }

  myPreferences = async (req, res) => {
    const principal = ThemingController.requirePrincipal(req);
    sendSuccess(res, await this.service.getPreferences(principal.userId));
  };

  updateMyPreferences = async (req, res) => {
    const principal = ThemingController.requirePrincipal(req);
    sendSuccess(res, await this.service.updatePreferences(principal.userId, req.body));
  };

  resetMyPreferences = async (req, res) => {
    const principal = ThemingController.requirePrincipal(req);
    await this.service.resetPreferences(principal.userId);
    sendNoContent(res);
  };

  myTheme = async (req, res) => {
    const principal = ThemingController.requirePrincipal(req);
    sendSuccess(res, await this.service.resolveTheme({
      userId: principal.userId,
      activeTenantId: principal.activeTenantId ?? null,
    }));
  };

  getBranding = async (req, res) => {
    sendSuccess(res, await this.service.getBranding(ThemingController.requireTenantId(req)));
  };

  updateBranding = async (req, res) => {
    const principal = ThemingController.requirePrincipal(req);
    const tenantId = ThemingController.requireTenantId(req);
    sendSuccess(res, await this.service.updateBranding(tenantId, req.body, principal.userId));
  };

  static requirePrincipal(req) {
    if (!req.principal) throw AppError.unauthorized('AUTH-401', 'Authentication required');
    return req.principal;
  }
  /**
   * Upload or replace the company logo (blueprint 6.14 brand tokens).
   *
   * The URL is written into the tenant's OWN brand tokens by tenant id taken
   * from the authenticated principal — never from the request — so one company
   * cannot point another's branding at its asset.
   */
  uploadLogo = async (req, res) => {
    const principal = ThemingController.requirePrincipal(req);
    const tenantId = ThemingController.requireTenantId(req);

    // Accept a data URL or bare base64; validate the DECODED bytes.
    const raw = String(req.body.file).replace(/^data:[^;]+;base64,/, '');
    let buffer;
    try {
      buffer = Buffer.from(raw, 'base64');
    } catch {
      throw AppError.validation('We couldn\u2019t read that file. Please choose another image.');
    }

    const { url } = await uploadLogo({ tenantId, buffer });
    const branding = await this.service.updateBranding(tenantId, { logoUrl: url }, principal.userId);
    sendSuccess(res, branding);
  };

  static requireTenantId(req) {
    const tenantId = req.principal?.activeTenantId;
    if (tenantId === undefined || tenantId === null) {
      throw new AppError('TENANT_CONTEXT_MISSING', { status: 500, message: 'Tenant context missing' });
    }
    return tenantId;
  }
}
