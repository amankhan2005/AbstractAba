import { Card, Button, Icon, EmptyState } from '@/ui';
import { formatDateTime } from '@/lib/format';
import { useOrgTimezone } from '@/auth/store';
import { isStartableNow, appointmentOccurrence, occurrenceText } from '@/lib/appointment';
import { useStartWindowClock } from './useStartWindowClock.js';

/**
 * START SESSION — the prominent, top-of-dashboard action for beginning today's
 * work, shared by the BCBA and RBT dashboards.
 *
 * This is NOT a second way to create a session. It renders the panel cards the
 * dashboard already holds and calls the SAME start mutation the session list
 * uses, so the appointment → session flow, the duplicate-session guard and
 * every server-side check are unchanged. The only thing added is placement: a
 * clinician should not have to scroll a list to find the one thing they came
 * here to do.
 *
 * WHICH APPOINTMENTS APPEAR uses the SAME two conditions as the session list
 * below it: the server's `card.canStart` (lifecycle: scheduled or stopped, not
 * running) AND `isStartableNow` — the shared 24-hour start-window rule
 * (scheduled start → +24h per scheduled date, org timezone). Only appointments
 * whose window is open RIGHT NOW are listed: a 09/12 10:00 AM appointment is
 * listed until 09/13 09:59:59 AM and disappears at 10:00 AM, and the 09/13
 * appointment appears when its own window opens. useStartWindowClock re-renders
 * at exactly those instants. The backend recomputes the same rule and refuses
 * anything outside the window; this only avoids offering an action certain to
 * fail.
 *
 * With several startable appointments they are ALL listed rather than one being
 * picked arbitrarily — the clinician chooses. The panel hides itself entirely
 * while a session is running, because the active-session hero is then the
 * relevant control.
 */
export function StartSessionPanel({ cards = [], onStart, starting = false, startingId = null, childNameFor, hasRunning = false }) {
  const timeZone = useOrgTimezone() || 'UTC';
  const now = useStartWindowClock(cards, timeZone);
  if (hasRunning) return null;

  const startable = cards.filter((c) => c.canStart && isStartableNow(c, timeZone, now));
  if (startable.length === 0) {
    // Only shown when the clinician genuinely has assignments but none can be
    // started right now — never a fabricated appointment.
    if (cards.length === 0) return null;
    return (
      <Card className="rx-startpanel is-idle" title="Start a session" style={{ marginBottom: 16 }}>
        <EmptyState
          icon={Icon.Calendar}
          title="Nothing to start right now"
          body="None of your assigned appointments are available to start today."
        />
      </Card>
    );
  }

  const single = startable.length === 1;

  return (
    <Card
      className="rx-startpanel"
      title="Start a session"
      hint={single ? 'Ready to begin' : `${startable.length} available`}
      style={{ marginBottom: 16 }}
    >
      <div className="rx-list">
        {startable.map((card) => {
          const name = childNameFor ? childNameFor(card) : (card.childName || 'Client');
          // The OCCURRENCE being started (e.g. 09/13 of a 09/12 → 09/30 booking),
          // never the appointment's range start.
          const win = appointmentOccurrence(card, timeZone, now);
          const when = occurrenceText(card, timeZone, now);
          const startBy = win.windowEnd ? ` · Start by ${formatDateTime(new Date(win.windowEnd.getTime() - 60000), timeZone)}` : '';
          return (
            <div className="rx-row" key={card.appointmentId}>
              <div className="rx-row__main">
                <div className="rx-row__title" style={{ fontWeight: 700 }}>{name}</div>
                <div className="rx-row__meta">{when}{startBy}</div>
              </div>
              <Button
                icon={Icon.Clock}
                onClick={() => onStart(card.appointmentId)}
                loading={starting && startingId === card.appointmentId}
                disabled={starting}
                aria-label={`Start session with ${name}`}
              >
                Start Session
              </Button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export default StartSessionPanel;
