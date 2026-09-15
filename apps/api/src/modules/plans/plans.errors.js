import { AppError } from '../../common/errors/AppError.js';

const STATUS = {
  PLAN_NOT_FOUND: 404,
  GOAL_NOT_FOUND: 404,
  PROGRAM_NOT_FOUND: 404,
  TARGET_NOT_FOUND: 404,
  ORG_NOT_ACTIVE: 409,
  VERSION_CONFLICT: 409,
  CLIENT_NOT_ACTIVE: 422,
  BCBA_INVALID: 422,
  PLAN_ARCHIVED: 409,
  PLAN_TRANSITION_INVALID: 422,
  TENANT_CONTEXT_MISSING: 500,
};
const DEFAULT = {
  PLAN_NOT_FOUND: 'Treatment plan not found',
  GOAL_NOT_FOUND: 'Goal not found',
  PROGRAM_NOT_FOUND: 'Program not found',
  TARGET_NOT_FOUND: 'Target not found',
  ORG_NOT_ACTIVE: 'Clinical plans can only be changed while the organization is active.',
  VERSION_CONFLICT: 'This record changed since you loaded it. Reload and try again.',
  CLIENT_NOT_ACTIVE: 'Only active clients may have a treatment plan.',
  BCBA_INVALID: 'The responsible BCBA must be an active staff member.',
  PLAN_ARCHIVED: 'An archived plan cannot be modified.',
  PLAN_TRANSITION_INVALID: 'That plan status change is not allowed.',
  TENANT_CONTEXT_MISSING: 'Tenant context missing',
};
export function plansError(code, { message, context, details } = {}) {
  return new AppError(code, {
    status: STATUS[code] ?? 400,
    message: message ?? DEFAULT[code] ?? code,
    ...(context ? { context } : {}),
    ...(details ? { details } : {}),
  });
}
