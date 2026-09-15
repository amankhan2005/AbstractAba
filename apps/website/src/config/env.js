/**
 * Public website configuration. Only VITE_-prefixed variables reach the
 * browser bundle, and everything that does is public by definition — no email
 * or API credentials ever live in this application.
 */
function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

export function readSiteEnv(source = import.meta.env ?? {}) {
  const apiBaseUrl = trimTrailingSlash(source.VITE_API_BASE_URL || '/api');
  const webAppUrl = trimTrailingSlash(source.VITE_WEB_APP_URL || 'http://localhost:3000');
  return Object.freeze({
    apiBaseUrl,
    webAppUrl,
    // "Sign In" goes to the existing web panel's login; the website has no login.
    signInUrl: `${webAppUrl}/login`,
  });
}

export const siteEnv = readSiteEnv();
