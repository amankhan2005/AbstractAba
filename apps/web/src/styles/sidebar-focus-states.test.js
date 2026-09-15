import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * ---------------------------------------------------------------------------
 * SIDEBAR STATE SEPARATION — active vs hover vs focus.
 *
 * The reported bug was an unrelated navigation item carrying a persistent blue
 * glow. There are two distinct causes, and only fixing one leaves the bug:
 *
 *   1. TWO ROUTE-ACTIVE ROWS. A NavLink without `end` stays active on every
 *      nested route, so "/sessions" stayed lit on "/sessions/panel" alongside
 *      the child row. Covered by rbt-sidebar-terminology.test.jsx.
 *
 *   2. STICKY POINTER FOCUS. After a mouse click a link keeps DOM focus, so a
 *      plain `:focus` ring stays painted on the item the user clicked — which
 *      reads as a second active route. The fix is NOT to delete outlines
 *      (that would destroy keyboard accessibility) but to suppress the ring for
 *      POINTER focus while keeping it for KEYBOARD focus via `:focus-visible`.
 *
 * These assertions read the real stylesheet, because the requirement is about
 * what the browser actually paints. A browser is not available in this
 * environment, so this verifies the CSS contract rather than rendered pixels —
 * stated as a limitation in the report.
 * ---------------------------------------------------------------------------
 */

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, 'redesign.css'), 'utf8');

/** The declaration block for a selector, or null. */
function ruleFor(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  return match ? match[2].trim() : null;
}

describe('sidebar link state separation', () => {
  it('suppresses the ring for POINTER focus, so a clicked item does not keep glowing', () => {
    const rule = ruleFor('.rx-nav__link:focus');
    expect(rule, '.rx-nav__link:focus rule is missing').toBeTruthy();
    expect(rule).toMatch(/outline:\s*none/);
  });

  it('keeps a visible ring for KEYBOARD focus — accessibility is not sacrificed', () => {
    const rule = ruleFor('.rx-nav__link:focus-visible');
    expect(rule, '.rx-nav__link:focus-visible rule is missing').toBeTruthy();
    expect(rule).toMatch(/outline:\s*\d/);
    expect(rule).not.toMatch(/outline:\s*none/);
    // Offset it so the ring is legible against the row's own background.
    expect(rule).toMatch(/outline-offset/);
  });

  it('shows the ACTIVE route with background and weight, not with an outline', () => {
    const rule = ruleFor('.rx-nav__link.is-active');
    expect(rule, '.rx-nav__link.is-active rule is missing').toBeTruthy();
    expect(rule).toMatch(/background/);
    expect(rule).toMatch(/font-weight/);
    // If active were drawn with an outline it would be indistinguishable from
    // a focus ring, which is the whole confusion being fixed.
    expect(rule).not.toMatch(/outline/);
  });

  it('gives HOVER its own subtle treatment, distinct from active and focus', () => {
    const hover = ruleFor('.rx-nav__link:hover');
    const active = ruleFor('.rx-nav__link.is-active');
    expect(hover).toBeTruthy();
    expect(hover).toMatch(/background/);
    expect(hover).not.toMatch(/outline/);
    expect(hover).not.toBe(active);
  });

  it('marks the active route with more than colour alone', () => {
    // A colour-only indicator fails for low-vision and colour-blind users. The
    // active row also carries a weight change and a left rail marker.
    const active = ruleFor('.rx-nav__link.is-active');
    expect(active).toMatch(/font-weight/);
    expect(css).toMatch(/\.rx-nav__link\.is-active::before/);
  });

  it('base links carry no outline, so nothing glows by default', () => {
    const base = ruleFor('.rx-nav__link');
    expect(base).toBeTruthy();
    expect(base).not.toMatch(/outline:\s*\d/);
  });
});
