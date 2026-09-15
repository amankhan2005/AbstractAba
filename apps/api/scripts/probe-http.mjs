/**
 * Boots the real Express app WITHOUT connectDatabase().
 *
 * `server.js` fails fast when Mongo is unreachable, which is correct — but it
 * also means the HTTP layer cannot be observed at all in an environment with
 * no database. `app.js` is separable, so middleware order, auth guards, error
 * envelopes and status codes CAN be exercised for real. Anything that reaches
 * a repository will surface as a 500; that is expected here and is not a
 * finding.
 *
 *   node scripts/probe-http.mjs
 */
process.loadEnvFile?.('.env');

const { createApp } = await import('../src/app.js');
const app = await createApp();
const server = app.listen(4099);
await new Promise((r) => server.once('listening', r));

const call = async (method, path, { body, headers = {} } = {}) => {
  const res = await fetch(`http://127.0.0.1:4099${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON response */ }
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
};

const rows = [];
const probe = async (label, method, path, opts) => {
  const r = await call(method, path, opts);
  rows.push({
    label,
    status: r.status,
    code: r.json?.error?.code ?? '',
    message: String(r.json?.error?.message ?? r.json?.message ?? '').slice(0, 58),
  });
  return r;
};

await probe('GET /health', 'GET', '/api/v1/health');
await probe('GET /auth/me (no token)', 'GET', '/api/v1/auth/me');
await probe('GET /auth/me (bad token)', 'GET', '/api/v1/auth/me', { headers: { authorization: 'Bearer nope' } });
await probe('POST /auth/refresh (no cookie)', 'POST', '/api/v1/auth/refresh', { body: {} });
await probe('POST /public/signup (deactivated)', 'POST', '/api/v1/public/signup', { body: { name: 'X' } });
await probe('GET /clients (no auth)', 'GET', '/api/v1/clients');
await probe('GET /dashboards/organization', 'GET', '/api/v1/dashboards/organization');
await probe('GET /payroll/timesheets (no auth)', 'GET', '/api/v1/payroll/timesheets');
await probe('GET /claims (no auth)', 'GET', '/api/v1/claims');
await probe('GET /organization/branding (no auth)', 'GET', '/api/v1/organization/branding');
await probe('GET /public/guardian/<short>', 'GET', '/api/v1/public/guardian/abc');
await probe('GET /unknown-route', 'GET', '/api/v1/nope');

const signOut = await probe('POST /auth/sign-out (no cookie)', 'POST', '/api/v1/auth/sign-out', { body: {} });

console.log('LABEL'.padEnd(38), 'HTTP', 'CODE'.padEnd(14), 'MESSAGE');
console.log('-'.repeat(112));
for (const r of rows) {
  console.log(r.label.padEnd(38), String(r.status).padEnd(5), r.code.padEnd(14), r.message);
}

console.log('\nsign-out Set-Cookie:', signOut.setCookie ?? '(none)');

// Nothing user-facing may leak an internal identifier or a raw code.
const leaks = rows.filter((r) => /tenantId|Mongo|bearer token|ObjectId/i.test(r.message));
console.log('\nmessages leaking internals:', leaks.length === 0 ? 'none' : JSON.stringify(leaks));

server.close();
