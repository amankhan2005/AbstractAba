import { PLATFORM_BRAND } from '@aba1on1/schemas';

/**
 * Centralised, validated environment configuration.
 *
 * Fail fast: the process refuses to start if a required secret is missing,
 * rather than discovering it on the first request. Mirrors the original API's
 * config module.
 */

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function intOf(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Environment variable ${name} must be an integer`);
  return n;
}

const nodeEnv = optional('NODE_ENV', 'development');
const isProd = nodeEnv === 'production';

export const env = {
  nodeEnv,
  isProd,
  port: intOf('PORT', 4000),

  // MongoDB. A replica set is required for multi-document transactions (audit
  // head read+insert, onboarding). docker-compose.yml provides a single-node
  // replica set for development.
  mongoUri: isProd
    ? required('MONGODB_URI')
    : optional('MONGODB_URI', 'mongodb://127.0.0.1:27017/aba1on1'),

  // JWT / sessions
  jwtAccessSecret: isProd ? required('JWT_ACCESS_SECRET') : optional('JWT_ACCESS_SECRET', 'dev-access-secret-change-me'),
  accessTokenTtlSeconds: intOf('ACCESS_TOKEN_TTL_SECONDS', 900), // 15 min
  refreshTokenTtlSeconds: intOf('REFRESH_TOKEN_TTL_SECONDS', 60 * 60 * 24 * 30), // 30 days

  // Application-layer field encryption key (MFA secrets). 32-byte base64 in prod.
  fieldEncryptionKey: isProd
    ? required('FIELD_ENCRYPTION_KEY')
    : optional('FIELD_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64')),

  bcryptRounds: intOf('BCRYPT_ROUNDS', 12),

  corsOrigins: optional('CORS_ORIGINS', 'http://localhost:3000,http://localhost:3100')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Refresh-token cookie (blueprint 9.1: "long-lived rotating refresh token
  // stored in a hardened cookie"). httpOnly puts the token out of reach of any
  // script on the page, which is the whole point — a token in localStorage is
  // readable by every dependency the bundle ever pulls in.
  //
  // sameSite: 'lax' is correct when the SPA is served same-site with the API
  // (the default deployment). A cross-site deployment needs 'none', which the
  // browser only honours together with secure: true — hence the pairing below.
  refreshCookieName: optional('REFRESH_COOKIE_NAME', 'aba1on1_rt'),
  refreshCookieSameSite: optional('REFRESH_COOKIE_SAMESITE', isProd ? 'lax' : 'lax'),
  // Secure is mandatory in production and off in development, where the dev
  // server is plain http and a secure cookie would simply never be stored.
  refreshCookieSecure: optional('REFRESH_COOKIE_SECURE', isProd ? 'true' : 'false') === 'true',
  refreshCookieDomain: optional('REFRESH_COOKIE_DOMAIN', ''),

  rateLimitWindowMs: intOf('RATE_LIMIT_WINDOW_MS', 60_000),
  rateLimitMax: intOf('RATE_LIMIT_MAX', 300),

  jobPollIntervalMs: intOf('JOB_POLL_INTERVAL_MS', 1_000),

  // Document storage (Phase 4.1). Files are stored via a pluggable adapter; the
  // local adapter writes under storageDir. Swap DOCUMENT_STORAGE_DRIVER=s3 (with
  // an S3 adapter) in production without touching callers. maxBytes caps upload
  // size server-side; allowedMimeTypes is the server-authoritative allowlist.
  documentStorageDriver: optional('DOCUMENT_STORAGE_DRIVER', 'local'),
  scheduling: {
    // Enforced by default: a booking requires the staff to be on the child's
    // ACTIVE care team (Phase 3 assignment). The backend is the source of truth —
    // a manually submitted staff id for an unassigned member is rejected with
    // STAFF_NOT_ASSIGNED. A clinic may opt OUT via SCHEDULING_REQUIRE_ASSIGNMENT=false.
    requireCareTeamAssignment: optional('SCHEDULING_REQUIRE_ASSIGNMENT', 'true') !== 'false',
  },
  documentStorageDir: optional('DOCUMENT_STORAGE_DIR', './var/document-storage'),
  documentMaxBytes: intOf('DOCUMENT_MAX_BYTES', 26_214_400), // 25 MiB
  documentAllowedMimeTypes: optional(
    'DOCUMENT_ALLOWED_MIME_TYPES',
    'application/pdf,image/png,image/jpeg,image/tiff,text/plain,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ).split(',').map((s) => s.trim()).filter(Boolean),

  // Public base URL of the tenant web app, used to build onboarding links.
  webAppUrl: optional('WEB_APP_URL', 'http://localhost:3000').replace(/\/+$/, ''),

  // Public website inquiries ("Contact Us"): the team inbox that receives
  // notifications, the Platform Console base URL for the "Open Inquiries" link
  // (optional), and the per-client submission limit per 15 minutes.
  inquiries: {
    notifyEmail: optional('INQUIRY_NOTIFY_EMAIL', PLATFORM_BRAND.supportEmail),
    consoleUrl: optional('CONSOLE_APP_URL', '').replace(/\/+$/, ''),
    rateLimitMax: intOf('INQUIRY_RATE_LIMIT_MAX', 5),
  },

  // Resend email provider for real off-platform email delivery. Optional at
  // parse time so dev/test boot without it; the email transport validates
  // presence at send time and fails loudly if used while unconfigured.
  resend: {
    apiKey: optional('RESEND_API_KEY', ''),
    fromEmail: optional('RESEND_FROM_EMAIL', ''),
    // Sender display name defaults to the product brand; RESEND_FROM_NAME overrides it.
    fromName: optional('RESEND_FROM_NAME', PLATFORM_BRAND.productName),
  },

  // Cloudinary, for the company-logo upload during onboarding. The API never
  // holds the image — it only signs a short-lived, narrowly-scoped upload
  // request (folder + timestamp) that the browser then sends directly to
  // Cloudinary. Optional at parse time; the signing endpoint fails loudly if
  // called while unconfigured, same pattern as Resend above.
  cloudinary: {
    cloudName: optional('CLOUDINARY_CLOUD_NAME', ''),
    apiKey: optional('CLOUDINARY_API_KEY', ''),
    apiSecret: optional('CLOUDINARY_API_SECRET', ''),
  },
};
