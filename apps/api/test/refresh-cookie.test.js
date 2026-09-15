import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setRefreshCookie,
  clearRefreshCookie,
  readRefreshToken,
  usedCookieTransport,
  REFRESH_COOKIE_PATH,
} from '../src/modules/auth/refreshCookie.js';
import { env } from '../src/config/env.js';

/**
 * ---------------------------------------------------------------------------
 * REFRESH TOKEN TRANSPORT — hardened cookie (blueprint 9.1).
 *
 * The API previously returned the refresh token in the JSON body only, and both
 * SPAs stored it in localStorage while their HTTP clients carried
 * `withCredentials: true` and a comment describing an httpOnly cookie the API
 * had never set. These tests pin the attributes that make the cookie actually
 * hardened, because every one of them is a silent, invisible failure if wrong:
 * a missing httpOnly still works perfectly in the browser while remaining
 * readable by script, and mismatched clear-attributes leave a live token behind
 * on sign-out.
 * ---------------------------------------------------------------------------
 */

function fakeRes() {
  const calls = { cookie: [], cleared: [] };
  return {
    calls,
    cookie: (name, value, options) => calls.cookie.push({ name, value, options }),
    clearCookie: (name, options) => calls.cleared.push({ name, options }),
  };
}

test('the refresh cookie is httpOnly, path-scoped and TTL-matched', () => {
  const res = fakeRes();
  setRefreshCookie(res, 'a-refresh-token-value');

  assert.equal(res.calls.cookie.length, 1);
  const { name, value, options } = res.calls.cookie[0];
  assert.equal(name, env.refreshCookieName);
  assert.equal(value, 'a-refresh-token-value');

  // httpOnly is the entire point: unreadable from JavaScript, so an XSS on the
  // page cannot exfiltrate a thirty-day credential to a PHI system.
  assert.equal(options.httpOnly, true);

  // sameSite blocks the bare credentialed cross-site POST.
  assert.equal(options.sameSite, 'lax');

  // Scoped to the auth routes: the token travels only where it is used, rather
  // than riding along on every request in the application.
  assert.equal(options.path, REFRESH_COOKIE_PATH);

  // The browser forgets it at the same moment the server does.
  assert.equal(options.maxAge, env.refreshTokenTtlSeconds * 1000);
});

test('no cookie is written when there is no token to write', () => {
  const res = fakeRes();
  setRefreshCookie(res, null);
  setRefreshCookie(res, undefined);
  setRefreshCookie(res, '');
  assert.equal(res.calls.cookie.length, 0);
});

test('clearing uses the SAME attributes it was set with', () => {
  // A clearCookie whose path or domain differs from the original is a no-op in
  // every browser: the cookie survives and "sign out" silently does nothing.
  const setRes = fakeRes();
  setRefreshCookie(setRes, 'token-to-be-cleared');
  const setOpts = setRes.calls.cookie[0].options;

  const clearRes = fakeRes();
  clearRefreshCookie(clearRes);
  const clearOpts = clearRes.calls.cleared[0].options;

  assert.equal(clearRes.calls.cleared[0].name, env.refreshCookieName);
  assert.equal(clearOpts.path, setOpts.path);
  assert.equal(clearOpts.httpOnly, setOpts.httpOnly);
  assert.equal(clearOpts.sameSite, setOpts.sameSite);
  assert.equal(clearOpts.secure, setOpts.secure);
  assert.equal(clearOpts.domain, setOpts.domain);
});

test('the cookie is preferred over the request body', () => {
  const req = {
    cookies: { [env.refreshCookieName]: 'cookie-token-value' },
    body: { refreshToken: 'body-token-value' },
  };
  assert.equal(readRefreshToken(req), 'cookie-token-value');
  assert.equal(usedCookieTransport(req), true);
});

test('the body remains accepted so a rolling deploy signs nobody out', () => {
  // Deleting the body path outright would invalidate every session open at the
  // moment of deploy. It is deprecated, not removed.
  const req = { cookies: {}, body: { refreshToken: 'body-token-value' } };
  assert.equal(readRefreshToken(req), 'body-token-value');
  assert.equal(usedCookieTransport(req), false);
});

test('a missing or implausibly short token resolves to null, never to a partial value', () => {
  assert.equal(readRefreshToken({ cookies: {}, body: {} }), null);
  assert.equal(readRefreshToken({}), null);
  assert.equal(readRefreshToken({ cookies: { [env.refreshCookieName]: 'short' }, body: {} }), null);
  assert.equal(readRefreshToken({ cookies: {}, body: { refreshToken: 123 } }), null);
});

test('secure is on in production and off in development', () => {
  // Not a preference: a secure cookie is simply never stored over the plain
  // http dev server, and a non-secure one must never ship to production.
  assert.equal(typeof env.refreshCookieSecure, 'boolean');
  assert.equal(env.refreshCookieSecure, env.isProd);
});
