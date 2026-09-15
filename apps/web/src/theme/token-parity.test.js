import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAND_DEFAULTS, SAFE_ACCENTS, SEMANTIC_PALETTE } from '@aba1on1/schemas';

/**
 * Token parity — the anti-drift guarantee. The stylesheet carries literal hex
 * (it is static CSS); the shared contract carries the same values for server and
 * client. This test makes the contract authoritative and the CSS a verified
 * mirror: every accent maps to the right hue per scheme, and every semantic and
 * brand-default value appears in the stylesheet. Ported verbatim.
 */
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'styles', 'global.css'), 'utf8').toLowerCase();

function present(hex) { return css.includes(hex.toLowerCase()); }

describe('token parity: accents map correctly per scheme', () => {
  for (const [accent, pair] of Object.entries(SAFE_ACCENTS)) {
    it(`${accent} maps to the right hue in light and dark`, () => {
      const light = new RegExp(`\\[data-accent='${accent}'\\]\\s*\\{[^}]*--color-accent:\\s*${pair.light.toLowerCase()}`);
      const dark = new RegExp(`\\[data-scheme='dark'\\]\\[data-accent='${accent}'\\]\\s*\\{[^}]*--color-accent:\\s*${pair.dark.toLowerCase()}`);
      expect(light.test(css), `${accent} light`).toBe(true);
      expect(dark.test(css), `${accent} dark`).toBe(true);
    });
  }
});

describe('token parity: semantic palette present', () => {
  for (const [state, token] of Object.entries(SEMANTIC_PALETTE)) {
    it(`${state} foreground and surface appear in both schemes`, () => {
      expect(present(token.foreground.light), `${state} fg light`).toBe(true);
      expect(present(token.foreground.dark), `${state} fg dark`).toBe(true);
      expect(present(token.surface.light), `${state} surface light`).toBe(true);
      expect(present(token.surface.dark), `${state} surface dark`).toBe(true);
    });
  }
});

describe('token parity: brand defaults present', () => {
  it('primary and secondary appear in both schemes', () => {
    for (const role of [BRAND_DEFAULTS.primary, BRAND_DEFAULTS.secondary]) {
      expect(present(role.light)).toBe(true);
      expect(present(role.dark)).toBe(true);
    }
  });
});
