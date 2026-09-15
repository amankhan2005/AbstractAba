/**
 * THE reusable, server-side company email footer.
 *
 * One implementation, resolved from the authenticated tenant's Organization —
 * never from frontend-supplied company identity. Company-originated emails
 * (parent/guardian, staff, scheduling, etc.) append this footer; platform /
 * Super-Admin emails keep the platform identity and never call this.
 *
 * Rules:
 *   - Company name is required (falls back to a neutral label only if the org
 *     truly has no trading/legal name).
 *   - Phone / email / address / website are OPTIONAL: a line is emitted only
 *     when the underlying field actually exists. Missing fields produce NO
 *     empty label — the line is omitted entirely.
 *   - Every value is HTML-escaped in the html variant (same security model as
 *     the parent-email renderer), so no company profile value can inject markup.
 *   - Pure and side-effect-free: the caller passes an already-resolved org.
 *     Historical emails are never rewritten — the footer is composed at
 *     render/send time from the CURRENT profile.
 */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function clean(value) {
  if (value == null) return '';
  const s = String(value).trim();
  return s;
}

/** Compose a one-line mailing address from whatever address parts exist. */
function composeAddressLine(org) {
  const line1 = clean(org.addressLine1);
  const line2 = clean(org.addressLine2);
  const city = clean(org.city);
  const region = clean(org.stateCode);
  const postal = clean(org.postalCode);
  const country = clean(org.countryCode);

  const street = [line1, line2].filter(Boolean).join(', ');
  // "City, ST 02110" — omit the comma when there is no city, omit the space
  // when there is no postal, and drop the whole locality if none exist.
  const locality = [city, [region, postal].filter(Boolean).join(' ').trim()]
    .filter(Boolean)
    .join(', ');
  const parts = [street, locality].filter(Boolean);
  // Country is only appended when it adds signal (not the US default noise).
  if (country && country.toUpperCase() !== 'US' && parts.length > 0) parts.push(country);
  return parts.join(', ');
}

/**
 * Resolve the ordered list of footer lines that actually have data. The first
 * line is always the company name; the rest are present-only contact lines.
 */
export function resolveCompanyFooterLines(org = {}) {
  const name = clean(org.tradingName) || clean(org.legalName) || clean(org.name) || 'Your provider';
  const phone = clean(org.contactPhone);
  const email = clean(org.contactEmail) || clean(org.primaryContactEmail);
  const address = composeAddressLine(org);
  const website = clean(org.websiteUrl);

  const contact = [phone, email, address, website].filter(Boolean);
  return { name, contact };
}

/**
 * Build the footer in both plain-text and HTML. Returns '' text/html only when
 * there is genuinely nothing (no org) — otherwise at least the company name and
 * a sign-off appear.
 */
export function buildCompanyFooter(org = {}) {
  const { name, contact } = resolveCompanyFooterLines(org);

  const textLines = ['Regards,', '', name, ...contact];
  const text = textLines.join('\n');

  const htmlContact = contact
    .map((line) => `<div style="color:#64748b;font-size:13px;line-height:1.5">${esc(line)}</div>`)
    .join('');
  const html =
    '<div style="margin-top:20px;padding-top:14px;border-top:1px solid #e2e8f0">' +
    '<div style="color:#334155;font-size:13px">Regards,</div>' +
    `<div style="font-weight:600;color:#0f172a;font-size:14px;margin-top:4px">${esc(name)}</div>` +
    htmlContact +
    '</div>';

  return { name, contact, text, html };
}

/**
 * Append the company footer to an already-rendered email body. Used by BOTH the
 * preview and the send paths so the preview is byte-identical to what ships.
 */
export function appendCompanyFooter(rendered, org) {
  const footer = buildCompanyFooter(org);
  return {
    ...rendered,
    text: `${rendered.text}\n\n${footer.text}`,
    html: `${rendered.html}${footer.html}`,
    footer,
  };
}
