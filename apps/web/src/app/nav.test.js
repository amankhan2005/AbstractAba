import { describe, expect, it } from 'vitest';
import { buildAppNav } from './nav';

describe('tenant shell navigation', () => {
  it('always includes Home and gates everything else on permissions', () => {
    const labels = buildAppNav([]).map((n) => n.label);
    expect(labels).toContain('Home');
    // The design-system reference page is no longer surfaced in the tenant nav.
    expect(labels).not.toContain('Design system');
  });

  it('shows Dashboards only with dashboards.read', () => {
    expect(buildAppNav([]).map((n) => n.label)).not.toContain('Dashboards');
    const nav = buildAppNav(['dashboards.read']);
    const d = nav.find((n) => n.label === 'Dashboards');
    expect(d).toBeDefined();
    expect(d.to).toBe('/dashboards');
  });

  it('hides Clients without clients.read', () => {
    const labels = buildAppNav(['organization.read']).map((n) => n.label);
    expect(labels).not.toContain('Clients');
  });

  it('shows Clients when the principal can read clients', () => {
    const nav = buildAppNav(['clients.read']);
    const clients = nav.find((n) => n.label === 'Clients');
    expect(clients).toBeDefined();
    expect(clients.to).toBe('/clients');
  });

  it('shows Staff only with staff.read', () => {
    expect(buildAppNav([]).map((n) => n.label)).not.toContain('Staff');
    const nav = buildAppNav(['staff.read']);
    const staff = nav.find((n) => n.label === 'Staff');
    expect(staff).toBeDefined();
    expect(staff.to).toBe('/staff');
  });

  it('shows Supervision only with supervision.log', () => {
    expect(buildAppNav([]).map((n) => n.label)).not.toContain('Supervision');
    expect(buildAppNav(['staff.read']).map((n) => n.label)).not.toContain('Supervision');
    const nav = buildAppNav(['supervision.log']);
    const sup = nav.find((n) => n.label === 'Supervision');
    expect(sup).toBeDefined();
    expect(sup.to).toBe('/supervision');
  });

  it('shows Scheduling only with scheduling.read', () => {
    expect(buildAppNav([]).map((n) => n.label)).not.toContain('Scheduling');
    const nav = buildAppNav(['scheduling.read']);
    const s = nav.find((n) => n.label === 'Scheduling');
    expect(s).toBeDefined();
    expect(s.to).toBe('/scheduling');
  });

  it('shows Plans only with plans.read', () => {
    expect(buildAppNav([]).map((n) => n.label)).not.toContain('Plans');
    const nav = buildAppNav(['plans.read']);
    const p = nav.find((n) => n.label === 'Plans');
    expect(p).toBeDefined();
    expect(p.to).toBe('/plans');
  });

  it('shows Sessions only with sessions.read', () => {
    expect(buildAppNav([]).map((n) => n.label)).not.toContain('Sessions');
    const nav = buildAppNav(['sessions.read']);
    const s = nav.find((n) => n.label === 'Sessions');
    expect(s).toBeDefined();
    expect(s.to).toBe('/sessions');
  });

  it('shows Documents only with documents.read', () => {
    expect(buildAppNav([]).map((n) => n.label)).not.toContain('Documents');
    const nav = buildAppNav(['documents.read']);
    const d = nav.find((n) => n.label === 'Documents');
    expect(d).toBeDefined();
    expect(d.to).toBe('/documents');
  });
});

import { describe as d2, it as i2, expect as e2 } from 'vitest';
import { buildAppNav as buildNav2 } from './nav';
d2('billing nav gating', () => {
  i2('shows Billing only with billing.read', () => {
    e2(buildNav2(['billing.read']).some((x) => x.to === '/billing')).toBe(true);
    e2(buildNav2([]).some((x) => x.to === '/billing')).toBe(false);
  });
});

import { describe as d3, it as i3, expect as e3 } from 'vitest';
import { buildAppNav as buildNav3 } from './nav';
d3('payroll nav gating', () => {
  i3('never links the removed Timesheets page (even with timesheets.read); Payroll with payroll.read', () => {
    e3(buildNav3(['timesheets.read', 'payroll.read']).some((x) => x.to === '/payroll/timesheets')).toBe(false);
    e3(buildNav3(['payroll.read']).some((x) => x.to === '/payroll')).toBe(true);
    e3(buildNav3([]).some((x) => x.to === '/payroll')).toBe(false);
  });
});

import { describe as d4, it as i4, expect as e4 } from 'vitest';
import { buildAppNav as buildNav4 } from './nav';
d4('claims/ERA nav gating', () => {
  i4('never shows the removed Claims page; ERA still shows with era.read', () => {
    // The Claim page was removed from the user-facing app (claims backend stays).
    e4(buildNav4(['claims.read']).some((x) => x.to === '/claims')).toBe(false);
    e4(buildNav4(['era.read']).some((x) => x.to === '/era')).toBe(true);
    e4(buildNav4([]).some((x) => x.to === '/claims')).toBe(false);
  });
});

import { describe as d5, it as i5, expect as e5 } from 'vitest';
import { buildAppNav as buildNav5 } from './nav';
d5('reports/reconciliation nav gating', () => {
  i5('gates Reports and Reconciliation on their permissions', () => {
    e5(buildNav5(['finance.reports.read']).some((x) => x.to === '/reports')).toBe(true);
    e5(buildNav5(['reconciliation.read']).some((x) => x.to === '/reconciliation')).toBe(true);
    e5(buildNav5([]).some((x) => x.to === '/reports')).toBe(false);
  });
});
