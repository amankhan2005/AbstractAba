import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { enterTenantContext } from '../../middleware/tenantContext.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { StaffController } from './staff.controller.js';
import {
  provisionStaffSchema,
  updateStaffSchema,
  listStaffQuerySchema,
  staffIdParamsSchema,
  createCredentialSchema,
  updateCredentialSchema,
  credentialParamsSchema,
  assignSuperviseeSchema,
  superviseeParamsSchema,
} from './staff.schemas.js';

/**
 * Staff & credentials router. Every route is authenticated, bound to the tenant
 * context, and guarded by an explicit permission (like the clients module).
 * Reading staff/credentials requires the *.read permission; managing them
 * requires the *.manage permission. Supervision assignment is a staff.manage
 * operation.
 */
export function createStaffRouter(service) {
  const controller = new StaffController(service);
  const router = Router();
  router.use(authenticate, enterTenantContext);

  // staff
  router.get('/', requirePermission('staff.read'), validate(listStaffQuerySchema, 'query'), asyncHandler(controller.list));
  router.post('/', requirePermission('staff.manage'), validate(provisionStaffSchema, 'body'), asyncHandler(controller.create));
  router.get('/:staffId', requirePermission('staff.read'), validate(staffIdParamsSchema, 'params'), asyncHandler(controller.get));
  router.patch('/:staffId', requirePermission('staff.manage'), validate(staffIdParamsSchema, 'params'), validate(updateStaffSchema, 'body'), asyncHandler(controller.update));
  router.post('/:staffId/deactivate', requirePermission('staff.manage'), validate(staffIdParamsSchema, 'params'), asyncHandler(controller.deactivate));
  // Resend the initial login email — server-side gated to BEFORE first login.
  router.post('/:staffId/resend-login-email', requirePermission('staff.manage'), validate(staffIdParamsSchema, 'params'), asyncHandler(controller.resendLoginEmail));

  // credentials
  router.get('/:staffId/credentials', requirePermission('credentials.read'), validate(staffIdParamsSchema, 'params'), asyncHandler(controller.getCredentials));
  router.post('/:staffId/credentials', requirePermission('credentials.manage'), validate(staffIdParamsSchema, 'params'), validate(createCredentialSchema, 'body'), asyncHandler(controller.addCredential));
  router.patch('/:staffId/credentials/:credentialId', requirePermission('credentials.manage'), validate(credentialParamsSchema, 'params'), validate(updateCredentialSchema, 'body'), asyncHandler(controller.updateCredential));
  router.delete('/:staffId/credentials/:credentialId', requirePermission('credentials.manage'), validate(credentialParamsSchema, 'params'), asyncHandler(controller.removeCredential));

  // supervision
  router.post('/:staffId/supervisees', requirePermission('staff.manage'), validate(staffIdParamsSchema, 'params'), validate(assignSuperviseeSchema, 'body'), asyncHandler(controller.assignSupervisee));
  router.delete('/:staffId/supervisees/:superviseeStaffId', requirePermission('staff.manage'), validate(superviseeParamsSchema, 'params'), asyncHandler(controller.endSupervision));

  return router;
}
