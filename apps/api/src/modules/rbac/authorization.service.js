import { SYSTEM_ROLE_TEMPLATES, PLATFORM_OPERATOR_GRANTS } from './roleTemplates.js';
import { isKnownPermission, PERMISSION_CATALOGUE } from './permissionCatalogue.js';

/**
 * Resolves the effective permission set for a principal.
 *
 * A tenant principal's permissions are the union of its role templates. A
 * platform operator's are the PLATFORM grants, held by virtue of
 * isPlatformOperator with no tenant role. Resolution is pure and in-memory —
 * the templates are code — so no database round-trip is needed to authorize a
 * request, exactly as in the original engine.
 */
export class AuthorizationService {
  /** @param {{ roleKeys?: string[], isPlatformOperator?: boolean }} principal */
  resolvePermissions(principal) {
    if (principal.isPlatformOperator) {
      return new Map(PLATFORM_OPERATOR_GRANTS.map((g) => [g.key, g.scope]));
    }
    const resolved = new Map();
    for (const roleKey of principal.roleKeys ?? []) {
      const grants = SYSTEM_ROLE_TEMPLATES[roleKey];
      if (!grants) continue;
      for (const g of grants) {
        // Widest scope wins when the same key is granted by multiple roles.
        const existing = resolved.get(g.key);
        if (!existing || scopeRank(g.scope) > scopeRank(existing)) resolved.set(g.key, g.scope);
      }
    }
    return resolved;
  }

  /** Does the principal hold `key` at any scope? */
  can(principal, key) {
    if (!isKnownPermission(key)) return false;
    return this.resolvePermissions(principal).has(key);
  }

  /**
   * The full permission catalogue as reference metadata, enriched with the
   * module (derived from the key prefix), a humanised description, and the
   * platform-only flag. Same for every caller. Mirrors the original catalogue()
   * read shape (key, module, description, scopes, platformOnly).
   */
  catalogue() {
    return PERMISSION_CATALOGUE.map((p) => ({
      key: p.key,
      module: p.key.split('.')[0],
      description: p.key.replace(/\./g, ' ').replace(/_/g, ' '),
      scopes: [p.scope],
      platformOnly: p.scope === 'PLATFORM',
    }));
  }

  /** Resolve a principal's effective permissions (alias mirroring the original). */
  resolveEffectivePermissions(principal) {
    return this.resolvePermissions(principal);
  }

  /**
   * The permissions a system role template holds, or null if the role key is
   * not a known system role. Returns [{ key, scope }].
   */
  rolePermissions(roleKey) {
    const grants = SYSTEM_ROLE_TEMPLATES[roleKey];
    if (!grants) return null;
    return grants.map((g) => ({ key: g.key, scope: g.scope }));
  }
}

/** Flattens a resolved permission Map into a sorted [{ key, scope }] list. */
export function toResolvedList(map) {
  return [...map.entries()]
    .map(([key, scope]) => ({ key, scope }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

const SCOPE_ORDER = { SELF: 1, TEAM: 2, ORGANIZATION: 3, PLATFORM: 4 };
function scopeRank(scope) {
  return SCOPE_ORDER[scope] ?? 0;
}

export const authorizationService = new AuthorizationService();
