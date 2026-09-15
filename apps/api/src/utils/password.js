import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { env } from '../config/env.js';

export async function hashPassword(plain) {
  return bcrypt.hash(plain, env.bcryptRounds);
}
export async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

/**
 * Generate a random, policy-compliant temporary password SERVER-SIDE. Used only
 * for staff onboarding: it is hashed immediately, delivered once via the secure
 * welcome email, and never stored in plaintext, returned in an API response, or
 * logged. It draws from an unambiguous alphabet (no 0/O/1/l/I) and guarantees at
 * least one lower, upper and digit so it clears assertAcceptablePassword and is
 * easy to type from an email. Length 14 comfortably exceeds the 10-char minimum.
 */
export function generateTemporaryPassword() {
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digit = '23456789';
  const all = lower + upper + digit;
  const pick = (set) => set[crypto.randomInt(set.length)];
  const chars = [pick(lower), pick(upper), pick(digit)];
  while (chars.length < 14) chars.push(pick(all));
  // Fisher–Yates shuffle so the guaranteed classes aren't always in front.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * Minimum password policy, ported in intent from the original PasswordService.
 * Rejects passwords that are too short/long or that echo the account's email or
 * name. Reused by the invitation-accept flow so a first password is held to the
 * same standard as a reset.
 */
export function assertAcceptablePassword(password, context = {}) {
  const errors = [];
  if (typeof password !== 'string' || password.length < 10) {
    errors.push('Use at least 10 characters');
  }
  if (password.length > 200) errors.push('That password is too long');
  const lower = password.toLowerCase();
  if (context.email && lower.includes(String(context.email).toLowerCase().split('@')[0])) {
    errors.push('Do not include your email in your password');
  }
  if (context.fullName && lower.includes(String(context.fullName).toLowerCase())) {
    errors.push('Do not include your name in your password');
  }
  if (errors.length > 0) {
    const err = new Error(errors[0]);
    err.code = 'WEAK_PASSWORD';
    err.status = 422;
    err.details = errors.map((message) => ({ path: 'password', message }));
    throw err;
  }
}
