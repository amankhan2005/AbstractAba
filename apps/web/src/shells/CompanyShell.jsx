import { useQuery } from '@tanstack/react-query';
import { ShellFrame } from './ShellFrame.jsx';
import { Icon } from '@/ui/icons.jsx';
import { fetchBranding } from '@/api/client';
import { PLATFORM_BRAND } from '@aba1on1/schemas';

/**
 * COMPANY / ORGANIZATION experience — the clinic operations product. Its nav is
 * grouped as an operator sees the business (Care, Revenue cycle, Settings), and
 * its terminology is organizational ("Staff", "Payroll", "Branding"), distinct
 * from the clinician shells.
 */
const NAV = [
  { label: 'Overview', items: [
    { to: '/dashboards/organization', label: 'Dashboard', icon: Icon.Grid, end: false, activeFor: ['/dashboards/admin'] },
  ] },
  { label: 'Care', items: [
    { to: '/clients', label: 'Clients', icon: Icon.Child },
    { to: '/staff', label: 'Staff', icon: Icon.Users },
    { to: '/scheduling', label: 'Scheduling', icon: Icon.Calendar },
    { to: '/sessions', label: 'Sessions', icon: Icon.Clipboard, end: true, activeFor: ['/sessions/:sessionId'] },
    { to: '/sessions/oversight', label: 'Session Insights', icon: Icon.Chart, end: true },
    { to: '/plans', label: 'Treatment Plans', icon: Icon.Doc },
  ] },
  { label: 'Finance', items: [
    { to: '/insurance-billing', label: 'Billing', icon: Icon.Shield },
    { to: '/payroll', label: 'Payroll', icon: Icon.Wallet, end: true },
    { to: '/subscription', label: 'Subscription', icon: Icon.Sparkle },
  ] },
  { label: 'Settings', items: [
    { to: '/settings/company', label: 'Company Profile', icon: Icon.Building, end: true },
    { to: '/settings/email-templates', label: 'Email Templates', icon: Icon.Palette, end: true },
  ] },
];

export function CompanyShell() {
  // Company brand identity (name + logo) comes from the authenticated org's
  // branding — reused, not a new model. Colors/typography/layout stay central:
  // only the name and logo are tenant-controlled. Falls back to the shared
  // product name (PLATFORM_BRAND) until branding loads or when no name is set.
  const branding = useQuery({ queryKey: ['org-branding'], queryFn: fetchBranding, staleTime: 60_000 });
  const b = branding.data ?? {};
  return (
    <ShellFrame
      shellClass="rx-shell--company"
      brand={{ name: b.name || PLATFORM_BRAND.productName, logoUrl: b.logoUrl || null, mark: <Icon.Building size={20} /> }}
      roleLabel="Clinic Operations"
      nav={NAV}
      showAccountLink={false}
      showProductSignature={false}
      confirmSignOut
      topbar={{ title: 'Clinic Operations', subtitle: 'Organization-wide command center', fromNav: true }}
    />
  );
}

export default CompanyShell;
