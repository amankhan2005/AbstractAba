import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { enterTenantContext } from '../../middleware/tenantContext.js';
import { NotificationController } from './notification.controller.js';
import { notificationIdParams, notificationListQuery, notificationTypeParams, updatePreferenceBody } from './notification.schemas.js';

/**
 * The caller's own notification centre and preferences, all under /me. Every
 * action requires authentication + tenant context and is scoped to the verified
 * principal. Ported from the original.
 */
export function createNotificationRouter(service) {
  const controller = new NotificationController(service);
  const router = Router();
  router.use(authenticate, enterTenantContext);

  router.get('/notifications', validate(notificationListQuery, 'query'), asyncHandler(controller.list));
  router.get('/notifications/unread-count', asyncHandler(controller.unreadCount));
  router.post('/notifications/read-all', asyncHandler(controller.markAllRead));
  router.post('/notifications/:id/read', validate(notificationIdParams, 'params'), asyncHandler(controller.markRead));

  router.get('/notification-preferences', asyncHandler(controller.getPreferences));
  router.put('/notification-preferences/:type', validate(notificationTypeParams, 'params'), validate(updatePreferenceBody, 'body'), asyncHandler(controller.updatePreference));

  return router;
}
