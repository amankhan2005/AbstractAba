import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const modulesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'modules');

/**
 * ---------------------------------------------------------------------------
 * ROUTER WIRING — a structural invariant, checked statically.
 *
 * `requirePermission` resolves the caller's data scope by reading tenant-owned
 * models (staff profile, care-team assignments, supervision links). Those reads
 * only succeed inside an active tenant context, so a router that mounts
 * `requirePermission` without `enterTenantContext` throws TenantContextError on
 * every request.
 *
 * Six routers had exactly this defect — payroll, billing, claims, era,
 * reconciliation and reports. It was invisible for a long time because
 * authorization used to be a pure in-memory check against the token, needing
 * nothing from the database; each handler then opened its own withTenant()
 * further down. The moment authorization itself needed a context, every one of
 * those routes broke.
 *
 * Worse, the runtime suites did not catch it: those modules are tested against
 * their services directly rather than through the router, so the wiring was
 * never exercised. That is why this test reads the source instead of making a
 * request — it asserts the property that was actually missing, at the layer it
 * was missing from, and it will fail for the NEXT route added without a
 * context rather than waiting for a production 500.
 *
 * The platform-operator path is deliberately exempt: those routes run under
 * withPlatform() for cross-tenant work and are guarded by
 * requirePlatformOperator, which is a different boundary.
 * ---------------------------------------------------------------------------
 */

function routerFiles() {
  const found = [];
  for (const moduleName of readdirSync(modulesDir, { withFileTypes: true })) {
    if (!moduleName.isDirectory()) continue;
    const dir = join(modulesDir, moduleName.name);
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith('.routes.js')) {
        found.push({ name: `${moduleName.name}/${entry}`, source: readFileSync(join(dir, entry), 'utf8') });
      }
    }
  }
  return found;
}

test('every router that guards on a permission also establishes a tenant context', () => {
  const offenders = [];
  for (const { name, source } of routerFiles()) {
    if (!source.includes('requirePermission(')) continue;
    if (!source.includes('enterTenantContext')) offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    `These routers call requirePermission without enterTenantContext, so scope `
      + `resolution will throw on every request: ${offenders.join(', ')}`,
  );
});

test('routers mount the tenant context before any permission guard runs', () => {
  // Ordering matters as much as presence: authorize-then-scope reads models
  // outside a context. Mounting via `.use(...)` ahead of the route definitions
  // is the shape that guarantees it.
  const offenders = [];
  // Compare against the first ROUTE REGISTRATION that guards on a permission,
  // not the first textual mention of requirePermission — a module may
  // legitimately reference it earlier inside a helper that delegates to it.
  const routeWithGuard = /\.(get|post|patch|put|delete)\([^\n]*requirePermission\(/;
  for (const { name, source } of routerFiles()) {
    if (!source.includes('requirePermission(')) continue;
    const mount = source.search(/\.use\([^)]*enterTenantContext/);
    const firstGuardedRoute = source.search(routeWithGuard);
    if (firstGuardedRoute === -1) continue; // guards applied some other way
    assert.notEqual(mount, -1, `${name} never mounts enterTenantContext via .use()`);
    if (mount > firstGuardedRoute) offenders.push(name);
  }
  assert.deepEqual(offenders, [], `Tenant context is mounted after a permission guard in: ${offenders.join(', ')}`);
});

test('no tenant router reaches a permission guard without authentication', () => {
  const offenders = [];
  for (const { name, source } of routerFiles()) {
    if (!source.includes('requirePermission(')) continue;
    if (!source.includes('authenticate')) offenders.push(name);
  }
  assert.deepEqual(offenders, [], `Missing authenticate in: ${offenders.join(', ')}`);
});
