import { AppError } from '../../common/errors/AppError.js';

const STATUS = { ILLEGAL_STATE_TRANSITION: 409, NOT_FOUND: 404, CONFLICT: 409, VALIDATION_FAILED: 422, INTERNAL: 500 };
export function onboardingError(code, { message, context, details } = {}) {
  return new AppError(code, {
    status: STATUS[code] ?? 400,
    message: message ?? code,
    ...(context ? { context } : {}),
    ...(details ? { details } : {}),
  });
}
