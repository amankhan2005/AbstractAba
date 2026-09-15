import { verifyAccessToken } from '../utils/jwt.js';
import { AppError } from '../common/errors/AppError.js';
import { User } from '../models/index.js';
import { withPlatform } from '../tenancy/tenantContext.js';

/**
 * When true (default), every authenticated request re-checks the token's
 * permissions-version (pv) against the user's current permissionsVersion, so a
 * role or permission change invalidates outstanding access tokens immediately
 * rather than at token expiry. Disabled only in unit contexts with no database.
 */
let enforcePvFreshness = true;
export function setPvFreshnessEnforcement(on) { enforcePvFreshness = on; }

/** Reads the user's current permissionsVersion (platform-scoped). */
async function currentPermissionsVersion(userId) {
  return withPlatform(async () => {
    const row = await User.findById(userId).select({ permissionsVersion: 1, status: 1 }).lean();
    return row ? { pv: row.permissionsVersion ?? 0, status: row.status } : null;
  });
}

/**
 * Verifies the Bearer access token, attaches `req.principal`, and enforces pv
 * freshness. Does NOT enter tenant context — that stays tenantContext.js's job,
 * so the ordering (authenticate → tenant → authorize) is explicit.
 */
export async function authenticate(req, _res, next) {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  // User-facing wording. "Missing bearer token" is an accurate description of
  // the HTTP problem and a useless one to a clinician: it names a mechanism
  // they have never heard of and tells them nothing to do. The CODE stays
  // AUTH-401 for logs and for the web client's refresh interceptor, which keys
  // off the status rather than the prose.
  if (scheme !== 'Bearer' || !token) {
    return next(AppError.unauthorized('AUTH-401', 'Your session has expired. Please sign in again.'));
  }

  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch {
    return next(AppError.unauthorized('AUTH-401', 'Your session has expired. Please sign in again.'));
  }

  req.principal = {
    userId: claims.sub,
    activeTenantId: claims.ten ?? null,
    roleKeys: claims.roles ?? [],
    isPlatformOperator: !!claims.ops,
    permissionsVersion: claims.pv,
    permissions: new Set(claims.perms ?? []),
    // key -> 'SELF' | 'TEAM' | 'ORGANIZATION' | 'PLATFORM'. Tokens issued before
    // this field existed fall back to ORGANIZATION only for keys the role
    // genuinely holds, which is the pre-existing behaviour, so a rolling deploy
    // never widens access beyond what the old token already carried.
    permissionScopes: new Map(Object.entries(claims.scopes ?? {})),
  };

  if (enforcePvFreshness) {
    try {
      const current = await currentPermissionsVersion(claims.sub);
      if (current === null || current.status === 'DISABLED') {
        return next(AppError.unauthorized('AUTH-401', 'Account is no longer active'));
      }
      if (claims.pv !== undefined && current.pv !== claims.pv) {
        // A permission-changing op bumped pv since this token was issued.
        return next(AppError.unauthorized('AUTH-401', 'Your access changed; please sign in again'));
      }
    } catch (err) {
      return next(err);
    }
  }
  return next();
}
