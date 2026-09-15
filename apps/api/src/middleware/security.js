import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

export const securityHeaders = helmet();

export const globalRateLimit = rateLimit({
  windowMs: env.rateLimitWindowMs,
  max: env.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
});

/** Tighter limit for auth endpoints — brute-force resistance. */
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});
