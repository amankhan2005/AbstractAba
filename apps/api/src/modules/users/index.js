import crypto from 'node:crypto';
import { newId } from '../../utils/id.js';
import { hashPassword, assertAcceptablePassword } from '../../utils/password.js';
import { withPlatform } from '../../tenancy/tenantContext.js';
import { User, AuthSession } from '../../models/index.js';
import { organizationService } from '../organization/index.js';
import { UsersService } from './users.service.js';
import { usersRepository } from './users.repository.js';
import { createUsersRouters } from './users.routes.js';

/** How long an invitation stays valid (hours). */
export const INVITATION_TTL_HOURS = 72;

/**
 * Issues and hashes invitation tokens. The raw token is random and returned
 * once; only its SHA-256 digest is ever persisted, so a leaked database yields
 * no usable invitation links.
 */
export const invitationTokens = {
  issue() {
    const token = crypto.randomBytes(32).toString('base64url');
    return { token, tokenHash: invitationTokens.hash(token) };
  },
  hash(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  },
};

/**
 * Invalidates a user's issued access tokens after a permission-changing op:
 * bumps permissionsVersion (so outstanding access tokens fail the pv check) and
 * revokes their refresh-session family. Wired to the same tables authentication
 * owns, via a narrow port, so this module never reaches into auth internals.
 */
const tokenInvalidator = {
  async invalidate(userId) {
    await withPlatform(async () => {
      await User.updateOne({ _id: userId }, { $inc: { permissionsVersion: 1 } });
      await AuthSession.updateMany(
        { userId, revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: 'PERMISSIONS_CHANGED' } },
      );
    });
  },
};

/** Password policy + hashing, narrowed to what this module needs. */
const passwords = {
  assertAcceptable: (password, context) => assertAcceptablePassword(password, context ?? {}),
  hash: (password) => hashPassword(password),
};

export const usersService = new UsersService({
  repository: usersRepository,
  newId,
  passwords,
  tokens: invitationTokens,
  tokenInvalidator,
  organizations: { getById: (id) => organizationService.getById(id) },
  invitationTtlHours: INVITATION_TTL_HOURS,
});

export const usersRouters = createUsersRouters(usersService);

export { UsersService } from './users.service.js';
export { UsersController } from './users.controller.js';
export { usersRepository, SYSTEM_ROLES } from './users.repository.js';
export { passwords };
