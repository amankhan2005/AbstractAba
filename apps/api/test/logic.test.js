import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextBackoffDelayMs, DEFAULT_BACKOFF } from '../src/modules/jobs/job.backoff.js';
import { JobRegistry } from '../src/modules/jobs/job.registry.js';
import { authorizationService } from '../src/modules/rbac/authorization.service.js';

test('backoff grows exponentially and is capped', () => {
  assert.equal(nextBackoffDelayMs(1), 1000);
  assert.equal(nextBackoffDelayMs(2), 2000);
  assert.equal(nextBackoffDelayMs(3), 4000);
  assert.equal(nextBackoffDelayMs(100), DEFAULT_BACKOFF.maxMs);
});

test('job registry rejects duplicate types and bad attempts', () => {
  const r = new JobRegistry();
  r.register({ type: 't', handler: () => {}, maxAttempts: 3 });
  assert.throws(() => r.register({ type: 't', handler: () => {} }));
  assert.throws(() => new JobRegistry().register({ type: 'x', handler: () => {}, maxAttempts: 0 }));
});

test('RBAC: owner resolves the full foundation permission set', () => {
  const perms = authorizationService.resolvePermissions({ roleKeys: ['owner'] });
  assert.ok(perms.has('audit.read'));
  assert.ok(perms.has('organization.export'));
  assert.ok(perms.has('users.role.assign'));
});

test('RBAC: rbt is minimal and cannot export or read audit', () => {
  const svc = authorizationService;
  assert.equal(svc.can({ roleKeys: ['rbt'] }, 'organization.export'), false);
  assert.equal(svc.can({ roleKeys: ['rbt'] }, 'audit.read'), false);
  assert.equal(svc.can({ roleKeys: ['rbt'] }, 'organization.read'), true);
});

test('RBAC: platform operator holds only platform.* grants, no tenant role needed', () => {
  const perms = authorizationService.resolvePermissions({ isPlatformOperator: true });
  assert.ok(perms.has('platform.tenant.create'));
  assert.equal(perms.has('organization.export'), false);
});

test('RBAC: widest scope wins when two roles grant the same key', () => {
  const perms = authorizationService.resolvePermissions({ roleKeys: ['bcba', 'org_admin'] });
  assert.equal(perms.get('users.read'), 'ORGANIZATION'); // org_admin ORGANIZATION beats bcba TEAM
});
