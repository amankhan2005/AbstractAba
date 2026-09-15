import { AppError } from '../../common/errors/AppError.js';

const STATUS = {
  STAFF_NOT_FOUND: 404,
  STAFF_PROVISIONING_UNAVAILABLE: 503,
  STAFF_ALREADY_ACTIVATED: 409,
  CREDENTIAL_NOT_FOUND: 404,
  SUPERVISION_NOT_FOUND: 404,
  ORG_NOT_ACTIVE: 409,
  VERSION_CONFLICT: 409,
  DUPLICATE_STAFF: 409,
  SELF_SUPERVISION: 422,
  DUPLICATE_SUPERVISION: 409,
  TENANT_CONTEXT_MISSING: 500,
};
const DEFAULT = {
  STAFF_NOT_FOUND: 'Staff member not found',
  STAFF_PROVISIONING_UNAVAILABLE: 'Staff provisioning is temporarily unavailable.',
  STAFF_ALREADY_ACTIVATED: 'That staff member has already completed their first login. Use Reset Password instead.',
  CREDENTIAL_NOT_FOUND: 'Credential not found',
  SUPERVISION_NOT_FOUND: 'Supervision link not found',
  ORG_NOT_ACTIVE: 'Staff records can only be changed while the organization is active.',
  VERSION_CONFLICT: 'This record changed since you loaded it. Reload and try again.',
  DUPLICATE_STAFF: 'This user already has a staff profile.',
  SELF_SUPERVISION: 'A staff member cannot supervise themselves.',
  DUPLICATE_SUPERVISION: 'That supervision relationship already exists.',
  TENANT_CONTEXT_MISSING: 'Tenant context missing',
};
export function staffError(code, { message, context, details } = {}) {
  return new AppError(code, {
    status: STATUS[code] ?? 400,
    message: message ?? DEFAULT[code] ?? code,
    ...(context ? { context } : {}),
    ...(details ? { details } : {}),
  });
}
