import { AppError } from '../common/errors/AppError.js';
import { resolveDataScope } from '../modules/rbac/dataScope.js';

/**
 * Guards a route by permission key AND resolves the data scope that permission
 * was granted at.
 *
 * Blueprint §11.4: "Permissions with data scopes, checked before the handler
 * runs, re-checked at the database, and reflected in the interface — where the
 * interface is a convenience, never the boundary."
 *
 * The previous implementation checked only `permissions.has(key)` and discarded
 * the scope entirely, so `clients.read` at SELF and `clients.read` at
 * ORGANIZATION authorised exactly the same unfiltered query. Scope is now
 * carried on the token as `permScopes` and resolved into `req.dataScope`, which
 * every downstream repository filters on.
 *
 * `req.dataScope` shape: { scope, staffProfileId, clientIds|null, staffIds|null }
 * where `null` means tenant-wide.
 *
 * Must run AFTER enterTenantContext — scope resolution reads tenant-owned models.
 */
export function requirePermission(key) {
  return async (req, _res, next) => {
    const p = req.principal;
    if (!p) return next(AppError.unauthorized());
    if (!p.permissions?.has(key)) {
      return next(AppError.forbidden('AUTH-403', `Missing permission: ${key}`));
    }
    try {
      const scope = p.permissionScopes?.get?.(key) ?? 'ORGANIZATION';
      req.dataScope = await resolveDataScope(p, scope);
      req.permissionPath = { key, scope }; // recorded on the audit record (§9.8)
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Variant that authorises when the principal holds ANY of the listed keys, and
 * resolves scope from the widest one held. Used where one screen is reachable
 * by several roles (a dashboard, a search).
 */
export function requireAnyPermission(...keys) {
  const RANK = { SELF: 1, TEAM: 2, ORGANIZATION: 3, PLATFORM: 4 };
  return async (req, _res, next) => {
    const p = req.principal;
    if (!p) return next(AppError.unauthorized());
    const held = keys.filter((k) => p.permissions?.has(k));
    if (held.length === 0) {
      return next(AppError.forbidden('AUTH-403', `Missing permission: ${keys.join(' | ')}`));
    }
    try {
      let bestKey = held[0];
      let best = p.permissionScopes?.get?.(bestKey) ?? 'ORGANIZATION';
      for (const k of held) {
        const s = p.permissionScopes?.get?.(k) ?? 'ORGANIZATION';
        if ((RANK[s] ?? 0) > (RANK[best] ?? 0)) { best = s; bestKey = k; }
      }
      req.dataScope = await resolveDataScope(p, best);
      req.permissionPath = { key: bestKey, scope: best };
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
