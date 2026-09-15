import { User, Membership, MembershipRole, Role } from '../../models/index.js';
import { withPlatform, withTenant } from '../../tenancy/tenantContext.js';
import { verifyPassword } from '../../utils/password.js';
import { decryptField } from '../../utils/crypto.js';
import { MfaFactor } from '../../models/index.js';
import { AppError } from '../../common/errors/AppError.js';
import { tokenService } from './token.service.js';
import { verifyTotp } from './totp.js';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

/**
 * Resolve the role keys a user holds within a tenant. Runs inside withTenant()
 * so membership/role reads are tenant-isolated by the plugin.
 */
export async function resolveRoleKeys(userId, tenantId) {
  if (!tenantId) return [];
  return withTenant(tenantId, async () => {
    const membership = await Membership.findOne({ userId, status: 'ACTIVE' }).lean();
    if (!membership) return [];
    const links = await MembershipRole.find({ membershipId: membership._id }).lean();
    if (links.length === 0) return [];
    const roles = await Role.find({ _id: { $in: links.map((l) => l.roleId) } }).lean();
    return roles.map((r) => r.key);
  });
}

export class AuthService {
  /**
   * Password sign-in. Enforces per-account lockout, then either completes the
   * sign-in or returns an MFA challenge. Response shape and lockout policy
   * mirror the original auth module.
   */
  async signIn({ email, password, userAgent, ipAddress }) {
    return withPlatform(async () => {
      const user = await User.findOne({ email: email.toLowerCase() });
      // Uniform failure: never reveal whether the address exists.
      const invalid = () => new AppError('AUTH-401', { status: 401, message: 'Invalid credentials' });

      if (!user) {
        // Spend comparable time to avoid a timing oracle.
        await verifyPassword(password, '$2a$12$0000000000000000000000000000000000000000000000000000');
        throw invalid();
      }
      if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
        throw new AppError('AUTH-423', { status: 423, message: 'Account temporarily locked' });
      }
      if (user.status !== 'ACTIVE') throw new AppError('AUTH-403', { status: 403, message: 'Account not active' });

      const ok = await verifyPassword(password, user.passwordHash);
      if (!ok) {
        user.failedLoginAttempts += 1;
        if (user.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
          user.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
          user.failedLoginAttempts = 0;
        }
        await user.save();
        throw invalid();
      }

      user.failedLoginAttempts = 0;
      user.lockedUntil = null;
      user.lastLoginAt = new Date();
      // Record the first successful authentication (used for the admin "First
      // login" status). Cleared-to-false mustChangePassword happens when the
      // member actually changes the temp password.
      if (!user.firstLoginAt) user.firstLoginAt = new Date();
      await user.save();

      // MFA gate.
      const factors = await MfaFactor.find({ userId: user._id, deletedAt: null, verifiedAt: { $ne: null } }).lean();
      if (factors.length > 0) {
        return { status: 'MFA_REQUIRED', userId: user._id, methods: factors.map((f) => f.type) };
      }
      return this._complete(user, { userAgent, ipAddress });
    });
  }

  /** Complete an MFA-gated sign-in by verifying a TOTP code. */
  async verifyMfa({ userId, code, userAgent, ipAddress }) {
    return withPlatform(async () => {
      const user = await User.findById(userId);
      if (!user || user.status !== 'ACTIVE') throw AppError.unauthorized('AUTH-401', 'Invalid MFA session');
      const factor = await MfaFactor.findOne({ userId, type: 'TOTP', deletedAt: null, verifiedAt: { $ne: null } });
      if (!factor) throw AppError.unauthorized('AUTH-401', 'No MFA factor');

      const secret = decryptField(factor.secretCiphertext);
      const matched = verifyTotp(secret, code);
      if (matched === null || String(matched) === factor.lastUsedCounter) {
        throw AppError.unauthorized('AUTH-401', 'Invalid MFA code');
      }
      factor.lastUsedCounter = String(matched);
      factor.lastUsedAt = new Date();
      await factor.save();
      return this._complete(user, { userAgent, ipAddress });
    });
  }

  async _complete(user, ctx) {
    if (user.isPlatformOperator) {
      // Operators sign in with NO tenant context (checked before membership).
      const tokens = await tokenService.issueSession(user, { activeTenantId: null, roleKeys: [], ...ctx });
      return { status: 'OK', user: publicUser(user), activeTenantId: null, ...tokens };
    }
    // A tenant user's active tenant is their (single, for Phase 1) active membership.
    const activeTenantId = await this._defaultTenantFor(user._id);
    const roleKeys = activeTenantId ? await resolveRoleKeys(user._id, activeTenantId) : [];
    const tokens = await tokenService.issueSession(user, { activeTenantId, roleKeys, ...ctx });
    return { status: 'OK', user: publicUser(user), activeTenantId, ...tokens };
  }

  async _defaultTenantFor(userId) {
    // Memberships are tenant-owned; finding "which tenants" for a user is a
    // platform question answered by scanning memberships across tenants. This
    // is one of the few deliberate cross-tenant reads and runs at platform
    // scope. A production build narrows this with a user→tenant index.
    return withPlatform(async () => {
      // Uses the model under platform scope (not the raw driver): the tenant
      // plugin bypasses its filter under withPlatform(), giving the same
      // cross-tenant result through the guarded path — no raw-collection bypass.
      const membership = await Membership.findOne({ userId, status: 'ACTIVE' }).lean();
      return membership ? membership.tenantId : null;
    });
  }

  /**
   * Establish an authenticated session for an already-verified, ACTIVE user by
   * email — the auto-login path used after invitation onboarding completes and
   * the owner's organization is activated. It reuses the EXACT session issuance
   * sign-in uses (_complete → tokenService.issueSession), so the access token,
   * tenant context, role keys and rotating refresh token are identical to a
   * normal login. No password is checked: the caller (the onboarding accept
   * flow) has just created this owner account itself, so there are no
   * credentials to present. It refuses to mint a session for a missing or
   * non-ACTIVE account rather than fabricating one — a failure here surfaces to
   * the caller, which then asks the owner to sign in manually.
   */
  async establishSessionForEmail(email, ctx = {}) {
    const user = await withPlatform(async () => User.findOne({ email: String(email).toLowerCase() }));
    if (!user || user.status !== 'ACTIVE') {
      throw AppError.unauthorized('AUTH-401', 'Cannot establish a session for this account.');
    }
    return this._complete(user, ctx);
  }

  async refresh(rawRefresh, ctx) {
    const result = await tokenService.refresh(rawRefresh, { ...ctx, resolveRoleKeys });
    if (!result.ok) throw AppError.unauthorized('AUTH-401', `Refresh rejected: ${result.reason}`);
    return result;
  }

  async signOut(rawRefresh) {
    await tokenService.revoke(rawRefresh, 'SIGNED_OUT');
  }
}

export function publicUser(user) {
  return {
    id: user._id,
    email: user.email,
    fullName: user.fullName,
    isPlatformOperator: !!user.isPlatformOperator,
    status: user.status,
    // Forces the client to route to a change-password step on first login after
    // a temporary-password provisioning. Non-secret; safe to expose.
    mustChangePassword: !!user.mustChangePassword,
  };
}

export const authService = new AuthService();
