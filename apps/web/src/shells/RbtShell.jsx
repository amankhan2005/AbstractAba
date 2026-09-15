import { useQuery } from '@tanstack/react-query';
import { ShellFrame } from './ShellFrame.jsx';
import { Icon } from '@/ui/icons.jsx';
import { fetchBranding } from '@/api/client';
import { RbtActiveSessionBar } from '@/features/sessions/RbtActiveSessionBar.jsx';
import { useAuthStore } from '@/auth/store';
import { formatPersonName } from '@/lib/format';
import { PLATFORM_BRAND } from '@aba1on1/schemas';

/**
 * RBT experience — the technician's personal worklist. Everything is framed as
 * "mine" and "today": the first question the shell answers is "what do I need
 * to do today?", never "here is the whole clinic with rows removed".
 */
/**
 * Navigation labels use the plain professional terms a US clinic uses out loud:
 * "Clients", not "My children"; "Sessions", not "My sessions". The rail is
 * already the RBT's own scoped view, so repeating "My" on every row added no
 * information and read as translated rather than native.
 *
 * The ROUTES below are unchanged — these are label-only edits, so every existing
 * link, redirect and active-state match keeps working.
 */
const NAV = [
  {
    label: 'Today',
    items: [
      { to: '/dashboards/rbt', label: 'Dashboard', icon: Icon.Grid },
      // `end` matters: /sessions is a path PREFIX of every nested session route,
      // so without it the parent row stays lit alongside the child route and two
      // items appear active at once.
      // A session's detail page belongs to Sessions.
      { to: '/sessions', label: 'Sessions', icon: Icon.Clipboard, end: true, activeFor: ['/sessions/:sessionId'] },
      { to: '/sessions/manual', label: 'Manual Session', icon: Icon.Plus },
      { to: '/scheduling', label: 'Schedule', icon: Icon.Calendar },
    ],
  },
  {
    label: 'Caseload',
    items: [
      { to: '/clients', label: 'Clients', icon: Icon.Child },
      { to: '/plans', label: 'Programs', icon: Icon.Doc },
    ],
  },
  {
    // Account & security is removed from the RBT rail (spec §14) via
    // showAccountLink={false}; the RBT reaches their own profile (name +
    // password, read-only email) through the canonical /profile page (spec §15).
    label: 'Account',
    items: [
      { to: '/profile', label: 'Profile', icon: Icon.User },
    ],
  },
];

function greeting() {
  const hour = new Date().getHours();

  if (hour < 12) return 'Good Morning';
  if (hour < 18) return 'Good Afternoon';
  return 'Good Evening';
}

export function RbtShell() {
  // Authenticated RBT name comes from the existing authenticated principal.
  // Presentation-only capitalization; persisted user data is never modified.
  const fullName = useAuthStore((s) => s.principal?.user?.fullName) || '';
  const firstName =
    formatPersonName(fullName.trim().split(/\s+/)[0]) || 'there';

  // Company identity resolved by the backend from the authenticated membership →
  // organization; never supplied by the frontend. Safe Abstract ABA product-name fallback.
  const branding = useQuery({
    queryKey: ['org-branding'],
    queryFn: fetchBranding,
    staleTime: 60_000,
  });

  const b = branding.data ?? {};

  return (
    <>
      <ShellFrame
        shellClass="rx-shell--rbt"
        brand={{
          name: b.name || PLATFORM_BRAND.productName,
          logoUrl: b.logoUrl || null,
          mark: <Icon.User size={20} />,
        }}
        roleLabel="RBT Panel"
        nav={NAV}
        showAccountLink={false}
        confirmSignOut
        topbar={{
          title: `${greeting()}, ${firstName}`,
          subtitle: 'Your sessions, clients and hours',
        }}
      />

      {/* Persistent ongoing-session indicator — stays visible across the RBT
          panel while scrolling/navigating (RBT spec §6, §7). */}
      <RbtActiveSessionBar />
    </>
  );
}

export default RbtShell;