import { create } from 'zustand';
import {
  fetchMe,
  setAccessToken,
  signIn as apiSignIn,
  signOut as apiSignOut,
  clearSessionHint,
  restoreSession,
  hasRestorableSession,
} from '@/api/client';
import { canAccessConsole } from './access';

const NOT_OPERATOR = 'This account is not a platform operator.';
const SIGN_IN_FAILED = 'Sign-in failed. Check your credentials and try again.';
const MFA_REQUIRED = 'Additional verification is required and is not yet available in the console.';

// Single-flight guard so StrictMode's double mount can't launch two restores.
let bootstrapPromise = null;

/**
 * Holds the operator session. The access token lives in the API client's memory,
 * not here and not in storage; this store holds only the derived principal and
 * status the UI renders. Every transition ends in a definite status so the route
 * guard never has to guess. Ported verbatim from the original.
 */
export const useAuthStore = create((set) => ({
  status: 'unknown',
  principal: null,
  error: null,

  async signIn(email, password, remember = false) {
  set({ status: 'authenticating', error: null });

  try {
    const result = await apiSignIn(email, password);

    // An unfinished (e.g. MFA) outcome resolves without an access token; surface
    // it as a distinct message rather than a generic failure. The API returns
    // status 'OK' with an accessToken on success, or 'MFA_REQUIRED' (no token)
    // when a second factor is needed.
    if (result.status !== 'OK' || !result.accessToken) {
      set({
        status: 'unauthenticated',
        principal: null,
        error: MFA_REQUIRED,
      });
      return;
    }

    setAccessToken(result.accessToken);

    // The refresh token is an httpOnly cookie set by the server; the console
    // neither reads nor stores it. `remember` is kept in the signature for the
    // sign-in form and is a server-side cookie-persistence decision.
    void remember;

    const principal = await fetchMe();

    if (!canAccessConsole(principal)) {
      setAccessToken(null);

      set({
        status: 'unauthenticated',
        principal: null,
        error: NOT_OPERATOR,
      });

      return;
    }

    set({
      status: 'authenticated',
      principal,
      error: null,
    });

  } catch (err) {
    setAccessToken(null);

    set({
      status: 'unauthenticated',
      principal: null,
      error: SIGN_IN_FAILED,
    });
  }
},

  async signOut() {
    try { await apiSignOut(); } catch { /* clearing local state regardless */ }
    setAccessToken(null);
    clearSessionHint();
    set({ status: 'unauthenticated', principal: null, error: null });
  },

  async bootstrap() {
    // Single-flight: React StrictMode mounts effects twice in development, and
    // two concurrent restores can each rotate the refresh token, tripping reuse
    // detection and revoking a valid operator session. Run bootstrap once.
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => {
      // ORDER MATTERS. This used to call fetchMe() first, unconditionally,
      // producing a guaranteed `GET /auth/me 401` on every cold load before any
      // session had been restored. Establish restorability locally (no
      // request), restore from the cookie, then identify.
      try {
        if (!hasRestorableSession()) {
          set({ status: 'unauthenticated', principal: null });
          return;
        }

        await restoreSession();

        const principal = await fetchMe();
        if (canAccessConsole(principal)) {
          set({ status: 'authenticated', principal, error: null });
          return;
        }
      } catch { /* the remembered operator session is no longer valid */ }

      setAccessToken(null);
      clearSessionHint();
      set({ status: 'unauthenticated', principal: null });
    })().finally(() => { bootstrapPromise = null; });
    return bootstrapPromise;
  },
}));
