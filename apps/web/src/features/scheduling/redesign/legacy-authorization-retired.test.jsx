import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(resolve(here, p), 'utf8');

/**
 * REGRESSION — there is ONE authoritative ABA/FBA authorization create path
 * (ServiceAuthorization). The legacy old-model create path (AuthorizationsPage /
 * scheduling-Authorization create) must be fully retired, with no user-facing
 * route, search entry, or client helper left behind.
 */

describe('legacy authorization create path is retired', () => {
  it('the AuthorizationsPage component file no longer exists', () => {
    expect(() => src('../scheduling/AuthorizationsPage.jsx')).toThrow();
  });

  it('no route mounts AuthorizationsPage or /scheduling/authorizations', () => {
    const routes = src('../../../app/routes.jsx');
    expect(routes).not.toMatch(/AuthorizationsPage/);
    expect(routes).not.toMatch(/scheduling\/authorizations/);
  });

  it('global search no longer links to the retired authorizations page', () => {
    expect(src('../../../shells/GlobalSearch.jsx')).not.toMatch(/scheduling\/authorizations/);
  });

  it('the old-model createAuthorization client helper is gone; the authoritative one remains', () => {
    const api = src('../../../api/client.js');
    expect(api).not.toMatch(/export async function createAuthorization\b/);
    expect(api).toMatch(/export async function createServiceAuthorization\b/);
    expect(api).toMatch(/export async function transitionServiceAuthorization\b/);
  });

  it('scheduling inline create uses the authoritative ServiceAuthorization flow', () => {
    const sched = src('./SchedulingRedesign.jsx');
    expect(sched).toMatch(/createServiceAuthorization/);
    // No approval is driven from the booking modal — a saved authorization is usable.
    expect(sched).not.toMatch(/transitionServiceAuthorization/);
    expect(sched).not.toMatch(/\bcreateAuthorization\b/); // not the old model
  });
});
