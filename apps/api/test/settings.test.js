import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { SettingsRegistry } from '../src/modules/settings/settings.registry.js';
import { SettingsService } from '../src/modules/settings/settings.service.js';

/** DB-free tests for settings: registry construction guards, resolution over
 *  defaults, registry-driven patch validation, and the service write flow. */

// --- registry construction -------------------------------------------------

test('registry rejects a duplicate namespace/key at construction', () => {
  assert.throws(() => new SettingsRegistry([
    { namespace: 'a', key: 'x', schema: z.number(), default: 1 },
    { namespace: 'a', key: 'x', schema: z.number(), default: 2 },
  ]), /duplicate "a.x"/);
});

test('registry rejects a default that fails its own schema', () => {
  assert.throws(() => new SettingsRegistry([
    { namespace: 'a', key: 'x', schema: z.number().min(10), default: 1 },
  ]), /does not satisfy its own schema/);
});

test('the shipped catalogue constructs and exposes the security + staffing namespaces', () => {
  const reg = new SettingsRegistry();
  assert.deepEqual(reg.namespaces(), ['security', 'staffing']);
  assert.equal(reg.has('security'), true);
  assert.equal(reg.has('staffing'), true);
  assert.equal(reg.has('nope'), false);
  // The BCBA weekly-hours target ships unconfigured (0) by default, so no
  // company shows a weekly goal until it opts in (BCBA panel spec §K).
  const staffing = reg.resolveNamespace('staffing', []);
  assert.equal(staffing.weeklyHoursTarget, 0);
  assert.equal(staffing.weekStartsOn, 0);
});

// --- resolution ------------------------------------------------------------

test('resolveNamespace overlays stored values on defaults', () => {
  const reg = new SettingsRegistry();
  const base = reg.resolveNamespace('security', []);
  assert.equal(base.sessionIdleTimeoutMinutes, 15);
  assert.equal(base.mfaRequiredForPrivilegedRoles, true);
  const overlaid = reg.resolveNamespace('security', [{ namespace: 'security', key: 'sessionIdleTimeoutMinutes', value: 30 }]);
  assert.equal(overlaid.sessionIdleTimeoutMinutes, 30);
});

test('resolve ignores stored rows for unregistered keys/namespaces', () => {
  const reg = new SettingsRegistry();
  const all = reg.resolve([
    { namespace: 'security', key: 'notRegistered', value: 'x' },
    { namespace: 'ghost', key: 'y', value: 'z' },
  ]);
  assert.equal('notRegistered' in all.security, false);
  assert.equal('ghost' in all, false);
});

test('resolveNamespace throws NOT_FOUND for an unknown namespace', () => {
  const reg = new SettingsRegistry();
  assert.throws(() => reg.resolveNamespace('nope', []), (e) => e.code === 'NOT_FOUND' && e.status === 404);
});

// --- patch validation ------------------------------------------------------

test('validatePatch: unknown namespace is NOT_FOUND', () => {
  const reg = new SettingsRegistry();
  assert.throws(() => reg.validatePatch('nope', { x: 1 }), (e) => e.code === 'NOT_FOUND');
});

test('validatePatch: empty patch is VALIDATION_FAILED', () => {
  const reg = new SettingsRegistry();
  assert.throws(() => reg.validatePatch('security', {}), (e) => e.code === 'VALIDATION_FAILED');
});

test('validatePatch: unknown key and bad value are rejected with detail', () => {
  const reg = new SettingsRegistry();
  assert.throws(() => reg.validatePatch('security', { madeUp: 1 }), (e) => e.code === 'VALIDATION_FAILED');
  assert.throws(() => reg.validatePatch('security', { sessionIdleTimeoutMinutes: 2 }), (e) => e.code === 'VALIDATION_FAILED'); // below min 5
  assert.throws(() => reg.validatePatch('security', { mfaRequiredForPrivilegedRoles: 'yes' }), (e) => e.code === 'VALIDATION_FAILED');
});

test('validatePatch: a valid patch returns the rows to persist', () => {
  const reg = new SettingsRegistry();
  const entries = reg.validatePatch('security', { sessionIdleTimeoutMinutes: 45, mfaRequiredForPrivilegedRoles: false });
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.find((e) => e.key === 'sessionIdleTimeoutMinutes'), { namespace: 'security', key: 'sessionIdleTimeoutMinutes', value: 45 });
});

// --- service ---------------------------------------------------------------

test('service.updateNamespace validates, persists, and returns effective values', async () => {
  const stored = [];
  const repo = {
    getSettings: async () => stored,
    upsertSettings: async (_t, entries) => { for (const e of entries) stored.push(e); },
  };
  const svc = new SettingsService({ repository: repo });
  const result = await svc.updateNamespace('t1', 'security', { sessionIdleTimeoutMinutes: 20 }, 'actor');
  assert.equal(result.sessionIdleTimeoutMinutes, 20);
  assert.equal(result.mfaRequiredForPrivilegedRoles, true); // default retained
});

test('service.updateNamespace rejects an invalid write before persisting', async () => {
  let persisted = false;
  const repo = { getSettings: async () => [], upsertSettings: async () => { persisted = true; } };
  const svc = new SettingsService({ repository: repo });
  await assert.rejects(() => svc.updateNamespace('t1', 'security', { sessionIdleTimeoutMinutes: 1 }, 'actor'), (e) => e.code === 'VALIDATION_FAILED');
  assert.equal(persisted, false);
});
