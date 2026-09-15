import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';

function req(app, method, path) {
  return new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, () => {
      const port = srv.address().port;
      const r = http.request({ host: '127.0.0.1', port, path, method }, (res) => { res.on('data', () => {}); res.on('end', () => { srv.close(); resolve({ status: res.statusCode }); }); });
      r.on('error', () => { srv.close(); resolve({ status: 0 }); });
      r.end();
    });
  });
}

test('reconciliation & reports routes require authentication', async () => {
  const app = createApp();
  const routes = [
    '/api/v1/reports/overview', '/api/v1/reports/revenue', '/api/v1/reports/claims',
    '/api/v1/reports/collections', '/api/v1/reports/payroll', '/api/v1/reports/reconciliation',
    '/api/v1/reports/export/claims', '/api/v1/reconciliation', '/api/v1/reconciliation/queue',
  ];
  for (const p of routes) {
    const res = await req(app, 'GET', p);
    assert.equal(res.status, 401, `${p} should be 401`);
  }
});

// Panel boundary (Blueprint §5.4, §6.15): tenant Reconciliation, Financial
// Reports and Payroll are Company-Panel only; the Console's financial surface is
// strictly Revenue & Subscriptions. Their operator aggregate routers were retired.
test('platform reports/reconciliation/payroll overview routers are retired', async () => {
  const reports = await import('../src/modules/reports/index.js');
  const recon = await import('../src/modules/reconciliation/index.js');
  const payroll = await import('../src/modules/payroll/index.js');
  assert.equal(reports.reportsPlatformRouter, undefined, 'reportsPlatformRouter must be removed');
  assert.equal(recon.reconciliationPlatformRouter, undefined, 'reconciliationPlatformRouter must be removed');
  assert.equal(payroll.payrollPlatformRouter, undefined, 'payrollPlatformRouter must be removed');
  // Tenant-panel routers remain intact.
  assert.ok(reports.reportsRouter && recon.reconciliationRouter && payroll.payrollRouter);
});
