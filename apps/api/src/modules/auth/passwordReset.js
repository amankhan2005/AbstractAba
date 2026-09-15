import crypto from 'node:crypto';
import { channelTransports } from '../notifications/index.js';
import { env } from '../../config/env.js';
import { User } from '../../models/index.js';
import { withPlatform } from '../../tenancy/tenantContext.js';
import { renderBrandedEmail } from '../../common/email/layout.js';
import { PLATFORM_BRAND } from '@aba1on1/schemas';

const PRODUCT_NAME = PLATFORM_BRAND.productName;

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

// Same construction as invitation tokens (base64url random + sha256 hash), inlined
// here to avoid a circular import with the users module.
export function hashResetToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function isResetExpired(expiresAt, now = Date.now()) {
  return !expiresAt || new Date(expiresAt).getTime() < now;
}

function issueToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashResetToken(token) };
}

/**
 * Issue a single-use, expiring password-reset token for an ACTIVE user and email
 * the secure link. Only the sha256 hash is stored; the raw token never appears in
 * a response, a log, or the record. Shared by the public forgot-password flow and
 * the admin-initiated staff reset — one mechanism, no duplication. Best-effort
 * email: a delivery failure never throws to the caller (and never reveals account
 * state).
 */
export async function issueResetForUser(user) {
  if (!user || user.status !== 'ACTIVE') return;
  const { token, tokenHash } = issueToken();
  user.passwordResetTokenHash = tokenHash;
  user.passwordResetExpiresAt = new Date(Date.now() + RESET_TTL_MS);
  await withPlatform(() => user.save());
  try {
    const transport = channelTransports.get('email');
    if (!transport) return;
    const link = `${env.webAppUrl}/reset-password/${encodeURIComponent(token)}`;
    const text =
      `We received a request to reset your ${PRODUCT_NAME} password.\n\n` +
      `Use the secure link below (valid for 1 hour, single use):\n\n${link}\n\n` +
      'If you did not request this, you can safely ignore this email — your password will not change.';
    const html = renderBrandedEmail({
      preheader: `Reset your ${PRODUCT_NAME} password — this link is valid for 1 hour.`,
      heading: 'Reset your password',
      intro: [`We received a request to reset your ${PRODUCT_NAME} password. Choose a new password using the secure button below.`],
      cta: { label: 'Reset password', url: link },
      noticeTitle: 'Didn’t request this?',
      notice: [
        'This link is valid for 1 hour and can only be used once.',
        'If you did not request a password reset, you can safely ignore this email — your password will not change.',
      ],
    });
    // The transport port reads message.recipientEmail + message.view (same as
    // the staff-welcome and company-invitation handlers). Passing {to,subject}
    // at the top level silently failed under the Resend transport.
    await transport.send({
      recipientUserId: null,
      recipientEmail: user.email,
      to: user.email,
      subject: `Reset your ${PRODUCT_NAME} password`,
      text,
      view: { subject: `Reset your ${PRODUCT_NAME} password`, link, body: text, html },
    });
  } catch { /* never reveal account state via delivery outcome */ }
}

/** Resolve a user by a raw reset token, enforcing hash match + expiry. */
export async function findUserByResetToken(rawToken) {
  const user = await withPlatform(() => User.findOne({ passwordResetTokenHash: hashResetToken(rawToken) }));
  if (!user || isResetExpired(user.passwordResetExpiresAt)) return null;
  return user;
}
