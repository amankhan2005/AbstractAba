import { AppError } from '../common/errors/AppError.js';
import { scopeAllowsClient, scopeAllowsStaff } from '../modules/rbac/dataScope.js';

/**
 * ---------------------------------------------------------------------------
 * BY-ID SCOPE ENFORCEMENT.
 *
 * A list endpoint that filters correctly proves nothing on its own: the record
 * is still reachable by identifier. The blueprint's isolation suite models this
 * exact probe across tenants ("attempts to read, update and delete tenant B's
 * records by identifier"), and the same probe works within a tenant against a
 * caseload boundary. Every by-id route therefore re-checks.
 *
 * NOT FOUND, NOT FORBIDDEN. A 403 confirms the record exists. Telling an
 * unassigned technician that client 4f2a is real, in this clinic, is itself a
 * disclosure — it leaks roster membership one probe at a time. The refusal is
 * indistinguishable from a genuinely absent record, and carries plain language
 * because the blueprint forbids surfacing codes and identifiers to users.
 *
 * The loader runs INSIDE tenant context (these middlewares mount after
 * enterTenantContext), so a record from another tenant is already invisible;
 * what is being decided here is the caseload boundary within one clinic.
 * ---------------------------------------------------------------------------
 */

const NOT_FOUND_MESSAGE = 'We couldn\u2019t find that record.';

/**
 * Guards a route whose subject is a client, identified by a route parameter.
 *
 * @param {string} paramName route param holding the client id
 */
export function requireClientInScope(paramName = 'clientId') {
  return (req, _res, next) => {
    const clientId = req.params?.[paramName];
    if (!clientId) return next();
    if (!scopeAllowsClient(req.dataScope, clientId)) {
      return next(AppError.notFound('CLIENT-404', 'We couldn\u2019t find that client.'));
    }
    return next();
  };
}

/**
 * Guards a route whose subject is a staff member.
 *
 * A technician reaching their own record is normal (their timesheet, their
 * availability); reaching a colleague's is not. A BCBA reaches their
 * supervisees. An administrator with tenant scope reaches everyone.
 */
export function requireStaffInScope(paramName = 'staffId') {
  return (req, _res, next) => {
    const staffId = req.params?.[paramName];
    if (!staffId) return next();
    if (!scopeAllowsStaff(req.dataScope, staffId)) {
      return next(AppError.notFound('STAFF-404', 'We couldn\u2019t find that staff member.'));
    }
    return next();
  };
}

/**
 * Guards a route whose subject is an arbitrary record that CARRIES a client
 * and/or staff reference — a session, an appointment, a treatment plan.
 *
 * `load(req)` returns `{ clientId?, staffProfileId? }` (or null when the record
 * does not exist). Reachable when EITHER dimension is in scope: a BCBA may open
 * a session because the client is on their caseload, or because a supervisee
 * delivered it.
 *
 * The loaded record is cached on `req.scopedRecord` so the handler need not
 * fetch it a second time.
 */
export function requireRecordInScope(load, { code = 'GEN-404', message = NOT_FOUND_MESSAGE } = {}) {
  return async (req, _res, next) => {
    try {
      const record = await load(req);
      if (!record) return next(AppError.notFound(code, message));

      const ds = req.dataScope;
      const clientOk = record.clientId !== undefined && scopeAllowsClient(ds, record.clientId);
      const staffOk = record.staffProfileId !== undefined && scopeAllowsStaff(ds, record.staffProfileId);

      // Tenant-wide scope short-circuits both checks above via the helpers.
      if (!clientOk && !staffOk) return next(AppError.notFound(code, message));

      req.scopedRecord = record;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
