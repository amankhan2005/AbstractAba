import { NEUTRAL_INK as NEAR_BLACK, NEUTRAL_PAPER as WHITE } from './design-tokens.js';

/** Colour derivation — BR-UI-4. Pure functions; contrast guarantees are proven by unit test. */
export function hexToRgb(hex) {
  const n = hex.replace('#', '');
  return { r: parseInt(n.slice(0, 2), 16), g: parseInt(n.slice(2, 4), 16), b: parseInt(n.slice(4, 6), 16) };
}
function toHex(v) { return Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0'); }
function rgbToHex({ r, g, b }) { return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase(); }

export function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const ch = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
export function contrastRatio(a, b) {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
/** The accessible foreground for a background: whichever neutral reads more clearly (BR-UI-4). */
export function accessibleForeground(background) {
  return contrastRatio(background, WHITE) >= contrastRatio(background, NEAR_BLACK) ? WHITE : NEAR_BLACK;
}

function rgbToHsl({ r, g, b }) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2, delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === rn) h = ((gn - bn) / delta) % 6;
  else if (max === gn) h = (bn - rn) / delta + 2;
  else h = (rn - gn) / delta + 4;
  h = Math.round(h * 60); if (h < 0) h += 360;
  return { h, s, l };
}
function hslToRgb({ h, s, l }) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g] = [c, x]; else if (h < 120) [r, g] = [x, c];
  else if (h < 180) [g, b] = [c, x]; else if (h < 240) [g, b] = [x, c];
  else if (h < 300) [r, b] = [x, c]; else [r, b] = [c, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}
/** Derives the dark-mode stop for a light-mode hue: lighter, slightly desaturated, same hue. */
export function deriveDarkVariant(hex) {
  const hsl = rgbToHsl(hexToRgb(hex));
  return rgbToHex(hslToRgb({ h: hsl.h, s: Math.max(0, Math.min(1, hsl.s * 0.82)), l: Math.max(0, Math.min(1, Math.max(hsl.l, 0.62))) }));
}
