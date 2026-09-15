import { AppError } from '../../common/errors/AppError.js';
import { sendCreated, sendNoContent, sendPaginated, sendSuccess } from '../../common/http/responder.js';
import { issueResetForUser } from '../auth/passwordReset.js';
import { User } from '../../models/index.js';
import { withPlatform } from '../../tenancy/tenantContext.js';
import { usersError } from './users.errors.js';

/**
 * Translates HTTP to the domain and back for user & role management. Holds no
 * rules — every decision (owner invariant, invitation usability, self-action)
 * lives in the service. Ported from the original controller, including the
 * {data} envelope, sendCreated Location header, and If-Match version.
 */
export class UsersController {
  constructor(service) {
    this.service = service;
  }

  // --- platform console -----------------------------------------------------

  inviteOwner = async (req, res) => {
    const principal = UsersController.requirePrincipal(req);
    const result = await this.service.inviteInitialOwner({
      organizationId: req.params.id,
      email: req.body.email,
      fullName: req.body.fullName,
      invitedByUserId: principal.userId,
    });
    sendCreated(res, UsersController.toInvitationResponse(result), `/api/v1/users/${result.member.membershipId}`);
  };

  // Operator (platform) reads an organization's members/owner. This is org
  // structure, not clinical data — legitimate tenant-lifecycle information for
  // the Console's company detail page. Scoped to the org in the path.
  platformListMembers = async (req, res) => {
    const query = req.query;
    const page = await this.service.listMembers({
      tenantId: req.params.id,
      limit: query.limit,
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.search !== undefined ? { search: query.search } : {}),
    });
    sendPaginated(res, page.items.map(UsersController.toMemberResponse), {
      nextCursor: page.nextCursor,
      limit: query.limit,
    });
  };

  // Operator resends the first-owner invitation. The raw token is NOT returned
  // in the response (it is delivered out-of-band); only the invitation summary.
  platformResendOwnerInvitation = async (req, res) => {
    const principal = UsersController.requirePrincipal(req);
    const result = await this.service.resendInvitation({
      tenantId: req.params.id,
      invitationId: req.params.invitationId,
      actorUserId: principal.userId,
    });
    sendSuccess(res, { invitation: UsersController.toInvitationSummary(result.invitation) });
  };

  listMembers = async (req, res) => {
    const tenantId = UsersController.requireTenantId(req);
    const query = req.query;
    const page = await this.service.listMembers({
      tenantId,
      limit: query.limit,
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.search !== undefined ? { search: query.search } : {}),
    });
    sendPaginated(res, page.items.map(UsersController.toMemberResponse), {
      nextCursor: page.nextCursor,
      limit: query.limit,
    });
  };

  getMember = async (req, res) => {
    const member = await this.service.getMember(UsersController.requireTenantId(req), req.params.membershipId);
    sendSuccess(res, UsersController.toMemberResponse(member));
  };

  invite = async (req, res) => {
    const principal = UsersController.requirePrincipal(req);
    const result = await this.service.inviteMember({
      tenantId: UsersController.requireTenantId(req),
      email: req.body.email,
      fullName: req.body.fullName,
      roleKeys: req.body.roleKeys,
      invitedByUserId: principal.userId,
    });
    sendCreated(res, UsersController.toInvitationResponse(result), `/api/v1/users/${result.member.membershipId}`);
  };

  resendInvitation = async (req, res) => {
    const result = await this.service.resendInvitation({
      tenantId: UsersController.requireTenantId(req),
      invitationId: req.params.invitationId,
    });
    sendSuccess(res, {
      invitation: UsersController.toInvitationSummary(result.invitation),
      token: result.token,
      expiresAt: result.invitation.expiresAt,
    });
  };

  revokeInvitation = async (req, res) => {
    const principal = UsersController.requirePrincipal(req);
    await this.service.revokeInvitation({
      tenantId: UsersController.requireTenantId(req),
      invitationId: req.params.invitationId,
      actorUserId: principal.userId,
    });
    sendNoContent(res);
  };

  updateStatus = async (req, res) => {
    const principal = UsersController.requirePrincipal(req);
    const member = await this.service.setMembershipStatus({
      tenantId: UsersController.requireTenantId(req),
      membershipId: req.params.membershipId,
      status: req.body.status,
      expectedVersion: UsersController.requireVersion(req),
      actorUserId: principal.userId,
    });
    sendSuccess(res, UsersController.toMemberResponse(member));
  };

  remove = async (req, res) => {
    const principal = UsersController.requirePrincipal(req);
    await this.service.removeMember({
      tenantId: UsersController.requireTenantId(req),
      membershipId: req.params.membershipId,
      expectedVersion: UsersController.requireVersion(req),
      actorUserId: principal.userId,
    });
    sendNoContent(res);
  };

  assignRoles = async (req, res) => {
    const principal = UsersController.requirePrincipal(req);
    const member = await this.service.assignRoles({
      tenantId: UsersController.requireTenantId(req),
      membershipId: req.params.membershipId,
      roleKeys: req.body.roleKeys,
      actorUserId: principal.userId,
    });
    sendSuccess(res, UsersController.toMemberResponse(member));
  };

  unassignRole = async (req, res) => {
    const principal = UsersController.requirePrincipal(req);
    const member = await this.service.unassignRole({
      tenantId: UsersController.requireTenantId(req),
      membershipId: req.params.membershipId,
      roleKey: req.params.roleKey,
      actorUserId: principal.userId,
    });
    sendSuccess(res, UsersController.toMemberResponse(member));
  };

  listRoles = async (req, res) => {
    sendSuccess(res, await this.service.listAssignableRoles(UsersController.requireTenantId(req)));
  };

  // --- public (token holders) ----------------------------------------------

  previewInvitation = async (req, res) => {
    sendSuccess(res, await this.service.previewInvitation(req.params.token));
  };

  acceptInvitation = async (req, res) => {
    const member = await this.service.acceptInvitation({
      token: req.params.token,
      password: req.body.password,
      ...(req.body.fullName !== undefined ? { fullName: req.body.fullName } : {}),
    });
    sendSuccess(res, UsersController.toMemberResponse(member));
  };

  // --- response shaping -----------------------------------------------------

  static toMemberResponse(member) {
    return {
      membershipId: member.membershipId,
      userId: member.userId,
      email: member.email,
      fullName: member.fullName,
      status: member.status,
      isOwner: member.isOwner,
      accountStatus: member.userStatus,
      joinedAt: member.joinedAt,
      lastLoginAt: member.lastLoginAt,
      roles: member.roles,
      createdAt: member.createdAt,
      version: member.version,
    };
  }

  static toInvitationSummary(invitation) {
    return {
      id: invitation.id,
      email: invitation.email,
      expiresAt: invitation.expiresAt,
      acceptedAt: invitation.acceptedAt,
      revokedAt: invitation.revokedAt,
      createdAt: invitation.createdAt,
    };
  }

  static toInvitationResponse(result) {
    return {
      member: UsersController.toMemberResponse(result.member),
      invitation: UsersController.toInvitationSummary(result.invitation),
      // Raw token returned once for the inviter to deliver; never stored/recoverable.
      token: result.token,
    };
  }

  // --- helpers --------------------------------------------------------------

  static requirePrincipal(req) {
    if (!req.principal) throw AppError.unauthorized('AUTH-401', 'Authentication required');
    return req.principal;
  }

  static requireTenantId(req) {
    const tenantId = req.principal?.activeTenantId;
    if (tenantId === undefined || tenantId === null) throw usersError('TENANT_CONTEXT_MISSING');
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

  // Admin-initiated password reset for a staff member (BCBA/RBT/etc). Gated by
  // requirePermission('staff.manage') so only Company/Admin reaches it; the member
  // is resolved WITHIN the caller's tenant (a cross-tenant membershipId yields
  // NOT_FOUND). The admin never sees or sets the password — a single-use reset
  // link is emailed to the staff member, who chooses their own new password.
  resetMemberPassword = async (req, res) => {
    const tenantId = UsersController.requireTenantId(req);
    const member = await this.service.getMember(tenantId, req.params.membershipId);
    const user = await withPlatform(() => User.findById(member.userId));
    if (user) await issueResetForUser(user);
    sendNoContent(res);
  };

}
