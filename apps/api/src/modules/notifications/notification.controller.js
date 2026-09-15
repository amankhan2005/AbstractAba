import { AppError } from '../../common/errors/AppError.js';
import { sendSuccess } from '../../common/http/responder.js';

/**
 * The in-app notification centre and preferences, always acting on the verified
 * principal — a user reads and manages only their own notifications, never a
 * user or tenant named in the path/body. Ported from the original.
 */
export class NotificationController {
  constructor(service) {
    this.service = service;
  }

  list = async (req, res) => {
    const { tenantId, userId } = NotificationController.identity(req);
    sendSuccess(res, await this.service.listForRecipient(tenantId, userId, req.query));
  };

  unreadCount = async (req, res) => {
    const { tenantId, userId } = NotificationController.identity(req);
    sendSuccess(res, { count: await this.service.unreadCount(tenantId, userId) });
  };

  markRead = async (req, res) => {
    const { tenantId, userId } = NotificationController.identity(req);
    await this.service.markRead(tenantId, userId, req.params.id);
    sendSuccess(res, { ok: true });
  };

  markAllRead = async (req, res) => {
    const { tenantId, userId } = NotificationController.identity(req);
    await this.service.markAllRead(tenantId, userId);
    sendSuccess(res, { ok: true });
  };

  getPreferences = async (req, res) => {
    const { tenantId, userId } = NotificationController.identity(req);
    sendSuccess(res, await this.service.getPreferences(tenantId, userId));
  };

  updatePreference = async (req, res) => {
    const { tenantId, userId } = NotificationController.identity(req);
    sendSuccess(res, await this.service.updatePreference(tenantId, userId, req.params.type, req.body.disabledChannels, userId));
  };

  static identity(req) {
    const principal = req.principal;
    if (!principal) throw AppError.unauthorized('AUTH-401', 'Authentication required');
    const tenantId = principal.activeTenantId;
    if (tenantId === null || tenantId === undefined) {
      throw new AppError('TENANT_CONTEXT_MISSING', { status: 500, message: 'Tenant context missing' });
    }
    return { tenantId, userId: principal.userId };
  }
}
