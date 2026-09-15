import { describe, expect, it } from 'vitest';
import { canAccessConsole } from './access';

describe('canAccessConsole', () => {
  it('denies an anonymous principal', () => { expect(canAccessConsole(null)).toBe(false); });
  it('denies a signed-in non-operator', () => { expect(canAccessConsole({ userId: 'u1', isPlatformOperator: false })).toBe(false); });
  it('allows a platform operator', () => { expect(canAccessConsole({ userId: 'u1', isPlatformOperator: true })).toBe(true); });
});
