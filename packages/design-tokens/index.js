import { z } from 'zod';

/**
 * The design-token contract — Blueprint §6.14b. The single source of truth both
 * the API and the web application import: the locked semantic palette, the six
 * safe accents, the brand defaults, the preference vocabulary and its
 * validation. Declaring it in one shared package is what keeps the server's
 * resolution and the client's rendering from ever disagreeing about a token.
 * Ported verbatim (TS→JS) from the original @aba1on1/schemas.
 *
 * Type shapes (ColorPair, UserPreferences, ResolvedTheme, ...) are documentation
 * only in JavaScript.
 */

// --- platform product identity -----------------------------------------------
/**
 * The ONE user-facing product identity for every surface (tenant web app,
 * platform console, transactional emails). Customer organizations keep their
 * own name/logo through tenant branding; this is the software itself and the
 * company that provides it. Technical identifiers (package names, storage keys,
 * cookie names, database names) intentionally still use `aba1on1`.
 */
export const PLATFORM_BRAND = Object.freeze({
  productName: 'Abstract ABA',
  productMark: 'AA',
  providerName: 'WebieApp Solutions LLC',
  supportEmail: 'info@abstractaba.com',
  /** Existing product assets served from each front end's public folder. */
  logoUrl: '/logo.png',
  faviconUrl: '/favicon.ico',
  /** Mirrors packages/design-tokens/brand.css for JS consumers (charts, emails). */
  colors: Object.freeze({
    primary: '#1172A3',
    primaryStrong: '#0D5E87',
    primaryTint: '#E7F2F8',
    secondary: '#2DA589',
    secondaryStrong: '#1F7F69',
  }),
});

// --- the three-layer vocabulary ---------------------------------------------
export const COLOR_SCHEMES = ['light', 'dark', 'auto'];
export const ACCENTS = ['teal', 'ocean', 'indigo', 'violet', 'plum', 'slate', 'orchid'];
export const SIDEBAR_STYLES = ['expanded', 'icon', 'auto'];
export const NAV_STYLES = ['sidebar', 'top'];
export const DENSITIES = ['comfortable', 'compact'];
export const FONT_SIZES = ['small', 'medium', 'large'];
export const RADII = ['rounded', 'square'];

// --- state.* — the locked semantic palette ----------------------------------
export const SEMANTIC_STATES = ['approved', 'pending', 'denied', 'information', 'draft'];

/** Fixed platform-wide; no override path at any layer (BR-UI-2). Every entry
 *  carries an icon + label so meaning is never colour-only (BR-UI-3). */
export const SEMANTIC_PALETTE = {
  approved: { foreground: { light: '#3B6D11', dark: '#97C459' }, surface: { light: '#EAF3DE', dark: '#27500A' }, icon: 'circle-check', label: 'Approved' },
  pending: { foreground: { light: '#854F0B', dark: '#EF9F27' }, surface: { light: '#FAEEDA', dark: '#633806' }, icon: 'clock-pause', label: 'Pending' },
  denied: { foreground: { light: '#A32D2D', dark: '#F09595' }, surface: { light: '#FCEBEB', dark: '#791F1F' }, icon: 'circle-x', label: 'Denied' },
  information: { foreground: { light: '#185FA5', dark: '#85B7EB' }, surface: { light: '#E6F1FB', dark: '#0C447C' }, icon: 'info-circle', label: 'Information' },
  draft: { foreground: { light: '#5F5E5A', dark: '#B4B2A9' }, surface: { light: '#F1EFE8', dark: '#444441' }, icon: 'circle-dashed', label: 'Draft' },
};

// --- pref.* accents — the safe band -----------------------------------------
export const SAFE_ACCENTS = {
  teal: { light: '#0F6E56', dark: '#6FC3AB' },
  ocean: { light: '#2E6FB8', dark: '#7FB2E8' },
  indigo: { light: '#4C52C4', dark: '#9AA0EE' },
  violet: { light: '#7346A8', dark: '#BFA0DE' },
  plum: { light: '#9B3A78', dark: '#DE9CC6' },
  slate: { light: '#3F5C73', dark: '#9CB4C8' },
  // Derived from the client palette (#A47DAB family). The raw mauve is too
  // light to carry white text (3.44:1), so the light-scheme accent is a
  // darkened #7B5E80 (5.59:1); the dark-scheme accent is the pale lilac
  // #CEB5FF on near-black ink (10.6:1). Meaning is never colour-only, so this
  // is safe as a decorative accent (BR-UI-3).
  orchid: { light: '#7B5E80', dark: '#CEB5FF' },
};

// --- brand.* — tenant defaults ----------------------------------------------
export const BRAND_DEFAULTS = {
  // The Abstract ABA product colours (see PLATFORM_BRAND.colors / brand.css):
  // #1172A3 primary and #2DA589 secondary, with lighter dark-scheme partners.
  // A tenant may still override these with its own brand colours.
  primary: { light: '#1172A3', dark: '#6FB7DD' },
  secondary: { light: '#2DA589', dark: '#7ED3BF' },
};

/**
 * SOFT SURFACE TINTS — the pale band of the client palette.
 *
 * These are decorative BACKGROUNDS carrying near-black text, never status
 * colours: BR-UI-2 locks the semantic palette so no theme can recolour
 * "denied" or "approved", and pale red / pale green here are deliberately NOT
 * wired to any state for exactly that reason. Every tint clears 8:1 with ink.
 */
export const SOFT_SURFACES = {
  lilac: '#F0D3FF',
  blush: '#FFD3D3',
  mint: '#D3FFD3',
  periwinkle: '#CEB5FF',
  sky: '#80A8FF',
};

/** The two neutral extremes an accessible foreground is chosen between. */
export const NEUTRAL_INK = '#0C1017';
export const NEUTRAL_PAPER = '#FFFFFF';

// --- the resolved preference shape ------------------------------------------
export const PREFERENCE_DEFAULTS = {
  colorScheme: 'auto', accent: 'orchid', sidebarStyle: 'expanded', navStyle: 'sidebar',
  density: 'comfortable', fontSize: 'medium', radius: 'rounded',
  highContrast: false, reducedMotion: false, language: 'en',
};

// --- validation --------------------------------------------------------------
export const userPreferencesPatchSchema = z
  .object({
    colorScheme: z.enum(COLOR_SCHEMES),
    accent: z.enum(ACCENTS),
    sidebarStyle: z.enum(SIDEBAR_STYLES),
    navStyle: z.enum(NAV_STYLES),
    density: z.enum(DENSITIES),
    fontSize: z.enum(FONT_SIZES),
    radius: z.enum(RADII),
    highContrast: z.boolean(),
    reducedMotion: z.boolean(),
    language: z.string().trim().min(2).max(10).regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/, 'A BCP-47 language tag, e.g. en or es-419'),
  })
  .partial()
  .strict();

const HEX_COLOR = /^#(?:[0-9a-fA-F]{6})$/;
const httpUrl = z.string().trim().url().max(2048).refine((value) => {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}, { message: 'Only http and https URLs are allowed' });

export const brandTokensPatchSchema = z
  .object({
    primary: z.string().regex(HEX_COLOR, 'A six-digit hex colour, e.g. #0F6E56'),
    secondary: z.string().regex(HEX_COLOR, 'A six-digit hex colour, e.g. #4E9AD1'),
    logoUrl: httpUrl.nullable(),
  })
  .partial()
  .strict();

// --- US states — Module 5 (state-wise insurance) canonical source -----------
/**
 * THE single source of truth for US states across the platform: the API imports
 * it (models/enums.js re-exports US_STATE_CODES from here), the tenant web app
 * imports it, and the platform console imports it. No file anywhere else should
 * hardcode a state list. Codes are the stored/validated value; names are the
 * user-facing label — Module 5.2 requires full names in every selector.
 *
 * Order is deliberate and stable (alphabetical by name, DC last) so a re-export
 * as US_STATE_CODES keeps the exact set the API already validated against.
 */
export const US_STATES = [
  { code: 'AL', name: 'Alabama' }, { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' }, { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' }, { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' }, { code: 'DE', name: 'Delaware' },
  { code: 'FL', name: 'Florida' }, { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' }, { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' }, { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' }, { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' }, { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' }, { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' }, { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' }, { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' }, { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' }, { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' }, { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' }, { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' }, { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' }, { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' }, { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' }, { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' }, { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' }, { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' }, { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' }, { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' }, { code: 'WY', name: 'Wyoming' },
  { code: 'DC', name: 'District of Columbia' },
];

/** Just the codes — the stored/validated value. Re-exported by the API enums. */
export const US_STATE_CODES = US_STATES.map((s) => s.code);

/** code -> full name, for turning a stored code into a display label. */
export const US_STATE_NAME_BY_CODE = Object.fromEntries(US_STATES.map((s) => [s.code, s.name]));

/** Full name of a state code, or the code itself if somehow unknown. */
export function usStateName(code) {
  if (!code) return '';
  return US_STATE_NAME_BY_CODE[String(code).toUpperCase()] ?? String(code);
}

/** A code is a real US state (case-insensitive). */
export function isUsStateCode(code) {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(US_STATE_NAME_BY_CODE, code.toUpperCase());
}
