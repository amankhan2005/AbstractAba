import { useQuery } from '@tanstack/react-query';
import { ShellFrame } from './ShellFrame.jsx';
import { Icon } from '@/ui/icons.jsx';
import { fetchBranding } from '@/api/client';
import { useAuthStore } from '@/auth/store';
import { formatPersonName } from '@/lib/format';
import { BcbaActiveSessionBar } from '@/features/sessions/BcbaActiveSessionBar.jsx';
import { PLATFORM_BRAND } from '@aba1on1/schemas';

/**
 * Time-of-day greeting using the local browser clock.
 * Matches the BCBA Dashboard greeting behavior.
 */
function greeting(now = new Date()) {
  const h = now.getHours();
  if (h < 12) return 'Good Morning';
  if (h < 17) return 'Good Afternoon';
  return 'Good Evening';
}

/**
 * BCBA experience — clinical supervision. The nav speaks the clinician's
 * language and leads with the sign-off work a BCBA owns. Staff/Supervisees and
 * the Supervision log are intentionally NOT in the BCBA rail (spec §2), and
 * Account & security is replaced by a dedicated Profile page (§3, §14) via
 * showAccountLink={false}. Every item maps to exactly one canonical route (§5).
 */
const NAV = [
  { label: 'Overview', items: [
    { to: '/dashboards/bcba', label: 'Dashboard', icon: Icon.Grid },
  ] },
  { label: 'Clinical', items: [
    { to: '/clients', label: 'My Caseload', icon: Icon.Child },
    { to: '/sessions/panel', label: 'Session Panel', icon: Icon.Clock },
    { to: '/sessions/manual', label: 'Manual Session', icon: Icon.Plus },
    { to: '/plans', label: 'Treatment Plans', icon: Icon.Clipboard },
    // A session's detail page belongs to the Review Queue.
    { to: '/sessions', label: 'Review Queue', icon: Icon.Inbox, end: true, activeFor: ['/sessions/:sessionId'] },
    { to: '/scheduling', label: 'Schedule', icon: Icon.Calendar },
  ] },
  { label: 'Account', items: [
    { to: '/profile', label: 'Profile', icon: Icon.User },
  ] },
];

export function BcbaShell() {
  const branding = useQuery({
    queryKey: ['org-branding'],
    queryFn: fetchBranding,
    staleTime: 60_000,
  });

  const fullName = useAuthStore((s) => s.principal?.user?.fullName) || '';
  const firstName = formatPersonName(fullName.trim().split(/\s+/)[0]);

  const b = branding.data ?? {};

  return (
    <>
      <ShellFrame
        shellClass="rx-shell--bcba"
        brand={{
          name: b.name || PLATFORM_BRAND.productName,
          logoUrl: b.logoUrl || null,
          mark: <Icon.Shield size={20} />,
        }}
        roleLabel="BCBA Panel"
        nav={NAV}
        showAccountLink={false}
        confirmSignOut
        topbar={{
          title: firstName ? `${greeting()}, ${firstName}` : 'Your clinical board',
          subtitle: 'Clinical supervision and treatment planning',
        }}
      />

      {/* Persistent, cross-page active-session indicator (spec §D). */}
      <BcbaActiveSessionBar />
    </>
  );
}

export default BcbaShell;