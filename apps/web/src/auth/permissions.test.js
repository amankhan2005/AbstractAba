import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The distinction this hook exists to preserve:
 *
 *   auth still loading        ≠   authenticated with no permission
 *
 * Collapsing them is what hid every action button on Session Detail until the
 * page was reopened. `ready` tells them apart; `can()` stays false while loading
 * so an affordance never appears before we know it is allowed.
 */
const state = { status: 'authenticated', principal: { permissions: ['sessions.write'] } };
vi.mock('./store.js', () => ({ useAuthStore: (sel) => sel(state) }));

const { usePermissions } = await import('./permissions.js');
const setAuth = (next) => Object.assign(state, next);

beforeEach(() => setAuth({ status: 'authenticated', principal: { permissions: ['sessions.write'] } }));

describe('usePermissions', () => {
  it('reports NOT ready before the bootstrap resolves', () => {
    setAuth({ status: 'unknown', principal: null });
    const r = usePermissions();
    expect(r.ready).toBe(false);
    expect(r.can('sessions.write')).toBe(false);
  });

  it('reports NOT ready while authenticating', () => {
    setAuth({ status: 'authenticating', principal: null });
    expect(usePermissions().ready).toBe(false);
  });

  it('a loaded user WITHOUT the permission is ready and denied — not the same state', () => {
    setAuth({ status: 'authenticated', principal: { permissions: [] } });
    const r = usePermissions();
    expect(r.ready).toBe(true);            // ← the difference
    expect(r.can('sessions.write')).toBe(false);
  });

  it('a loaded user WITH the permission is ready and allowed', () => {
    const r = usePermissions();
    expect(r.ready).toBe(true);
    expect(r.can('sessions.write')).toBe(true);
    expect(r.can('sessions.review')).toBe(false);
  });

  it('returns a STABLE empty array for a null principal', () => {
    setAuth({ status: 'unknown', principal: null });
    expect(usePermissions().permissions).toBe(usePermissions().permissions);
  });

  it('treats an absent status as resolved, so stores that never modelled it behave as before', () => {
    setAuth({ status: undefined, principal: { permissions: ['sessions.write'] } });
    const r = usePermissions();
    expect(r.ready).toBe(true);
    expect(r.can('sessions.write')).toBe(true);
  });
});
