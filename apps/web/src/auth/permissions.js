import { useAuthStore } from './store.js';

const EMPTY_PERMISSIONS = Object.freeze([]);

/**
 * The authenticated principal's permissions, together with whether the answer is
 * actually KNOWN yet.
 *
 * THE DEFECT THIS EXISTS TO PREVENT. `principal` is null until the auth
 * bootstrap resolves, so the widespread pattern
 *
 *     const permissions = useAuthStore((s) => s.principal?.permissions ?? []);
 *
 * silently reports "this user may do nothing" during that window. A screen that
 * gates its actions on it renders COMPLETELY but with every button missing, and
 * only looks right after a second navigation gives the store time to hydrate —
 * the "I have to open it twice" bug, proven on Session Detail. Loading is not
 * denial, and callers need to be able to tell the two apart.
 *
 * `can(key)` stays false while loading BY DESIGN: an affordance must not appear
 * before we know it is allowed. Callers gate their LOADING state on `ready`, and
 * their permission checks on `can`. Once `ready` is true, `can` behaves exactly
 * as the old pattern did.
 *
 * WHY THIS LIVES IN ITS OWN MODULE. Many tests mock '@/auth/store' wholesale.
 * Defining the hook there would force every one of those mocks to export it too,
 * which is how the first rollout attempt broke. Importing `useAuthStore` instead
 * means a mocked store transparently drives this hook, so the rollout needs no
 * per-file mock changes.
 *
 * The frozen empty array also keeps the reference stable, so a null principal no
 * longer hands subscribers a fresh array on every store update.
 */
export function usePermissions() {
  const status = useAuthStore((s) => s.status);
  const permissions = useAuthStore((s) => s.principal?.permissions) ?? EMPTY_PERMISSIONS;
  // A mocked store may not carry `status`; treat an absent status as resolved so
  // existing behaviour is unchanged where readiness was never modelled.
  const ready = status !== 'unknown' && status !== 'authenticating';
  return { permissions, ready, can: (key) => permissions.includes(key) };
}

export default usePermissions;
