import { Link, useLocation } from 'react-router-dom';
import { Icon } from '@/ui/icons.jsx';
import { useSessionTimer } from '@/features/sessions/useSessionTimer.js';
import { useBcbaNames, useRbtActiveSession } from '@/features/sessions/useBcbaSession.js';

/**
 * Persistent ongoing-session indicator for the RBT panel (RBT spec §6, §7). It
 * is mounted in the RBT SHELL, so a running session stays visible at the top of
 * the viewport while the technician moves between My day, My sessions, My
 * schedule, a child page and the treatment plan — and while the panel content
 * is scrolled. It reuses the ONE persisted session (useRbtActiveSession) and the
 * ONE server-anchored timer (elapsed reconstructs from the persisted startedAt,
 * so a refresh never resets it and navigation never loses it). It never starts a
 * second session or a second clock, and it shows the child's NAME, never an id.
 *
 * On the dashboard route itself it hides, because the dashboard already renders
 * the full ongoing-session hero at the very top of its content.
 */
export function RbtActiveSessionBar() {
  const location = useLocation();
  // Poll so the bar appears/disappears as sessions start and complete.
  const { running } = useRbtActiveSession({ refetchInterval: 20_000 });
  const names = useBcbaNames();
  // The running WORK PERIOD's start, not the session's — see useSessionTimer.
  const timerAnchor = running?.activePeriodStartedAt ?? running?.startedAt ?? null;
  const { text, ready } = useSessionTimer(timerAnchor, Boolean(running && timerAnchor));

  const onDashboard = location.pathname.startsWith('/dashboards/rbt');
  if (!running || onDashboard) return null;

  const childName = running.childName || names.clientName(running.clientId);

  return (
    <Link
      to="/dashboards/rbt"
      role="status"
      aria-label={`Session in progress with ${childName}. Open your dashboard.`}
      className="rx-activesession-bar"
      style={{
        position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: 18, zIndex: 11000,
        display: 'flex', alignItems: 'center', gap: 14, textDecoration: 'none',
        padding: '10px 18px', borderRadius: 999,
        background: 'var(--rx-surface, #fff)', color: 'var(--rx-text, #111)',
        border: '2px solid var(--rx-accent, #6d28d9)', boxShadow: '0 10px 30px rgba(0,0,0,.18)',
      }}
    >
      <span style={{ display: 'inline-flex', width: 10, height: 10, borderRadius: 999, background: 'var(--rx-accent, #6d28d9)' }} aria-hidden />
      <span style={{ fontWeight: 700 }}>Session in progress</span>
      <span className="rx-row__meta">{childName}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 800, letterSpacing: 1 }}>{ready ? text : '—'}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 600 }}>
        <Icon.Arrow size={14} /> Open
      </span>
    </Link>
  );
}

export default RbtActiveSessionBar;
