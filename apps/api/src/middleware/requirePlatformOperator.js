import { AppError } from '../common/errors/AppError.js';

/** The binary platform boundary: only isPlatformOperator principals pass. */
export function requirePlatformOperator(req, _res, next) {
  if (!req.principal?.isPlatformOperator) return next(AppError.forbidden('AUTH-403', 'Platform operator required'));
  return next();
}
