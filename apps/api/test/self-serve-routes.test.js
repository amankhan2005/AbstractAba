import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';

// NOTE: public self-serve signup is deliberately DEACTIVATED (routes/index.js
// no longer mounts modules/self-serve's router at /public). Company creation
// is invitation-only. The self-serve module's own service/schema code is
// left in place — a real future milestone per the blueprint — but nothing
// can reach it through the API. These tests were written against the old
// (mounted) behavior; they now assert the deactivation itself, so a future
// accidental re-mount is caught immediately instead of silently reopening a
// public company-creation bypass.

function req(app, method, path, body) {
  return new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, () => {
      const port = srv.address().port;
      const data = body ? JSON.stringify(body) : null;
      const r = http.request({ host: '127.0.0.1', port, path, method,
        headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
        (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { srv.close(); resolve({ status: res.statusCode, body: b }); }); });
      r.on('error', () => { srv.close(); resolve({ status: 0, body: '' }); });
      if (data) r.write(data); r.end();
    });
  });
}

test('public self-serve signup is deactivated: no request body can create a company through it', async () => {
  const app = createApp();
  const res = await req(app, 'POST', '/api/v1/public/signup', {});
  assert.equal(res.status, 410, 'signup must reply with an intentional 410, not a working endpoint');
  assert.match(res.body, /SIGNUP-410/);
  assert.match(res.body, /invitation-only/i);
});

test('public self-serve signup stays deactivated even with a fully valid-looking payload', async () => {
  const app = createApp();
  const res = await req(app, 'POST', '/api/v1/public/signup', {
    slug: 'bright-aba', legalName: 'Bright ABA LLC', tradingName: 'Bright ABA', countryCode: 'US',
    timezone: 'America/New_York', ownerFullName: 'Jane Doe', ownerEmail: 'jane@x.com',
    agreement: { version: 'v1', acceptedByName: 'Jane Doe', acceptedByTitle: 'CEO', accepted: true },
  });
  // Even a payload that would have passed the old validation schema must not
  // create anything — the handler never reaches the self-serve service at all.
  assert.equal(res.status, 410);
});

test('public self-serve signup is unauthenticated-reachable (returns 410, never 401) — proves it fails closed, not open', async () => {
  const app = createApp();
  const res = await req(app, 'POST', '/api/v1/public/signup', { anything: 'goes' });
  assert.notEqual(res.status, 401, 'a 401 here would suggest the route still does real work behind an auth check');
  assert.equal(res.status, 410);
});
