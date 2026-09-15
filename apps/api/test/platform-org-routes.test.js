import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUsersRouters } from '../src/modules/users/users.routes.js';

/**
 * Contract tests for the platform (operator) user routes on an organization.
 * These pin the exact paths the Console client depends on, catching the stale
 * `/owner` and `/users/invitations/...` references that were returning 404.
 */
function platformRoutePaths() {
  const { platform } = createUsersRouters({});
  const routes = [];
  for (const layer of platform.stack) {
    if (layer.route) {
      for (const m of Object.keys(layer.route.methods)) {
        routes.push(`${m.toUpperCase()} ${layer.route.path}`);
      }
    }
  }
  return routes;
}

test('platform org user routes expose the exact contract the Console calls', () => {
  const routes = platformRoutePaths();
  assert.ok(routes.includes('POST /:id/owner-invitations'), 'owner invite route missing');
  assert.ok(routes.includes('GET /:id/users'), 'operator member-list route missing');
  assert.ok(
    routes.includes('POST /:id/owner-invitations/:invitationId/resend'),
    'operator owner-invite resend route missing',
  );
});

test('the stale /:id/owner path is NOT registered (it was the 404 source)', () => {
  const routes = platformRoutePaths();
  assert.ok(!routes.includes('POST /:id/owner'), 'stale /owner route should not exist');
  assert.ok(
    !routes.includes('POST /:id/users/invitations/:invitationId/resend'),
    'stale tenant-shaped resend path should not be on the platform router',
  );
});
