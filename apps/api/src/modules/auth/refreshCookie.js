import { env } from '../../config/env.js';

/**
 * ---------------------------------------------------------------------------
 * REFRESH TOKEN TRANSPORT — hardened cookie.
 *
 * Blueprint 9.1: "Short-lived access token carrying user, tenant, role and a
 * permissions version; long-lived rotating refresh token stored in a hardened
 * cookie."
 *
 * Before this module the API returned the refresh token in the JSON body and
 * both SPAs kept it in localStorage, while the HTTP clients carried
 * `withCredentials: true` and a comment describing "the httpOnly refresh cookie
 * the API sets" — a cookie that did not exist. That is the single highest-value
 * security deviation in the codebase: a refresh token in localStorage is
 * readable by any script that reaches the page, so one compromised transitive
 * dependency yields a thirty-day session against a clinical system holding PHI.
 * The access token was already held in memory only, which makes the refresh
 * token the weakest link rather than a secondary concern.
 *
 * The cookie is:
 *   httpOnly  — unreadable from JavaScript, so XSS cannot exfiltrate it
 *   secure    — TLS only (production; off in dev, where the cookie would
 *               otherwise never be stored over plain http)
 *   sameSite  — 'lax' by default, blocking the CSRF shape that a bare
 *               credentialed POST would otherwise allow
 *   path      — scoped to the auth routes, so it is not attached to every
 *               request in the application; it travels only where it is used
 *   maxAge    — matched to the refresh token's own TTL, so the browser forgets
 *               it at the same moment the server does
 *
 * BACKWARD COMPATIBILITY. `readRefreshToken` accepts the cookie first and falls
 * back to the request body. That keeps the console, any already-open tab, and
 * the API's own tests working through the transition rather than logging every
 * active user out on deploy. The body path is deprecated and is the one to
 * remove once both clients have shipped.
 * ---------------------------------------------------------------------------
 */

/** The auth routes are the only place the refresh cookie is ever needed. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

function baseCookieOptions() {
  const opts = {
    httpOnly: true,
    secure: env.refreshCookieSecure,
    sameSite: env.refreshCookieSameSite,
    path: REFRESH_COOKIE_PATH,
  };
  if (env.refreshCookieDomain) opts.domain = env.refreshCookieDomain;
  return opts;
}

/**
 * Writes the rotating refresh token to the hardened cookie.
 * Called on sign-in, on MFA completion, and on every refresh (rotation).
 */
export function setRefreshCookie(res, token) {
  if (!token) return;
  res.cookie(env.refreshCookieName, token, {
    ...baseCookieOptions(),
    maxAge: env.refreshTokenTtlSeconds * 1000,
  });
}

/**
 * Clears the cookie on sign-out. The attributes must match those used to set
 * it or the browser keeps the original — a classic "sign-out did nothing" bug.
 */
export function clearRefreshCookie(res) {
  res.clearCookie(env.refreshCookieName, baseCookieOptions());
}

/**
 * Resolves the presented refresh token: cookie first, request body second.
 * Returns null when neither carries one.
 */
export function readRefreshToken(req) {
  const fromCookie = req.cookies?.[env.refreshCookieName];
  if (typeof fromCookie === 'string' && fromCookie.length >= 10) return fromCookie;
  const fromBody = req.body?.refreshToken;
  if (typeof fromBody === 'string' && fromBody.length >= 10) return fromBody;
  return null;
}

/**
 * Did the token arrive in the cookie? When it did, the response body omits the
 * refresh token entirely — there is no reason to hand a client a value it
 * cannot store safely and no longer needs.
 */
export function usedCookieTransport(req) {
  const fromCookie = req.cookies?.[env.refreshCookieName];
  return typeof fromCookie === 'string' && fromCookie.length >= 10;
}
