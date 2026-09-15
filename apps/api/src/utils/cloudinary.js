import crypto from 'node:crypto';

/**
 * Cloudinary signed uploads, implemented directly against the documented
 * algorithm (https://cloudinary.com/documentation/upload_images#generating_authentication_signatures)
 * rather than pulling in the `cloudinary` SDK: the API never touches the
 * image itself, so all it actually needs is one HMAC-shaped signature — the
 * browser uploads directly to Cloudinary with it. This keeps the company logo
 * binary completely out of our servers and out of MongoDB; only the returned
 * `secure_url` is ever persisted (on Organization.logoUrl).
 *
 * Every param the browser will send MUST be included here and signed exactly
 * as sent (Cloudinary recomputes the signature server-side and rejects a
 * mismatch), so the signing function and the upload call are kept in the same
 * module-level contract: sign({ folder, timestamp }) below, matched by
 * exactly { folder, timestamp, api_key, signature, file } on the frontend.
 */
export function isCloudinaryConfigured(config) {
  return Boolean(config?.cloudName && config?.apiKey && config?.apiSecret);
}

/**
 * @param {{cloudName:string, apiKey:string, apiSecret:string}} config
 * @param {{folder: string}} params - additional params to sign (folder only, for now)
 * @returns {{cloudName:string, apiKey:string, timestamp:number, signature:string, folder:string}}
 */
export function signCloudinaryUpload(config, { folder }) {
  if (!isCloudinaryConfigured(config)) {
    throw new Error('Cloudinary is not configured: set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.');
  }
  const timestamp = Math.floor(Date.now() / 1000);
  // Cloudinary's algorithm: every param to sign EXCEPT api_key/signature/file,
  // sorted alphabetically by key, joined as `key=value&key2=value2`, api_secret
  // appended (not delimited), then SHA-1 hex.
  const toSign = { folder, timestamp };
  const paramString = Object.keys(toSign)
    .sort()
    .map((key) => `${key}=${toSign[key]}`)
    .join('&');
  const signature = crypto
    .createHash('sha1')
    .update(`${paramString}${config.apiSecret}`)
    .digest('hex');
  return { cloudName: config.cloudName, apiKey: config.apiKey, timestamp, signature, folder };
}
