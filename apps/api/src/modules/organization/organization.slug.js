import { orgError } from './organization.errors.js';

/**
 * Slug rules, ported from the original. The slug appears in URLs, branding
 * lookups and (later) subdomains; it is immutable after creation. Reserved
 * words are blocked both to avoid collisions with platform routes and to stop a
 * tenant impersonating the platform in a link (a phishing vector).
 */
const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MIN_LENGTH = 3;
const MAX_LENGTH = 40;

export const RESERVED_SLUGS = new Set([
  'www', 'api', 'app', 'apps', 'admin', 'administrator', 'console', 'platform',
  'support', 'help', 'status', 'docs', 'documentation', 'blog', 'mail', 'email',
  'smtp', 'imap', 'ftp', 'cdn', 'static', 'assets', 'files', 'download', 'auth',
  'login', 'logout', 'signin', 'signup', 'register', 'account', 'billing',
  'invoice', 'payment', 'payments', 'security', 'privacy', 'terms', 'legal',
  'compliance', 'hipaa', 'aba1on1', 'abaonone', 'system', 'internal', 'test',
  'testing', 'staging', 'demo', 'sandbox', 'dev', 'development', 'root', 'null',
  'undefined', 'none', 'new', 'edit', 'delete', 'settings',
]);

export function assertSlugAcceptable(slug) {
  if (slug.length < MIN_LENGTH || slug.length > MAX_LENGTH || !SLUG_PATTERN.test(slug)) {
    throw orgError('SLUG_INVALID');
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw orgError('SLUG_RESERVED');
  }
}

export function isSlugAcceptable(slug) {
  try {
    assertSlugAcceptable(slug);
    return true;
  } catch {
    return false;
  }
}
