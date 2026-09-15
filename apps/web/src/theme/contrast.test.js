import { describe, expect, it } from 'vitest';
import { BRAND_DEFAULTS, NEUTRAL_INK, NEUTRAL_PAPER, SAFE_ACCENTS, SEMANTIC_PALETTE } from '@aba1on1/schemas';

/**
 * Contrast matrix — Blueprint §6.14b. Every accent in every scheme, and every
 * semantic foreground on its surface, is verified to meet WCAG AA (4.5:1).
 * Conformance is a property of the token set, checked on the client
 * independently of the server. Ported verbatim.
 */
const WHITE = NEUTRAL_PAPER;
const NEAR_BLACK = NEUTRAL_INK;

function luminance(hex) {
  const n = hex.replace('#', '');
  const channel = (h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(n.slice(0, 2)) + 0.7152 * channel(n.slice(2, 4)) + 0.0722 * channel(n.slice(4, 6));
}
function contrast(a, b) {
  const la = luminance(a); const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function accessibleForeground(background) {
  return contrast(background, WHITE) >= contrast(background, NEAR_BLACK) ? WHITE : NEAR_BLACK;
}

describe('contrast matrix', () => {
  it('every accent in both schemes reaches 4.5:1 with its accessible foreground', () => {
    for (const [name, pair] of Object.entries(SAFE_ACCENTS)) {
      for (const scheme of ['light', 'dark']) {
        const bg = pair[scheme];
        expect(contrast(bg, accessibleForeground(bg)), `${name} ${scheme}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it('every semantic foreground reaches 4.5:1 on its surface in both schemes', () => {
    for (const [state, token] of Object.entries(SEMANTIC_PALETTE)) {
      for (const scheme of ['light', 'dark']) {
        expect(contrast(token.foreground[scheme], token.surface[scheme]), `${state} ${scheme}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it('brand defaults carry accessible foregrounds', () => {
    for (const role of [BRAND_DEFAULTS.primary, BRAND_DEFAULTS.secondary]) {
      for (const scheme of ['light', 'dark']) {
        expect(contrast(role[scheme], accessibleForeground(role[scheme]))).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
