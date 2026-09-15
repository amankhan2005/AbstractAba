import { Link, useLocation } from 'react-router-dom';
import { Icon } from '@/ui/icons.jsx';
import { useSessionTimer } from '@/features/sessions/useSessionTimer.js';
import { useBcbaNames, useBcbaActiveSession } from '@/features/sessions/useBcbaSession.js';

/**
 * A persistent, discoverable active-session indicator (spec §D). Mounted in the
 * BCBA shell, so a running session stays visible while the BCBA moves between the
 * Panel, Schedule, Review queue, Treatment plans, a Child page and the Dashboard.
 *
 * It reuses the ONE persisted session and the ONE server-anchored timer — it
 * never starts a second session or a second clock. The elapsed time reconstructs
 * from the server startedAt (so it is correct after a refresh), and the child's
 * NAME is shown, never an id (spec §A/§B). On the panel route itself it hides,
 * because the panel already shows the detailed active-session hero.
 */
export function BcbaActiveSessionBar() {
  const location = useLocation();
  // Poll so the bar appears/disappears as sessions start and complete elsewhere.
  const { running } = useBcbaActiveSession({ refetchInterval: 20_000 });
  const names = useBcbaNames();
  // The running WORK PERIOD's start, not the session's — see useSessionTimer.
  const timerAnchor = running?.activePeriodStartedAt ?? running?.startedAt ?? null;
  const { text, ready } = useSessionTimer(timerAnchor, Boolean(running && timerAnchor));

  const onPanel = location.pathname.startsWith('/sessions/panel');
  if (!running || onPanel) return null;

  return (
    <Link
      to="/sessions/panel"
      role="status"
      aria-label={`Session in progress with ${names.clientName(running.clientId)}. Open the session panel.`}
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
      <span className="rx-row__meta">{names.clientName(running.clientId)}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 800, letterSpacing: 1 }}>{ready ? text : '—'}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 600 }}>
        <Icon.Arrow size={14} /> Open
      </span>
    </Link>
  );
}

export default BcbaActiveSessionBar;
