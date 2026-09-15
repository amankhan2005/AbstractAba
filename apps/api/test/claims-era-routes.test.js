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
        (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { srv.close(); resolve({ status: res.statusCode }); }); });
      r.on('error', () => { srv.close(); resolve({ status: 0 }); });
      if (data) r.write(data); r.end();
    });
  });
}

test('claims & ERA routes require authentication', async () => {
  const app = createApp();
  const routes = [
    ['GET', '/api/v1/claims'], ['POST', '/api/v1/claims/generate'], ['POST', '/api/v1/claims/x/submit'],
    ['POST', '/api/v1/claims/x/transitions'], ['GET', '/api/v1/era/files'], ['POST', '/api/v1/era/files'],
    ['GET', '/api/v1/era/records'], ['POST', '/api/v1/era/records/x/resolve'],
  ];
  for (const [m, p] of routes) {
    const res = await req(app, m, p, m === 'POST' ? {} : null);
    assert.equal(res.status, 401, `${m} ${p} should be 401`);
  }
});

// Panel boundary (Blueprint §5.4): tenant Claims/ERA are Company-Panel only.
// The out-of-panel operator aggregate routers were retired — no /platform mount,
// no exported platform router — so the Console cannot reach tenant financial data.
test('platform claims/ERA overview routers are retired (not in the Console panel)', async () => {
  const claims = await import('../src/modules/claims/index.js');
  const era = await import('../src/modules/era/index.js');
  assert.equal(claims.claimsPlatformRouter, undefined, 'claimsPlatformRouter must be removed');
  assert.equal(era.eraPlatformRouter, undefined, 'eraPlatformRouter must be removed');
  // The tenant-panel routers remain intact.
  assert.ok(claims.claimsRouter, 'tenant claimsRouter must remain');
  assert.ok(era.eraRouter, 'tenant eraRouter must remain');
});
