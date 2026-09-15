import { siteEnv } from '@/config/env';

/**
 * Website "Contact Us" submission to the EXISTING API
 * (POST /v1/public/inquiries in apps/api). Anonymous and credential-free: no
 * cookies, no Authorization header. The API validates, rate limits, stores the
 * inquiry and sends the team notification and the confirmation email.
 *
 * Errors are thrown as { status, fieldErrors } so the page can show friendly
 * messages without exposing technical details.
 */
export class InquiryError extends Error {
  constructor(status, fieldErrors = null) {
    super('Inquiry submission failed');
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

export async function submitInquiry(body, { fetchImpl = globalThis.fetch, baseUrl = siteEnv.apiBaseUrl } = {}) {
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/v1/public/inquiries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'omit',
      body: JSON.stringify(body),
    });
  } catch {
    throw new InquiryError(0);
  }
  let payload = null;
  try { payload = await response.json(); } catch { /* non-JSON response */ }
  if (!response.ok) {
    throw new InquiryError(response.status, payload?.error?.details?.fieldErrors ?? null);
  }
  return payload?.data ?? { received: true };
}
