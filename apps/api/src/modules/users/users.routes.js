import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePlatformOperator } from '../../middleware/requirePlatformOperator.js';
import { enterTenantContext } from '../../middleware/tenantContext.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { UsersController } from './users.controller.js';
import {
  acceptInvitationSchema,
  assignRolesSchema,
  inviteMemberSchema,
  inviteOwnerSchema,
  invitationIdParamsSchema,
  invitationTokenParamsSchema,
  listMembersQuerySchema,
  membershipIdParamsSchema,
  membershipRoleParamsSchema,
  organizationIdParamsSchema,
  ownerInvitationParamsSchema,
  updateMembershipStatusSchema,
} from './users.schemas.js';

/**
 * User & role management routers, ported from the original. Guard placement is
 * reproduced exactly as Step 14 had it:
 *   platform  -> authenticate + requirePlatformOperator
 *   users     -> authenticate + enterTenantContext
 *   roles     -> authenticate + enterTenantContext
 *   public    -> none (the token is the authorization)
 *
 * NOTE (parity): the original Step 14 users routes did NOT attach per-permission
 * requirePermission guards to these endpoints — they gate on authentication and
 * tenant context only. This port preserves that behavior rather than adding
 * guards, which would be a deviation. The RBAC permission keys (users.invite,
 * users.manage, ...) exist in the catalogue and can be layered on as a
 * deliberate, separately-reviewed hardening step.
 */
export function createUsersRouters(service) {
  const controller = new UsersController(service);

  // platform console: bootstrap the first owner
  const platform = Router();
  platform.use(authenticate, requirePlatformOperator);
  platform.post(
    '/:id/owner-invitations',
    validate(organizationIdParamsSchema, 'params'),
    validate(inviteOwnerSchema, 'body'),
    asyncHandler(controller.inviteOwner),
  );
  // Operator views an org's members/owner (org structure, not clinical data).
  platform.get(
    '/:id/users',
    validate(organizationIdParamsSchema, 'params'),
    validate(listMembersQuerySchema, 'query'),
    asyncHandler(controller.platformListMembers),
  );
  // Operator resends the first-owner invitation.
  platform.post(
    '/:id/owner-invitations/:invitationId/resend',
    validate(ownerInvitationParamsSchema, 'params'),
    asyncHandler(controller.platformResendOwnerInvitation),
  );

  // tenant application: members + invitations
  const users = Router();
  users.use(authenticate, enterTenantContext);
  users.get('/', validate(listMembersQuerySchema, 'query'), asyncHandler(controller.listMembers));
  users.post('/', validate(inviteMemberSchema, 'body'), asyncHandler(controller.invite));
  users.post(
    '/invitations/:invitationId/resend',
    validate(invitationIdParamsSchema, 'params'),
    asyncHandler(controller.resendInvitation),
  );
  users.delete(
    '/invitations/:invitationId',
    validate(invitationIdParamsSchema, 'params'),
    asyncHandler(controller.revokeInvitation),
  );
  users.get('/:membershipId', validate(membershipIdParamsSchema, 'params'), asyncHandler(controller.getMember));
  // Admin-initiated staff password reset (Company/Admin only).
  users.post('/:membershipId/reset-password', requirePermission('staff.manage'), validate(membershipIdParamsSchema, 'params'), asyncHandler(controller.resetMemberPassword));
  users.patch(
    '/:membershipId/status',
    validate(membershipIdParamsSchema, 'params'),
    validate(updateMembershipStatusSchema, 'body'),
    asyncHandler(controller.updateStatus),
  );
  users.delete('/:membershipId', validate(membershipIdParamsSchema, 'params'), asyncHandler(controller.remove));
  users.post(
    '/:membershipId/roles',
    validate(membershipIdParamsSchema, 'params'),
    validate(assignRolesSchema, 'body'),
    asyncHandler(controller.assignRoles),
  );
  users.delete(
    '/:membershipId/roles/:roleKey',
    validate(membershipRoleParamsSchema, 'params'),
    asyncHandler(controller.unassignRole),
  );

  // tenant application: assignable roles
  const roles = Router();
  roles.use(authenticate, enterTenantContext);
  roles.get('/', asyncHandler(controller.listRoles));

  // public: invitation preview + accept
  const publicRouter = Router();
  publicRouter.get('/:token', validate(invitationTokenParamsSchema, 'params'), asyncHandler(controller.previewInvitation));
  publicRouter.post(
    '/:token/accept',
    validate(invitationTokenParamsSchema, 'params'),
    validate(acceptInvitationSchema, 'body'),
    asyncHandler(controller.acceptInvitation),
  );

  return { platform, users, roles, public: publicRouter };
}
