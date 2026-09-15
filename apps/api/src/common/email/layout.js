/**
 * Shared email branding + layout system.
 *
 * ONE place builds the branded HTML shell for every transactional email, so the
 * whole product's mail looks like a single, calm, healthcare-appropriate
 * product instead of a pile of hand-rolled templates. Template modules supply
 * only their specific content (heading, paragraphs, a call-to-action, a few
 * detail rows, an optional security notice) — never raw layout HTML.
 *
 * Constraints deliberately honoured for email-client safety:
 *   - table-based layout, inline styles only (no <style>, no external CSS)
 *   - no JavaScript, no external web fonts (system font stack)
 *   - a real hidden preheader for the inbox preview line
 *   - high-contrast primary button (white on deep purple)
 *   - everything caller-supplied is HTML-escaped; only URLs go into href/text
 *
 * Palette follows the product's existing accent (the purple already used by the
 * guardian email and the web design system) with soft neutral surfaces.
 */

import { formatDate } from '../../utils/format.js';
import { PLATFORM_BRAND } from '@aba1on1/schemas';

export { formatDate };

const PALETTE = {
  pageBg: '#f4f7fa',
  card: '#ffffff',
  ink: '#1f2333',
  muted: '#5b6070',
  faint: '#8b8fa3',
  line: '#e7e8ef',
  accent: PLATFORM_BRAND.colors.primary,
  accentInk: '#ffffff',
  noticeBg: PLATFORM_BRAND.colors.primaryTint,
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Sanitise a URL for use in an href. Only http(s) and mailto are allowed
 * through; anything else (javascript:, data:, etc.) collapses to '#', so a
 * caller can never inject a script URL into a button.
 */
function safeUrl(url) {
  const s = String(url ?? '').trim();
  if (/^(https?:|mailto:)/i.test(s)) return escapeHtml(s);
  return '#';
}

function paragraph(text) {
  return `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:${PALETTE.ink};">${escapeHtml(text)}</p>`;
}

function button({ label, url }) {
  return `
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">
          <tr><td style="border-radius:8px;background:${PALETTE.accent};">
            <a href="${safeUrl(url)}" style="display:inline-block;padding:13px 26px;font-size:16px;font-weight:600;line-height:1;color:${PALETTE.accentInk};text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>
          </td></tr>
        </table>`;
}

function infoCard(rows) {
  const items = rows
    .filter((r) => r && r.value != null && String(r.value) !== '')
    .map((r) => `
            <tr>
              <td style="padding:6px 0;font-size:13px;color:${PALETTE.faint};text-transform:uppercase;letter-spacing:0.04em;">${escapeHtml(r.label)}</td>
            </tr>
            <tr>
              <td style="padding:0 0 12px;font-size:16px;color:${PALETTE.ink};font-weight:600;word-break:break-word;">${escapeHtml(r.value)}</td>
            </tr>`)
    .join('');
  if (!items) return '';
  return `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;background:${PALETTE.noticeBg};border:1px solid ${PALETTE.line};border-radius:10px;">
          <tr><td style="padding:16px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items}</table></td></tr>
        </table>`;
}

function noticeBlock(title, lines) {
  const list = (Array.isArray(lines) ? lines : [lines]).filter(Boolean);
  if (!list.length) return '';
  const heading = title
    ? `<p style="margin:0 0 6px;font-size:14px;font-weight:600;color:${PALETTE.ink};">${escapeHtml(title)}</p>`
    : '';
  const paras = list
    .map((l) => `<p style="margin:0 0 6px;font-size:13px;line-height:1.6;color:${PALETTE.muted};">${escapeHtml(l)}</p>`)
    .join('');
  return `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;">
          <tr><td style="padding:0;">${heading}${paras}</td></tr>
        </table>`;
}

/**
 * Build a complete branded HTML email.
 *
 * @param {object} opts
 * @param {string} [opts.brandName]   Shown in the header (defaults to the platform product name).
 * @param {string} [opts.preheader]   Hidden inbox preview line.
 * @param {string}  opts.heading      Friendly headline.
 * @param {string[]|string} [opts.intro] One or more lead paragraphs.
 * @param {{label:string,url:string}} [opts.cta] Primary action button.
 * @param {{label:string,value:any}[]} [opts.infoRows] Detail rows.
 * @param {string} [opts.noticeTitle] Optional security/help heading.
 * @param {string[]|string} [opts.notice] Security/help paragraphs.
 * @param {string} [opts.footerNote] Extra footer line (e.g. "sent by …").
 * @returns {string} full HTML document
 */
export function renderBrandedEmail({
  brandName = PLATFORM_BRAND.productName,
  preheader = '',
  heading,
  intro = [],
  cta = null,
  infoRows = [],
  noticeTitle = null,
  notice = null,
  footerNote = null,
} = {}) {
  const introParas = (Array.isArray(intro) ? intro : [intro]).filter(Boolean).map(paragraph).join('');
  const year = new Date().getFullYear();

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>${escapeHtml(heading ?? brandName)}</title>
  </head>
  <body style="margin:0;padding:0;background:${PALETTE.pageBg};font-family:${FONT};">
    <span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PALETTE.pageBg};padding:24px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;">
          <tr><td style="padding:8px 4px 18px;">
            <span style="font-size:20px;font-weight:700;letter-spacing:-0.01em;color:${PALETTE.accent};">${escapeHtml(brandName)}</span>
          </td></tr>
          <tr><td style="background:${PALETTE.card};border:1px solid ${PALETTE.line};border-radius:14px;padding:32px;">
            <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:${PALETTE.ink};">${escapeHtml(heading ?? '')}</h1>
            ${introParas}
            ${cta ? button(cta) : ''}
            ${infoCard(infoRows)}
            ${noticeBlock(noticeTitle, notice)}
          </td></tr>
          <tr><td style="padding:18px 4px 8px;">
            <p style="margin:0 0 4px;font-size:12px;line-height:1.6;color:${PALETTE.faint};">${footerNote ? escapeHtml(footerNote) + '<br>' : ''}You are receiving this email because an account or request was created with ${escapeHtml(brandName)}.</p>
            <p style="margin:0 0 4px;font-size:12px;line-height:1.6;color:${PALETTE.faint};">Need help? Contact ${escapeHtml(PLATFORM_BRAND.productName)} at <a href="mailto:${escapeHtml(PLATFORM_BRAND.supportEmail)}" style="color:${PALETTE.faint};text-decoration:underline;">${escapeHtml(PLATFORM_BRAND.supportEmail)}</a>.</p>
            <p style="margin:0;font-size:12px;color:${PALETTE.faint};">© ${year} ${escapeHtml(brandName)}. All rights reserved. Product of ${escapeHtml(PLATFORM_BRAND.providerName)}.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}
