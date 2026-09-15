import { env } from '../../config/env.js';
import { AppError } from '../../common/errors/AppError.js';

/**
 * ---------------------------------------------------------------------------
 * COMPANY LOGO UPLOAD — Cloudinary.
 *
 * Blueprint §6.14 lists the company logo among the tenant brand tokens, and
 * §6.12 (Reports & PDF branding) puts it on generated documents. It therefore
 * has to live somewhere with a stable public URL, not in the database: a logo
 * is re-served on every page load by every user of the tenant, and streaming
 * binary out of Mongo for that is the wrong shape at every scale.
 *
 * WHY UPLOAD SERVER-SIDE rather than signing a browser-direct upload. An
 * unsigned browser upload preset is, in practice, an open write endpoint on
 * the clinic's media account: anyone who reads the bundle can post anything to
 * it. Routing through the API costs one hop and means the API secret never
 * reaches a browser, the permission check happens before the bytes move, and
 * the resulting URL is written to the tenant's brand tokens by code that knows
 * which tenant is asking.
 *
 * VALIDATION IS SERVER-SIDE and does not trust the declared content type. A
 * client can label anything `image/png`, so the bytes are checked against
 * their magic number. This matters because the URL that comes back is served
 * to every user of the tenant, and an SVG in particular is an executable
 * document — it is excluded for exactly that reason, even though it is the
 * format a designer would most like to hand over.
 *
 * NOT CONFIGURED IS NOT AN ERROR TO HIDE. When credentials are absent this
 * throws a clear, actionable message instead of pretending an upload
 * succeeded. A branding screen that reports success and shows no logo is worse
 * than one that says the server cannot store images yet.
 * ---------------------------------------------------------------------------
 */

const MAX_BYTES = 2 * 1024 * 1024; // 2 MiB — a logo, not a photograph.

/**
 * Accepted formats and their magic numbers. SVG is deliberately absent: it can
 * carry script, and this file is served to every user of the tenant.
 */
const SIGNATURES = [
  { mime: 'image/png', ext: 'png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.length > 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
];

export function cloudinaryConfigured() {
  const c = env.cloudinary ?? {};
  return Boolean(c.cloudName && c.apiKey && c.apiSecret);
}

/**
 * Validates the bytes. Returns the detected format, or throws a message a user
 * can act on.
 */
export function validateLogo(buffer) {
  if (!buffer || buffer.length === 0) {
    throw AppError.validation('Please choose an image file.');
  }
  if (buffer.length > MAX_BYTES) {
    throw AppError.validation('That image is too large. Please use a logo under 2 MB.');
  }
  const match = SIGNATURES.find((s) => s.test(buffer));
  if (!match) {
    // Named formats rather than "invalid file type": a user needs to know what
    // to do next, and SVG being refused is surprising enough to be worth
    // saying out loud.
    throw AppError.validation('Please upload a PNG, JPG or WebP image. SVG files can’t be used for logos.');
  }
  return match;
}

/**
 * Uploads a validated logo and returns { url, publicId }.
 *
 * The asset is foldered per tenant and given a deterministic public id, so a
 * replacement overwrites the previous file rather than accumulating orphans —
 * and one tenant can never address another's asset path.
 */
export async function uploadLogo({ tenantId, buffer, publicId: publicIdOverride = null, fetchImpl = fetch }) {
  if (!cloudinaryConfigured()) {
    throw AppError.validation(
      'Image uploads aren’t set up on this server yet. Please ask your administrator to configure them.',
    );
  }
  const format = validateLogo(buffer);
  const { cloudName, apiKey, apiSecret } = env.cloudinary;

  // A caller may supply the public id for non-tenant assets (e.g. the platform
  // insurance catalog, foldered under aba1on1/insurance-catalog/<id>/logo). The
  // default remains the per-tenant path, so existing callers are unchanged.
  const publicId = publicIdOverride || `aba1on1/tenants/${tenantId}/logo`;
  const timestamp = Math.floor(Date.now() / 1000);

  // Signed upload: the parameters that are signed must match those sent, in
  // alphabetical order, with the secret appended. Cloudinary rejects any
  // mismatch, which is what stops a tampered request.
  const toSign = `invalidate=true&overwrite=true&public_id=${publicId}&timestamp=${timestamp}`;
  const { createHash } = await import('node:crypto');
  const signature = createHash('sha1').update(`${toSign}${apiSecret}`).digest('hex');

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: format.mime }), `logo.${format.ext}`);
  form.append('api_key', apiKey);
  form.append('timestamp', String(timestamp));
  form.append('public_id', publicId);
  form.append('overwrite', 'true');
  form.append('invalidate', 'true');
  form.append('signature', signature);

  let response;
  try {
    response = await fetchImpl(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
      method: 'POST',
      body: form,
    });
  } catch {
    // Network failure. Never let this read as success.
    throw AppError.validation('We couldn’t reach the image service. Please try again in a moment.');
  }

  if (!response.ok) {
    // The upstream message may name internal configuration; it is logged by
    // the caller's error handler, not returned to the user.
    throw AppError.validation('We couldn’t save that image. Please try a different file.');
  }

  const body = await response.json();
  if (!body?.secure_url) {
    throw AppError.validation('We couldn’t save that image. Please try again.');
  }

  return { url: body.secure_url, publicId: body.public_id ?? publicId };
}

export const LOGO_MAX_BYTES = MAX_BYTES;
export const LOGO_FORMATS = SIGNATURES.map((s) => s.mime);
