import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

/**
 * Signs a short-lived access token. Claims mirror the original contract:
 * subject, active tenant, roles, permissions version, and the platform-operator
 * flag. Nothing sensitive travels in the token beyond identity + authz context.
 */
export function signAccessToken(claims) {
  return jwt.sign(claims, env.jwtAccessSecret, {
    algorithm: 'HS256',
    expiresIn: env.accessTokenTtlSeconds,
  });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, env.jwtAccessSecret, { algorithms: ['HS256'] });
}
