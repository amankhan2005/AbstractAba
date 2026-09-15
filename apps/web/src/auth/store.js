import { create } from 'zustand';
import { fetchMe, setAccessToken, signIn as apiSignIn, signOut as apiSignOut, clearSessionHint, restoreSession, hasRestorableSession, markSessionEstablished } from '@/api/client';
import { canAccessApp } from './access';
import { setDefaultTimeZone } from '@/lib/format';

const NOT_TENANT_MEMBER = 'This account is not a member of an organization.';
const SIGN_IN_FAILED = 'Sign-in failed. Check your credentials and try again.';
const MFA_REQUIRED = 'Additional verification is required and is not yet available here.';

/**
 * Resolves the authenticated state from a freshly-fetched principal. A tenant
 * user whose company has been deactivated still holds a valid session (the
 * backend blocks their protected actions), so instead of a raw error the UI
 * shows a friendly "company unavailable" screen. `organizationActive` comes from
 * /auth/me; only false (an explicit deactivation) routes to that screen, so a
 * platform operator or a null value still lands in the app normally.
 */
export function resolveAuthState(principal) {
  if (!canAccessApp(principal)) {
    return { status: 'unauthenticated', principal: null, error: NOT_TENANT_MEMBER };
  }
  if (principal.organizationActive === false) {
    return { status: 'company-unavailable', principal, error: null };
  }
  return { status: 'authenticated', principal, error: null };
}

// Single-flight guard for bootstrap() so React StrictMode's double mount cannot
// launch two concurrent session restores (which can revoke each other's token).
let bootstrapPromise = null;

/**
 * Holds the tenant user's session. The access token lives in the API client's
 * memory, not here and not in storage; this store holds only the derived
 * principal and the status the UI renders. Every transition ends in a definite
 * status so the route guard never has to guess. Structured after the console's
 * auth store, adapted to the tenant access rule.
 *
 * NOTE (real contract): the API sign-in endpoint returns { status: 'OK' | ... }.
 * This store keys on that status field directly. The console's store keys on an
 * `outcome` field that the live endpoint does not emit; that is a pre-existing
 * console seam left untouched here (Phase 1 is frozen) and is called out in the
 * Step 1 report.
 */
export const useAuthStore = create((set, get) => ({
  status: 'unknown',
  principal: null,
  error: null,

  async signIn(email, password, remember = false) {
    // Single-flight: a sign-in already in progress ignores concurrent submits,
    // so a rapid double-click (or two callers) produces exactly ONE request and
    // one coherent state transition — never a duplicate session.
    if (get().status === 'authenticating') return;
    set({ status: 'authenticating', error: null });
    try {
      const result = await apiSignIn(email, password);

      // An unfinished (e.g. MFA) outcome resolves without an access token; surface
      // it as a distinct message rather than a generic failure.
      if (result?.status !== 'OK' || !result.accessToken) {
        set({ status: 'unauthenticated', principal: null, error: MFA_REQUIRED });
        return;
      }

      setAccessToken(result.accessToken);
      // The refresh token is an httpOnly cookie set by the server; the client
      // neither reads nor stores it. `remember` is retained in the signature
      // for the sign-in form's checkbox and is a server-side decision about
      // cookie persistence rather than something this store can enforce.
      void remember;
      const principal = await fetchMe();

      const next = resolveAuthState(principal);
      if (next.status === 'unauthenticated') setAccessToken(null);
      set(next);
    } catch {
      setAccessToken(null);
      set({ status: 'unauthenticated', principal: null, error: SIGN_IN_FAILED });
    }
  },

  /**
   * Adopt a session the server just established out-of-band (the onboarding
   * auto-login path). The access token arrives in the accept response and the
   * rotating refresh token is already set as an httpOnly cookie, so this mirrors
   * the tail of signIn(): hold the token in memory, mark the session restorable,
   * identify the user, and enforce the same tenant-access rule. Returns true on
   * success so the caller can route into the Company Panel; on any failure it
   * clears state and returns false so the caller falls back to "please sign in"
   * rather than pretending the user is authenticated.
   */
  async adoptSession(accessToken) {
    if (!accessToken) return false;
    try {
      setAccessToken(accessToken);
      markSessionEstablished();
      const principal = await fetchMe();
      const next = resolveAuthState(principal);
      if (next.status === 'unauthenticated') { setAccessToken(null); clearSessionHint(); set(next); return false; }
      set(next);
      return true;
    } catch {
      setAccessToken(null);
      clearSessionHint();
      set({ status: 'unauthenticated', principal: null, error: SIGN_IN_FAILED });
      return false;
    }
  },

  async signOut() {
    try {
      await apiSignOut();
    } catch {
      /* clearing local state regardless */
    }
    setAccessToken(null);
    clearSessionHint();
    set({ status: 'unauthenticated', principal: null, error: null });
  },

  /**
   * Re-reads /auth/me and adopts it when anything changed — e.g. the company's
   * timezone was updated by a Company Admin while this session was open. A
   * failed read leaves the current session untouched (never signs out).
   */
  async refreshPrincipal() {
    const principal = await fetchMe();
    const current = get().principal;
    if (!current || JSON.stringify(principal) === JSON.stringify(current)) return current;
    set(resolveAuthState(principal));
    return principal;
  },

  /**
   * Adopt the organization timezone the SERVER just confirmed (the PATCH
   * /v1/organization response), so formatting switches immediately — before
   * the follow-up /auth/me read. Never called with an unconfirmed value.
   */
  applyOrganizationTimezone(timeZone) {
    const current = get().principal;
    if (!current || !timeZone || current.organizationTimezone === timeZone) return;
    set({ principal: { ...current, organizationTimezone: timeZone } });
  },

  async bootstrap() {
    // StrictMode mounts effects twice in development; two concurrent bootstraps
    // can each trigger a refresh and trip refresh-token reuse detection, revoking
    // a valid session. Single-flight the whole bootstrap so it runs once.
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => {
      // ORDER MATTERS. Previously this called fetchMe() first, which on a cold
      // load ran with no access token AND no refresh token yet loaded from
      // storage — producing a guaranteed `GET /v1/auth/me 401` in the console on
      // every single page refresh, and no refresh attempt to recover from it.
      //
      // Now: establish whether a session is restorable at all (a pure local
      // read, no request), restore it, and only then identify the user. A
      // visitor with nothing to restore resolves straight to 'unauthenticated'
      // without touching the network, so the login screen never flashes an
      // error the user did not cause.
      try {
        if (!hasRestorableSession()) {
          set({ status: 'unauthenticated', principal: null });
          return;
        }

        // An access token already in memory (same tab, post-sign-in) is used as
        // is; otherwise exchange the remembered refresh token for a fresh one.
        await restoreSession();

        const principal = await fetchMe();
        if (canAccessApp(principal)) {
          set(resolveAuthState(principal));
          return;
        }
      } catch {
        /* the remembered session is no longer valid */
      }
      // Anything left behind is stale — clear it so the next load is a clean
      // 'no session' rather than another doomed restore attempt.
      setAccessToken(null);
      clearSessionHint();
      set({ status: 'unauthenticated', principal: null });
    })().finally(() => { bootstrapPromise = null; });
    return bootstrapPromise;
  },
}));

// Clock times render in the organization's timezone even where a caller does not
// pass one (lib/format.js). Kept in step with the principal on every change.
setDefaultTimeZone(useAuthStore.getState().principal?.organizationTimezone ?? null);
useAuthStore.subscribe((state, prev) => {
  const tz = state.principal?.organizationTimezone ?? null;
  if (tz !== (prev?.principal?.organizationTimezone ?? null)) setDefaultTimeZone(tz);
});

/**
 * The authenticated organization's IANA timezone (from /auth/me). Business
 * date/times are presented in this zone — never blindly the browser's (Phase 1
 * §4). Returns null for platform operators or before the principal loads;
 * callers pass it to formatTime/formatDateTime, which fall back to a plain
 * USA-formatted local render when it is null.
 */
export function useOrgTimezone() {
  return useAuthStore((s) => s.principal?.organizationTimezone ?? null);
}
