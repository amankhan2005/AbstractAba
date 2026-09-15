import { AuthSession, User } from '../../models/index.js';
import { withPlatform } from '../../tenancy/tenantContext.js';
import { newId } from '../../utils/id.js';
import { sha256Hex, randomToken } from '../../utils/crypto.js';
import { signAccessToken } from '../../utils/jwt.js';
import { authorizationService } from '../rbac/authorization.service.js';
import { env } from '../../config/env.js';

/**
 * Session/token issuance, rotation, and reuse detection. AuthSession is
 * platform-scoped, so all reads/writes run under withPlatform(). Only the
 * SHA-256 of a refresh token is stored — a leaked database yields no usable
 * tokens.
 */
export class TokenService {
  /** Issues a new refresh session (a new family) + access token. */
  async issueSession(user, { activeTenantId = null, roleKeys = [], userAgent = null, ipAddress = null } = {}) {
    return withPlatform(async () => {
      const familyId = newId();
      return this._createRotation(user, { familyId, activeTenantId, roleKeys, userAgent, ipAddress });
    });
  }

  async _createRotation(user, { familyId, activeTenantId, roleKeys, userAgent, ipAddress, replacedBySessionId = null }) {
    const rawRefresh = randomToken(32);
    const session = await AuthSession.create({
      _id: newId(),
      userId: user._id,
      familyId,
      tokenHash: sha256Hex(rawRefresh),
      activeTenantId,
      expiresAt: new Date(Date.now() + env.refreshTokenTtlSeconds * 1000),
      userAgent,
      ipAddress,
    });
    const accessToken = this._accessTokenFor(user, { activeTenantId, roleKeys });
    return { accessToken, refreshToken: rawRefresh, sessionId: session._id, familyId };
  }

  _accessTokenFor(user, { activeTenantId, roleKeys }) {
    const resolved = authorizationService.resolvePermissions({
      roleKeys,
      isPlatformOperator: user.isPlatformOperator,
    });
    // Carry BOTH the key and the scope it was granted at. Blueprint 4.1: a
    // permission without its scope is only half a permission, and the half
    // that was previously dropped is the half that keeps an RBT out of another
    // technician's caseload.
    return signAccessToken({
      sub: user._id,
      ten: activeTenantId,
      roles: roleKeys,
      ops: !!user.isPlatformOperator,
      pv: user.permissionsVersion,
      perms: [...resolved.keys()],
      scopes: Object.fromEntries(resolved),
    });
  }

  /**
   * Refresh with rotation + reuse detection. If the presented token is unknown
   * or already revoked, the whole family is revoked (REUSE_DETECTED) and the
   * refresh is rejected — the exact defence from the original.
   */
  async refresh(rawRefresh, { userAgent = null, ipAddress = null, resolveRoleKeys } = {}) {
    return withPlatform(async () => {
      const tokenHash = sha256Hex(rawRefresh);
      const session = await AuthSession.findOne({ tokenHash });

      if (!session) return { ok: false, reason: 'unknown' };

      if (session.revokedAt) {
        // A revoked token presented again is a replay: burn the family.
        await AuthSession.updateMany(
          { familyId: session.familyId, revokedAt: null },
          { $set: { revokedAt: new Date(), revokedReason: 'REUSE_DETECTED' } },
        );
        return { ok: false, reason: 'reuse_detected' };
      }
      if (session.expiresAt.getTime() < Date.now()) {
        await AuthSession.updateOne({ _id: session._id }, { $set: { revokedAt: new Date(), revokedReason: 'EXPIRED' } });
        return { ok: false, reason: 'expired' };
      }

      const user = await User.findById(session.userId);
      if (!user || user.status !== 'ACTIVE') return { ok: false, reason: 'user_inactive' };

      const roleKeys = resolveRoleKeys ? await resolveRoleKeys(user._id, session.activeTenantId) : [];
      const rotated = await this._createRotation(user, {
        familyId: session.familyId,
        activeTenantId: session.activeTenantId,
        roleKeys,
        userAgent,
        ipAddress,
      });
      await AuthSession.updateOne(
        { _id: session._id },
        { $set: { revokedAt: new Date(), revokedReason: 'ROTATED', replacedBySessionId: rotated.sessionId } },
      );
      return { ok: true, ...rotated };
    });
  }

  async revoke(rawRefresh, reason = 'SIGNED_OUT') {
    return withPlatform(async () => {
      const tokenHash = sha256Hex(rawRefresh);
      await AuthSession.updateOne({ tokenHash, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } });
    });
  }

  async revokeAllForUser(userId, reason = 'PASSWORD_CHANGED') {
    return withPlatform(async () => {
      await AuthSession.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } });
    });
  }
}

export const tokenService = new TokenService();
