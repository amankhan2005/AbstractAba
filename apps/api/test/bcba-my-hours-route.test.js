import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';

function req(app, method, path) {
  return new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, () => {
      const port = srv.address().port;
      const r = http.request({ host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json' } },
        (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { srv.close(); resolve({ status: res.statusCode, body: b }); }); });
      r.on('error', () => { srv.close(); resolve({ status: 0, body: '' }); });
      r.end();
    });
  });
}

test('GET /api/v1/bcba/my-hours requires authentication (staffProfileId is never taken from the client)', async () => {
  const app = createApp();
  const res = await req(app, 'GET', '/api/v1/bcba/my-hours');
  assert.equal(res.status, 401);
});

test('GET /api/v1/bcba/my-hours rejects an unknown period even unauthenticated-first (auth gate precedes it)', async () => {
  const app = createApp();
  // Auth is checked before validation, so this is 401 (never a 200 leak).
  const res = await req(app, 'GET', '/api/v1/bcba/my-hours?period=forever');
  assert.equal(res.status, 401);
});
