/**
 * ---------------------------------------------------------------------------
 * GUARDIAN INVITATION EMAIL.
 *
 * PHI DISCIPLINE. This email travels over ordinary mail infrastructure to an
 * address the clinic has on file and cannot control. It therefore carries the
 * child's FIRST NAME and nothing else about them — no surname, no date of
 * birth, no diagnosis, no insurer, no appointment, no clinical language, and
 * no identifiers. A first name plus a clinic name is enough for a family to
 * recognise a legitimate request, and is not enough for a stranger reading the
 * inbox to learn anything about a child's care.
 *
 * The word "therapy" is deliberately absent for the same reason: the fact that
 * a named child receives ABA therapy is itself sensitive.
 *
 * The link carries the token in the PATH rather than a query string, because
 * query strings turn up in referrer headers, proxy logs and analytics far more
 * readily than path segments do.
 * ---------------------------------------------------------------------------
 */

import { formatDate as formatMdyDate } from '../../utils/format.js';
import { PLATFORM_BRAND } from '@aba1on1/schemas';

const BUTTON_BG = PLATFORM_BRAND.colors.primary;

function formatDate(value) {
  // Product-wide user-facing date standard is MM/DD/YYYY (Part 20).
  const out = formatMdyDate(value);
  return out || null;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function guardianInvitationEmail({
  organizationName,
  childFirstName,
  guardianFirstName = null,
  link,
  expiresAt,
}) {
  const org = escapeHtml(organizationName);
  const child = escapeHtml(childFirstName);
  const greeting = guardianFirstName ? `Hello ${escapeHtml(guardianFirstName)},` : 'Hello,';
  const expiry = formatDate(expiresAt);

  const subject = `${organizationName}: a few details needed for ${childFirstName}`;

  const body = [
    greeting,
    '',
    `Thank you for choosing ${organizationName}. To finish getting ${childFirstName} set up, we need a few details from you.`,
    '',
    'Please open the secure link below and fill in the short form:',
    link,
    '',
    expiry ? `This link works until ${expiry} and can only be used once.` : 'This link can only be used once.',
    '',
    'If you did not expect this message, you can ignore it — no action will be taken.',
    '',
    `— ${organizationName}`,
  ].join('\n');

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2333;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <tr><td>
        <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#1f2333;">${org}</h1>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">${escapeHtml(greeting)}</p>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">
          Thank you for choosing ${org}. To finish getting ${child} set up, we need a few details from you.
        </p>
        <p style="margin:0 0 24px;font-size:16px;line-height:1.6;">
          It should only take a couple of minutes.
        </p>
        <p style="margin:0 0 24px;">
          <a href="${escapeHtml(link)}"
             style="display:inline-block;background:${BUTTON_BG};color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:16px;">
            Provide your details
          </a>
        </p>
        <p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#5b6070;">
          ${expiry ? `This link works until ${escapeHtml(expiry)} and can only be used once.` : 'This link can only be used once.'}
        </p>
        <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#5b6070;">
          If the button does not work, copy and paste this address into your browser:<br>
          <span style="word-break:break-all;">${escapeHtml(link)}</span>
        </p>
        <hr style="border:none;border-top:1px solid #e7e8ef;margin:24px 0;">
        <p style="margin:0;font-size:13px;line-height:1.6;color:#8b8fa3;">
          If you did not expect this message, you can ignore it — no action will be taken.
        </p>
      </td></tr>
    </table>
  </body>
</html>`;

  return { subject, body, html, link };
}
