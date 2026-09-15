import { AppError } from '../../common/errors/AppError.js';

const STATUS = {
  DOCUMENT_NOT_FOUND: 404,
  ORG_NOT_ACTIVE: 409,
  VERSION_CONFLICT: 409,
  DOCUMENT_FINALIZED: 409,
  INVALID_STATUS_TRANSITION: 409,
  ALREADY_SUPERSEDED: 409,
  CLIENT_INVALID: 422,
  TENANT_CONTEXT_MISSING: 500,
};
const DEFAULT = {
  DOCUMENT_NOT_FOUND: 'Clinical document not found',
  ORG_NOT_ACTIVE: 'Clinical documents can only be changed while the organization is active.',
  VERSION_CONFLICT: 'This record changed since you loaded it. Reload and try again.',
  DOCUMENT_FINALIZED: 'A finalized document cannot be modified.',
  INVALID_STATUS_TRANSITION: 'That document status change is not allowed.',
  ALREADY_SUPERSEDED: 'This document has already been superseded.',
  CLIENT_INVALID: 'A clinical document must reference an existing client.',
  TENANT_CONTEXT_MISSING: 'Tenant context missing',
};

export function documentsError(code, { message, context, details } = {}) {
  return new AppError(code, {
    status: STATUS[code] ?? 400,
    message: message ?? DEFAULT[code] ?? code,
    ...(context ? { context } : {}),
    ...(details ? { details } : {}),
  });
}
