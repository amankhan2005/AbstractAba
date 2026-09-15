import { describe, expect, it } from 'vitest';
import { canAccessApp } from './access';

describe('tenant app access rule', () => {
  it('admits a signed-in tenant member with an active tenant', () => {
    expect(canAccessApp({ userId: 'u-1', activeTenantId: 't-1', isPlatformOperator: false })).toBe(true);
  });

  it('rejects a platform operator (their place is the console)', () => {
    expect(canAccessApp({ userId: 'op-1', activeTenantId: null, isPlatformOperator: true })).toBe(false);
  });

  it('rejects a principal without an active tenant', () => {
    expect(canAccessApp({ userId: 'u-2', activeTenantId: null, isPlatformOperator: false })).toBe(false);
  });

  it('rejects null / undefined', () => {
    expect(canAccessApp(null)).toBe(false);
    expect(canAccessApp(undefined)).toBe(false);
  });
});
