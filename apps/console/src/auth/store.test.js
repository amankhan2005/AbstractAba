import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import { useAuthStore } from './store';

vi.mock('@/api/client', () => ({
  signIn: vi.fn(), fetchMe: vi.fn(), signOut: vi.fn(), setAccessToken: vi.fn(),
  clearSessionHint: vi.fn(), restoreSession: vi.fn(), hasRestorableSession: vi.fn(),
}));

const signIn = vi.mocked(client.signIn);
const fetchMe = vi.mocked(client.fetchMe);
const setAccessToken = vi.mocked(client.setAccessToken);

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ status: 'unknown', principal: null, error: null });
});

describe('auth store sign-in', () => {
  it('authenticates a platform operator and stores the token', async () => {
    signIn.mockResolvedValue({ status: 'OK', accessToken: 'tok' });
    fetchMe.mockResolvedValue({ userId: 'op-1', isPlatformOperator: true });
    await useAuthStore.getState().signIn('ops@aba1on1.test', 'secret');
    const state = useAuthStore.getState();
    expect(state.status).toBe('authenticated');
    expect(state.principal?.userId).toBe('op-1');
    expect(setAccessToken).toHaveBeenCalledWith('tok');
  });

  it('rejects a non-operator and discards the token', async () => {
    signIn.mockResolvedValue({ status: 'OK', accessToken: 'tok' });
    fetchMe.mockResolvedValue({ userId: 'u-1', isPlatformOperator: false });
    await useAuthStore.getState().signIn('user@clinic.test', 'secret');
    const state = useAuthStore.getState();
    expect(state.status).toBe('unauthenticated');
    expect(state.error).toMatch(/not a platform operator/i);
    expect(setAccessToken).toHaveBeenLastCalledWith(null);
  });

  it('reports a failed sign-in without leaking a token', async () => {
    signIn.mockRejectedValue(new Error('bad credentials'));
    await useAuthStore.getState().signIn('ops@aba1on1.test', 'wrong');
    expect(useAuthStore.getState().status).toBe('unauthenticated');
    expect(useAuthStore.getState().error).toMatch(/sign-in failed/i);
  });

  it('surfaces an unfinished (MFA) outcome as a clear message', async () => {
    signIn.mockResolvedValue({ status: 'MFA_REQUIRED' });
    await useAuthStore.getState().signIn('ops@aba1on1.test', 'secret');
    expect(useAuthStore.getState().status).toBe('unauthenticated');
    expect(useAuthStore.getState().error).toMatch(/additional verification/i);
  });
});

describe('refresh-token transport', () => {
  // REGRESSION — the console used to persist the operator's refresh token to
  // localStorage under `aba1on1.console.refresh`. On the Super Admin surface,
  // for which the blueprint mandates MFA for all users and stricter session
  // limits (5.4), that put a long-lived platform credential within reach of any
  // script on the page. The token is now an httpOnly cookie the client can
  // neither read nor write.
  it('never handles a refresh token, whatever the remember flag says', async () => {
    signIn.mockResolvedValue({ status: 'OK', accessToken: 'tok', refreshToken: 'r-1' });
    fetchMe.mockResolvedValue({ userId: 'op-1', isPlatformOperator: true, user: { fullName: 'A', email: 'a@b.co' } });

    await useAuthStore.getState().signIn('a@b.co', 'pw', true);
    expect(useAuthStore.getState().status).toBe('authenticated');

    // Only the access token is ever handed to the client; the refresh token in
    // the response is deliberately ignored.
    expect(setAccessToken).toHaveBeenCalledWith('tok');
    expect(setAccessToken).not.toHaveBeenCalledWith('r-1');
  });

  it('signing out clears the local hint as well as the server session', async () => {
    vi.mocked(client.signOut).mockResolvedValue(undefined);
    await useAuthStore.getState().signOut();
    expect(vi.mocked(client.clearSessionHint)).toHaveBeenCalled();
    expect(setAccessToken).toHaveBeenLastCalledWith(null);
    expect(useAuthStore.getState().status).toBe('unauthenticated');
  });
});

describe('console bootstrap ordering', () => {
  it('makes no request when there is no restorable operator session', async () => {
    vi.mocked(client.hasRestorableSession).mockReturnValue(false);
    await useAuthStore.getState().bootstrap();
    expect(fetchMe).not.toHaveBeenCalled();
    expect(vi.mocked(client.restoreSession)).not.toHaveBeenCalled();
    expect(useAuthStore.getState().status).toBe('unauthenticated');
  });

  it('restores from the cookie before identifying the operator', async () => {
    const order = [];
    vi.mocked(client.hasRestorableSession).mockReturnValue(true);
    vi.mocked(client.restoreSession).mockImplementation(async () => { order.push('restore'); return true; });
    fetchMe.mockImplementation(async () => {
      order.push('me');
      return { userId: 'op-1', isPlatformOperator: true, user: { fullName: 'A', email: 'a@b.co' } };
    });
    await useAuthStore.getState().bootstrap();
    expect(order).toEqual(['restore', 'me']);
    expect(useAuthStore.getState().status).toBe('authenticated');
  });
});
