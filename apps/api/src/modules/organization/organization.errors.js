import { AppError } from '../../common/errors/AppError.js';

/**
 * Organization error codes. The original used a shared ErrorCode enum; the MERN
 * codebase uses string codes on AppError. We preserve the original code NAMES so
 * the machine-readable contract clients see is unchanged, and pin each to the
 * HTTP status the original catalogue assigned.
 */
export const ORG_ERROR_STATUS = {
  SLUG_INVALID: 422,
  SLUG_RESERVED: 422,
  SLUG_TAKEN: 409,
  ILLEGAL_STATE_TRANSITION: 409,
  AGREEMENT_REQUIRED: 422,
  DESTRUCTION_PRECONDITIONS_UNMET: 422,
  SAME_ACTOR_APPROVAL: 403,
  TENANT_RESOURCE_NOT_FOUND: 404,
  ORGANIZATION_NOT_ACTIVE: 409,
  NO_ACTIVE_MEMBERSHIP: 403,
  VERSION_CONFLICT: 409,
  TENANT_CONTEXT_MISSING: 500,
};

export function orgError(code, { message, context, details } = {}) {
  return new AppError(code, {
    status: ORG_ERROR_STATUS[code] ?? 400,
    message: message ?? DEFAULT_MESSAGE[code] ?? code,
    ...(context ? { context } : {}),
    ...(details ? { details } : {}),
  });
}

const DEFAULT_MESSAGE = {
  SLUG_INVALID: 'Use 3 to 40 lowercase letters, numbers or hyphens',
  SLUG_RESERVED: 'That name is reserved and cannot be used',
  SLUG_TAKEN: 'That name is already in use',
  ILLEGAL_STATE_TRANSITION: 'That lifecycle transition is not permitted',
  AGREEMENT_REQUIRED: 'An executed business associate agreement is required before activation',
  DESTRUCTION_PRECONDITIONS_UNMET: 'Destruction preconditions are not met',
  SAME_ACTOR_APPROVAL: 'The requester and approver of destruction must be different people',
  TENANT_RESOURCE_NOT_FOUND: 'Not found',
  ORGANIZATION_NOT_ACTIVE: 'The organization is not active',
  NO_ACTIVE_MEMBERSHIP: 'No active membership for that organization',
  VERSION_CONFLICT: 'The record changed since you read it; reload and retry',
  TENANT_CONTEXT_MISSING: 'Tenant context missing',
};
