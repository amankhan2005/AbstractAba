import { z } from 'zod';
import { authService, publicUser } from './auth.service.js';
import { User, Organization } from '../../models/index.js';
import { withPlatform } from '../../tenancy/tenantContext.js';
import { AppError } from '../../common/errors/AppError.js';
import { sendSuccess, sendNoContent } from '../../common/http/responder.js';
import { hashPassword, verifyPassword, assertAcceptablePassword } from '../../utils/password.js';
import { issueResetForUser, findUserByResetToken } from './passwordReset.js';
import { setRefreshCookie, clearRefreshCookie, readRefreshToken, usedCookieTransport } from './refreshCookie.js';

export const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export const mfaSchema = z.object({
  userId: z.string().uuid(),
  code: z.string().min(6).max(8),
});
// The refresh token now travels in a hardened httpOnly cookie. The body field
// stays OPTIONAL rather than being deleted so an already-open tab, and the
// console until it ships the cookie flow, keep working through the transition.
export const refreshSchema = z.object({ refreshToken: z.string().min(10).optional() });
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10).max(200),
});

export const forgotPasswordSchema = z.object({ email: z.string().email() });
export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  newPassword: z.string().min(10).max(200),
});

function ctxOf(req) {
  return { userAgent: req.headers['user-agent'] ?? null, ipAddress: req.ip ?? null };
}

export async function signIn(req, res) {
  const result = await authService.signIn({ ...req.body, ...ctxOf(req) });
  setRefreshCookie(res, result.refreshToken);
  sendSuccess(res, result);
}

export async function verifyMfa(req, res) {
  const result = await authService.verifyMfa({ ...req.body, ...ctxOf(req) });
  setRefreshCookie(res, result.refreshToken);
  sendSuccess(res, result);
}

export async function refresh(req, res) {
  const presented = readRefreshToken(req);
  if (!presented) throw AppError.unauthorized('AUTH-401', 'Your session has expired. Please sign in again.');

  const cookieTransport = usedCookieTransport(req);
  const result = await authService.refresh(presented, ctxOf(req));

  // Rotation: the new token replaces the old one in the cookie immediately, so
  // a rotated-away token can never be replayed from the browser.
  setRefreshCookie(res, result.refreshToken);

  // When the client used the cookie it never needs to see the token again —
  // withholding it removes the only remaining way for a script to read it.
  sendSuccess(res, cookieTransport
    ? { accessToken: result.accessToken }
    : { accessToken: result.accessToken, refreshToken: result.refreshToken });
}

export async function signOut(req, res) {
  const presented = readRefreshToken(req);
  // Clear the cookie regardless of whether a token was presented: signing out
  // must always leave the browser with no session, even if the token was
  // already revoked, expired, or never sent.
  clearRefreshCookie(res);
  if (presented) await authService.signOut(presented);
  sendNoContent(res);
}

export async function me(req, res) {
  const user = await withPlatform(() => User.findById(req.principal.userId).lean());
  if (!user) throw AppError.unauthorized('AUTH-401', 'User not found');
  const shaped = publicUser({ ...user, _id: user._id });
  // Whether the caller's active company is currently usable. A tenant user whose
  // organization has been deactivated (any non-ACTIVE state) still holds a valid
  // session — the backend blocks their protected actions — so the web app reads
  // this flag to show a friendly "unavailable" screen instead of a raw error.
  // Null for platform operators and for sessions with no active tenant.
  let organizationActive = null;
  let organizationTimezone = null;
  if (!user.isPlatformOperator && req.principal.activeTenantId) {
    const org = await withPlatform(() =>
      Organization.findById(req.principal.activeTenantId).select('state timezone').lean());
    organizationActive = org ? org.state === 'ACTIVE' : false;
    // USA product: business date/times are presented in the organization's
    // configured timezone, never blindly in the browser's (spec Phase 1 §4).
    organizationTimezone = org?.timezone ?? null;
  }
  sendSuccess(res, {
    // Flat operator fields the console reads (userId, isPlatformOperator),
    // alongside the full principal used by the tenant app.
    userId: shaped.id,
    isPlatformOperator: !!user.isPlatformOperator,
    user: shaped,
    // Top-level convenience flag: forces the web app to route to the change-
    // password step on first login after a temporary-password provisioning.
    mustChangePassword: !!user.mustChangePassword,
    activeTenantId: req.principal.activeTenantId,
    organizationActive,
    organizationTimezone,
    roles: req.principal.roleKeys,
    permissions: [...req.principal.permissions],
    // The scope each permission was granted at. The sidebar and the in-page
    // controls need this to render the same view the API will actually serve:
    // a technician holding clients.read at SELF must not be offered a
    // "All clients" screen the server will answer with their own three.
    // The interface is a convenience, never the boundary (blueprint 11.4).
    permissionScopes: Object.fromEntries(req.principal.permissionScopes ?? []),
  });
}

/**
 * Self-service profile update (spec §14). The authenticated user edits their
 * own display name only. Identity comes from the token (req.principal.userId),
 * NEVER from the body — a user can only ever edit themselves. Email is immutable
 * here: the body cannot carry it, and this handler never writes it. The User
 * model stores a single fullName, so first/last name compose it.
 */
export const updateMeSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
  })
  .strict();

export async function updateMe(req, res) {
  const { firstName, lastName } = req.body;
  const user = await withPlatform(() => User.findById(req.principal.userId));
  if (!user) throw AppError.unauthorized('AUTH-401', 'User not found');
  user.fullName = `${firstName} ${lastName}`.trim();
  user.updatedBy = req.principal.userId;
  await withPlatform(() => user.save());
  sendSuccess(res, publicUser({ ...user.toObject(), _id: user._id }));
}

export async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body;
  const user = await withPlatform(() => User.findById(req.principal.userId));
  if (!user) throw AppError.unauthorized('AUTH-401', 'User not found');

  const ok = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) throw AppError.validation('Current password is incorrect.', { fieldErrors: { currentPassword: ['Incorrect password'] } });

  // Enforce the same policy used elsewhere (min length, not containing identity).
  assertAcceptablePassword(newPassword, { email: user.email, fullName: user.fullName });

  user.passwordHash = await hashPassword(newPassword);
  user.passwordUpdatedAt = new Date();
  // Completing a password change satisfies the forced-change gate and marks
  // first login complete (so admin sees "First login: Completed" and Resend
  // Login Email is no longer offered).
  user.mustChangePassword = false;
  if (!user.firstLoginAt) user.firstLoginAt = new Date();
  await withPlatform(() => user.save());
  sendNoContent(res);
}



/**
 * Public: request a password reset. Always returns 204 whether or not the email
 * exists (no account enumeration). For an ACTIVE user, a single-use, expiring
 * token is issued (only its hash is stored) and emailed via the shared transport.
 */
export async function requestPasswordReset(req, res) {
  const { email } = req.body;
  const user = await withPlatform(() => User.findOne({ email: String(email).toLowerCase() }));
  if (user) await issueResetForUser(user);
  sendNoContent(res);
}

/**
 * Public: consume a reset token and set a new password. Validates the token by
 * hash + expiry, enforces the password policy, hashes the new password, and
 * clears the reset fields so the token is single-use.
 */
export async function resetPassword(req, res) {
  const { token, newPassword } = req.body;
  const user = await findUserByResetToken(token);
  if (!user) throw AppError.validation('This reset link is invalid or has expired.', { fieldErrors: { token: ['Invalid or expired'] } });
  assertAcceptablePassword(newPassword, { email: user.email, fullName: user.fullName });
  user.passwordHash = await hashPassword(newPassword);
  user.passwordUpdatedAt = new Date();
  user.mustChangePassword = false; // a completed reset also clears the forced-change gate
  if (!user.firstLoginAt) user.firstLoginAt = new Date();
  user.passwordResetTokenHash = null; // single-use
  user.passwordResetExpiresAt = null;
  await withPlatform(() => user.save());
  sendNoContent(res);
}
