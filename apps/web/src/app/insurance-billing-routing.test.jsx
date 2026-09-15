import { describe, it, expect } from 'vitest';
import { router } from './routes.jsx';
import { ClaimsRedesign } from '@/features/claims/redesign/ClaimsRedesign.jsx';
import { SubscriptionPage } from '@/features/billing/SubscriptionPage.jsx';

/**
 * Spec §1/§7 — Insurance billing (claims) has its OWN reachable route, distinct
 * from the company SaaS Billing page. /claims is a back-compat redirect to the
 * canonical insurance-billing route (never to SaaS /billing). No duplicate
 * billing/claims system: /insurance-billing reuses the existing ClaimsRedesign.
 */
function childRoutes() {
  const layout = router.routes.find((r) => Array.isArray(r.children));
  return layout?.children ?? [];
}
const routeFor = (path) => childRoutes().find((c) => c.path === path);

describe('Insurance billing routing', () => {
  it('/insurance-billing renders the existing ClaimsRedesign workflow', () => {
    const r = routeFor('insurance-billing');
    expect(r).toBeTruthy();
    expect(r.element.type).toBe(ClaimsRedesign);
  });

  it('/billing is removed from active UI — it redirects to /insurance-billing', () => {
    const r = routeFor('billing');
    expect(r.element.props.to).toBe('/insurance-billing');
  });

  it('/reports is removed from active UI — it redirects to /', () => {
    const r = routeFor('reports');
    expect(r.element.props.to).toBe('/');
  });

  it('/subscription still renders the Subscription page (unchanged)', () => {
    expect(routeFor('subscription').element.type).toBe(SubscriptionPage);
  });

  it('/claims redirects to /insurance-billing, never to SaaS /billing', () => {
    const r = routeFor('claims');
    expect(r.element.props.to).toBe('/insurance-billing');
  });

  it('/claims/:claimId redirects to /insurance-billing too', () => {
    expect(routeFor('claims/:claimId').element.props.to).toBe('/insurance-billing');
  });

  it('/payroll/timesheets (page removed) redirects to /payroll; Payroll itself is unchanged', () => {
    expect(routeFor('payroll/timesheets').element.props.to).toBe('/payroll');
    expect(routeFor('payroll/timesheets/*').element.props.to).toBe('/payroll');
    expect(routeFor('payroll').element.type.name).toBe('PayrollRedesign');
    expect(routeFor('sessions/oversight').element.type.name).toBe('AdminSessionOversightPage');
  });
});
