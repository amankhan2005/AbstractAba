import { describe, expect, it } from 'vitest';
import { PREFERENCE_DEFAULTS } from '@aba1on1/schemas';
import { resolvePreferences, resolveScheme, toDataAttributes } from './appearance';

describe('resolveScheme', () => {
  it('follows the device when set to auto', () => {
    expect(resolveScheme('auto', true)).toBe('dark');
    expect(resolveScheme('auto', false)).toBe('light');
  });
  it('honours an explicit choice regardless of the device', () => {
    expect(resolveScheme('light', true)).toBe('light');
    expect(resolveScheme('dark', false)).toBe('dark');
  });
});

describe('resolvePreferences', () => {
  it('fills unset keys from the platform defaults', () => {
    expect(resolvePreferences({ accent: 'violet' })).toEqual({ ...PREFERENCE_DEFAULTS, accent: 'violet' });
  });
});

describe('toDataAttributes', () => {
  it('maps defaults to attributes, resolving auto against the device', () => {
    const attrs = toDataAttributes({}, true);
    expect(attrs.scheme).toBe('dark');
    // The shipped default accent is orchid (the client brand palette).
    expect(attrs.accent).toBe('orchid');
    expect(attrs.contrast).toBe('normal');
    expect(attrs.motion).toBe('full');
  });
  it('expresses high contrast and reduced motion as their own attributes', () => {
    const attrs = toDataAttributes({ highContrast: true, reducedMotion: true }, false);
    expect(attrs.contrast).toBe('high');
    expect(attrs.motion).toBe('reduced');
  });
  it('never emits a semantic token', () => {
    const attrs = toDataAttributes({ accent: 'plum' }, false);
    expect(Object.keys(attrs)).not.toContain('approved');
    expect(Object.keys(attrs)).not.toContain('state');
  });
});
