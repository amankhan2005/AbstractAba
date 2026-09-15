import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';

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

test('operator billing routes require authentication', async () => {
  const app = createApp();
  for (const [m, p] of [['GET', '/api/v1/platform/billing/plans'], ['POST', '/api/v1/platform/billing/subscriptions'], ['GET', '/api/v1/platform/billing/overview']]) {
    const res = await req(app, m, p, m === 'POST' ? {} : null);
    assert.equal(res.status, 401, `${m} ${p} should be 401`);
  }
});

test('tenant billing routes require authentication', async () => {
  const app = createApp();
  for (const p of ['/api/v1/billing/invoices', '/api/v1/billing/balance', '/api/v1/billing/subscription']) {
    const res = await req(app, 'GET', p);
    assert.equal(res.status, 401, `${p} should be 401`);
  }
});
