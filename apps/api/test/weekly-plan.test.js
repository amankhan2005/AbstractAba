import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateTargetSchema, createTargetSchema } from '../src/modules/plans/plans.schemas.js';
import { authorizationService } from '../src/modules/rbac/authorization.service.js';

/**
 * Phase 4 — BCBA weekly therapy plan → RBT.
 * Reuses the existing Treatment Plan → Goal → Program → Target model. The weekly
 * focus is two supported fields on the existing Target: weeklyFocus (is this part
 * of the current week's plan) + weeklyInstructions (BCBA's note to the RBT). No
 * new clinical system. Editing goes through the existing target PATCH
 * (plans.update + caseload scope); RBT has plans.read only.
 */

test('the target schema accepts weeklyFocus + weeklyInstructions (weekly plan fields)', () => {
  const ok = createTargetSchema.safeParse({ label: 'Tacts', weeklyFocus: true, weeklyInstructions: 'Run 10 trials, errorless.' });
  assert.equal(ok.success, true);
  const upd = updateTargetSchema.safeParse({ weeklyFocus: true, weeklyInstructions: 'This week: mands.' });
  assert.equal(upd.success, true);
});

test('weekly fields are optional and validated (bad types rejected, no unknown fields)', () => {
  assert.equal(updateTargetSchema.safeParse({ weeklyFocus: 'yes' }).success, false);
  assert.equal(updateTargetSchema.safeParse({ notAField: 1 }).success, false);
  // a plain status update still works without touching weekly fields
  assert.equal(updateTargetSchema.safeParse({ status: 'ACTIVE' }).success, true);
});

const perms = (r) => authorizationService.resolvePermissions({ roleKeys: [r], isPlatformOperator: false });

test('BCBA can update plans (set weekly focus) on their caseload; Company can too', () => {
  assert.equal(perms('bcba').get('plans.update'), 'TEAM');
  assert.equal(perms('owner').get('plans.update'), 'ORGANIZATION');
});

test('RBT can VIEW plans but CANNOT modify them (no plans.update / plans.create)', () => {
  const p = perms('rbt');
  assert.equal(p.get('plans.read'), 'SELF');
  assert.equal(p.has('plans.update'), false);
  assert.equal(p.has('plans.create'), false);
});
