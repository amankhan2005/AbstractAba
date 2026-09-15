import { AppError } from '../../common/errors/AppError.js';

const STATUS = {
  TENANT_CONTEXT_MISSING: 500,
};
const DEFAULT = {
  TENANT_CONTEXT_MISSING: 'Tenant context missing',
};

/**
 * Dashboards are read-only aggregation endpoints — they create no entities and
 * mutate nothing, so the only domain error they raise is the missing-tenant
 * guard (the same shape every clinical module uses). Kept as its own factory for
 * consistency with the 7-file module architecture.
 */
export function dashboardsError(code, { message, context, details } = {}) {
  return new AppError(code, {
    status: STATUS[code] ?? 400,
    message: message ?? DEFAULT[code] ?? code,
    ...(context ? { context } : {}),
    ...(details ? { details } : {}),
  });
}
