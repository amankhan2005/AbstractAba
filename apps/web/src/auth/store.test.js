import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import { useAuthStore } from './store';

vi.mock('@/api/client', () => ({
  signIn: vi.fn(),
  fetchMe: vi.fn(),
  signOut: vi.fn(),
  setAccessToken: vi.fn(),
  clearSessionHint: vi.fn(),
  restoreSession: vi.fn(),
  hasRestorableSession: vi.fn(),
}));

const signIn = vi.mocked(client.signIn);
const fetchMe = vi.mocked(client.fetchMe);
const setAccessToken = vi.mocked(client.setAccessToken);
const restoreSession = vi.mocked(client.restoreSession);
const hasRestorableSession = vi.mocked(client.hasRestorableSession);

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ status: 'unknown', principal: null, error: null });
});

describe('tenant auth store sign-in', () => {
  it('authenticates a tenant member and stores the token', async () => {
    signIn.mockResolvedValue({ status: 'OK', accessToken: 'tok', activeTenantId: 't-1' });
    fetchMe.mockResolvedValue({ userId: 'u-1', activeTenantId: 't-1', isPlatformOperator: false });
    await useAuthStore.getState().signIn('user@clinic.test', 'secret');
    const state = useAuthStore.getState();
    expect(state.status).toBe('authenticated');
    expect(state.principal?.userId).toBe('u-1');
    expect(setAccessToken).toHaveBeenCalledWith('tok');
  });

  it('rejects a platform operator and discards the token', async () => {
    signIn.mockResolvedValue({ status: 'OK', accessToken: 'tok', activeTenantId: null });
    fetchMe.mockResolvedValue({ userId: 'op-1', activeTenantId: null, isPlatformOperator: true });
    await useAuthStore.getState().signIn('ops@aba1on1.test', 'secret');
    const state = useAuthStore.getState();
    expect(state.status).toBe('unauthenticated');
    expect(state.error).toMatch(/not a member of an organization/i);
    expect(setAccessToken).toHaveBeenLastCalledWith(null);
  });

  it('reports a failed sign-in without leaking a token', async () => {
    signIn.mockRejectedValue(new Error('bad credentials'));
    await useAuthStore.getState().signIn('user@clinic.test', 'wrong');
    expect(useAuthStore.getState().status).toBe('unauthenticated');
    expect(useAuthStore.getState().error).toMatch(/sign-in failed/i);
  });

  it('surfaces an unfinished (MFA) outcome as a clear message', async () => {
    signIn.mockResolvedValue({ status: 'MFA_REQUIRED' });
    await useAuthStore.getState().signIn('user@clinic.test', 'secret');
    expect(useAuthStore.getState().status).toBe('unauthenticated');
    expect(useAuthStore.getState().error).toMatch(/additional verification/i);
  });

  // REGRESSION — staff login "not a member of an organization".
  // Authentication succeeds (200 + token) but the principal carries NO
  // activeTenantId, which is exactly what happens when the user has no ACTIVE
  // membership (the historical INVITED-membership bug). The store must surface
  // the not-a-member message — this is the symptom we fixed at the source by
  // provisioning staff with an ACTIVE membership.
  it('rejects a signed-in user with no active membership as not-a-member', async () => {
    signIn.mockResolvedValue({ status: 'OK', accessToken: 'tok', activeTenantId: null });
    fetchMe.mockResolvedValue({ userId: 'u-1', activeTenantId: null, isPlatformOperator: false });
    await useAuthStore.getState().signIn('bcba@clinic.test', 'secret');
    const state = useAuthStore.getState();
    expect(state.status).toBe('unauthenticated');
    expect(state.error).toMatch(/not a member of an organization/i);
    expect(setAccessToken).toHaveBeenLastCalledWith(null);
  });

  // A correctly provisioned BCBA/RBT: authentication succeeds AND the principal
  // resolves an activeTenantId (their ACTIVE membership), so they are a member.
  // mustChangePassword is carried through so the app can force the first-login
  // change — it does NOT block membership/authentication.
  it('authenticates a provisioned staff member whose membership resolves (with forced first-login change)', async () => {
    signIn.mockResolvedValue({ status: 'OK', accessToken: 'tok', activeTenantId: 't-1' });
    fetchMe.mockResolvedValue({ userId: 'bcba-1', activeTenantId: 't-1', isPlatformOperator: false, mustChangePassword: true });
    await useAuthStore.getState().signIn('bcba@clinic.test', 'Temp0RaryPass');
    const state = useAuthStore.getState();
    expect(state.status).toBe('authenticated');
    expect(state.principal?.activeTenantId).toBe('t-1');
    expect(state.principal?.mustChangePassword).toBe(true);
  });
});

describe('tenant auth store bootstrap', () => {
  it('restores a remembered tenant session', async () => {
    hasRestorableSession.mockReturnValue(true);
    restoreSession.mockResolvedValue(true);
    fetchMe.mockResolvedValue({ userId: 'u-1', activeTenantId: 't-1', isPlatformOperator: false });
    await useAuthStore.getState().bootstrap();
    expect(useAuthStore.getState().status).toBe('authenticated');
  });

  it('ends unauthenticated when the remembered session is no longer valid', async () => {
    hasRestorableSession.mockReturnValue(true);
    restoreSession.mockResolvedValue(true);
    fetchMe.mockRejectedValue(new Error('401'));
    await useAuthStore.getState().bootstrap();
    expect(useAuthStore.getState().status).toBe('unauthenticated');
  });

  // REGRESSION — the `GET /v1/auth/me 401` on every cold page load.
  //
  // bootstrap() used to call fetchMe() unconditionally, before anything had
  // read the remembered refresh token out of localStorage. On a visit with no
  // session that produced a guaranteed 401 in the browser console, and on a
  // visit WITH a remembered session it produced a 401 followed by a recovery —
  // which is why refreshing the page appeared to log people out.
  //
  // The contract now: with nothing to restore, resolve to 'unauthenticated'
  // without touching the network at all.
  it('makes no request at all when there is no restorable session', async () => {
    hasRestorableSession.mockReturnValue(false);
    await useAuthStore.getState().bootstrap();
    expect(fetchMe).not.toHaveBeenCalled();
    expect(restoreSession).not.toHaveBeenCalled();
    expect(useAuthStore.getState().status).toBe('unauthenticated');
  });

  it('restores the session BEFORE identifying the user', async () => {
    const order = [];
    hasRestorableSession.mockReturnValue(true);
    restoreSession.mockImplementation(async () => { order.push('restore'); return true; });
    fetchMe.mockImplementation(async () => {
      order.push('me');
      return { userId: 'u-1', activeTenantId: 't-1', isPlatformOperator: false };
    });
    await useAuthStore.getState().bootstrap();
    expect(order).toEqual(['restore', 'me']);
  });
});

describe('tenant auth bootstrap — StrictMode safety', () => {
  it('single-flights concurrent bootstraps so restore runs at most once', async () => {
    // A restorable session, so the restore path is genuinely exercised. Two
    // concurrent restores would each rotate the refresh token and trip the
    // API's reuse detection, revoking a valid session.
    hasRestorableSession.mockReturnValue(true);
    restoreSession.mockResolvedValue(true);
    fetchMe.mockResolvedValue({ userId: 'u-1', activeTenantId: 't-1', isPlatformOperator: false });
    useAuthStore.setState({ status: 'unknown', principal: null, error: null });

    await Promise.all([
      useAuthStore.getState().bootstrap(),
      useAuthStore.getState().bootstrap(),
    ]);

    expect(restoreSession).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().status).toBe('authenticated');
  });
});
