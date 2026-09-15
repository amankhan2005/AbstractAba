import { AppError } from '../../common/errors/AppError.js';

/** Error codes for user & role management (names preserved from the original enum). */
const STATUS = {
  TENANT_RESOURCE_NOT_FOUND: 404,
  USER_ALREADY_MEMBER: 409,
  INVITATION_INVALID: 400,
  ILLEGAL_STATE_TRANSITION: 409,
  MEMBERSHIP_STATUS_INVALID: 409,
  LAST_ACTIVE_OWNER: 409,
  SELF_MEMBERSHIP_MODIFICATION: 403,
  ROLE_NOT_FOUND: 404,
  ROLE_NOT_ASSIGNABLE: 409,
  DUPLICATE_STAFF_EMAIL: 409,
  STAFF_ALREADY_ACTIVATED: 409,
  TENANT_CONTEXT_MISSING: 500,
};
const DEFAULT = {
  TENANT_RESOURCE_NOT_FOUND: 'Not found',
  INVITATION_INVALID: 'That invitation link is not valid',
  ROLE_NOT_FOUND: 'Role not found',
  ROLE_NOT_ASSIGNABLE: 'That role cannot be assigned',
  LAST_ACTIVE_OWNER: 'An organization must keep at least one active owner.',
  SELF_MEMBERSHIP_MODIFICATION: 'You cannot change your own membership.',
  DUPLICATE_STAFF_EMAIL: 'An account already exists for that email address.',
  STAFF_ALREADY_ACTIVATED: 'That staff member has already completed their first login.',
};
export function usersError(code, { message, context, details } = {}) {
  return new AppError(code, {
    status: STATUS[code] ?? 400,
    message: message ?? DEFAULT[code] ?? code,
    ...(context ? { context } : {}),
    ...(details ? { details } : {}),
  });
}
