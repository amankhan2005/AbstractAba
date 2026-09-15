import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(here, '..', 'src', p), 'utf8');

/**
 * Financial mutations must be recorded to the hash-chained audit log. These are
 * static-source assertions (the append path needs a live DB, which the sandbox
 * cannot reach): they prove every financial service imports recordSafely and
 * emits the expected actions. If a future edit drops an audit call, this fails.
 */

const EXPECTED = {
  'modules/billing/billing.service.js': [
    'billing.invoice_generated', 'billing.invoice_voided', 'billing.payment_recorded',
    'billing.payment_refunded', 'billing.credit_issued', 'billing.subscription_assigned',
    'billing.subscription_transitioned',
  ],
  'modules/payroll/payroll.service.js': ['timesheet.transitioned', 'payroll_run.transitioned'],
  'modules/claims/claims.service.js': ['claim.generated', 'claim.transitioned'],
  'modules/era/era.service.js': ['era.uploaded', 'era.processed', 'era.record_resolved'],
  'modules/reconciliation/reconciliation.service.js': ['reconciliation.transitioned'],
  'modules/documents/documents.service.js': ['document.file_attached'],
  'modules/supervision/supervision.service.js': [
    'supervision.observation_created', 'supervision.observation_transitioned',
    'supervision.hours_posted', 'supervision.hours_recorded', 'supervision.observation_superseded',
  ],
  'modules/scheduling/scheduling.service.js': [
    'scheduling.series_created', 'scheduling.series_cancelled', 'scheduling.occurrence_cancelled',
  ],
  'modules/bulk/bulk.service.js': [
    'bulk.import_started', 'bulk.import_completed', 'bulk.import_failed',
    'organization.export_generated', 'organization.export_failed', 'organization.export_downloaded',
  ],
  'modules/self-serve/selfServe.service.js': [
    'organization.self_serve_signup',
  ],
};

for (const [file, actions] of Object.entries(EXPECTED)) {
  test(`${file} wires audit recording for its financial mutations`, () => {
    const code = src(file);
    assert.match(code, /recordSafely/, `${file} must import/use recordSafely`);
    for (const action of actions) {
      assert.ok(code.includes(`'${action}'`), `${file} must emit audit action ${action}`);
    }
  });
}

test('no financial service falsely claims audit without wiring it', () => {
  const recon = src('modules/reconciliation/reconciliation.service.js');
  // The old, false comment must be gone; the real one must reference recordSafely.
  assert.ok(!/every mutation is audited by the recorder/.test(recon));
  assert.match(recon, /recordSafely/);
});

test('errorHandler does not leak duplicate-key VALUES (only field names)', () => {
  const eh = src('common/errors/errorHandler.js');
  // The handler must not spread err.keyValue into the response details.
  assert.ok(!/details:\s*err\.keyValue/.test(eh), 'must not return err.keyValue');
  assert.match(eh, /Object\.keys\(err\.keyValue\)/, 'should surface field names only');
});

test('billing service no longer carries the dead processor provider param', () => {
  const billing = src('modules/billing/billing.service.js');
  assert.ok(!/this\.provider\s*=/.test(billing), 'dead provider assignment must be removed');
  assert.ok(!/injected\s+provider/.test(billing), 'misleading processor comment must be gone');
});
