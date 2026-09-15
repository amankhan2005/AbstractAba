import { useQuery } from '@tanstack/react-query';
import {
  PageHeader, Card, Icon, EmptyState, QueryBoundary,
} from '@/ui';
import { getBcbaWeeklyHours } from '@/api/client';
import { useBcbaNames, useBcbaActiveSession } from './useBcbaSession.js';
import {
  ActiveSessionHero, WeeklyProgress, AppointmentSection, BcbaCompletionModal,
  useBcbaSessionActions,
} from './bcbaSessionUi.jsx';
import { useOrgTimezone } from '@/auth/store';
import { groupSessionCards } from '@/lib/appointment';
import { useStartWindowClock } from './useStartWindowClock.js';

/**
 * BCBA Session Panel — the spec's connected workflow. An ACTIVE session, when
 * one exists, is shown as a prominent hero at the very TOP of the page (spec §C),
 * above the weekly-progress summary and the appointment grid. Every value the
 * BCBA sees is human-readable: child and RBT names (never ids), a human
 * appointment window and clock times (never ISO strings), and the resolved
 * authorization label (never a `svc:` id). The running timer reconstructs from
 * the server-persisted startedAt (spec §5) so a refresh never resets it.
 *
 * The appointment cards, the Start/Stop/Finish wiring and the completion modal
 * are the SHARED board (bcbaSessionUi) that the BCBA Dashboard also renders, so
 * there is exactly one BCBA session UI/flow — never a duplicate (Part 32/33).
 */
export function BcbaSessionPanelPage() {
  const { panel, cards, running } = useBcbaActiveSession();
  const names = useBcbaNames();
  const weekly = useQuery({ queryKey: ['bcba', 'weekly-hours'], queryFn: () => getBcbaWeeklyHours() });

  // One shared Start/Stop/Complete controller for both the hero and the cards.
  const actions = useBcbaSessionActions();

  // Grouped by the shared 24-hour start-window rule (never by calendar date),
  // re-evaluated exactly when a window opens or closes.
  const timeZone = useOrgTimezone();
  const now = useStartWindowClock(cards, timeZone);
  const { current: currentCards, upcoming: upcomingCards, expired: expiredCards } = groupSessionCards(cards, timeZone, now);

  return (
    <div className="rx-cw rx-cw--panel">
      <PageHeader
        eyebrow="Session delivery"
        title="Session Panel"
        subtitle="Start a session, run the timer, then stop to record the authorization, memo and worked time."
      />

      {/* ACTIVE SESSION — the dominant element whenever one is running (spec §C). */}
      {running && (
        <ActiveSessionHero
          card={running}
          childName={running.childName || names.clientName(running.clientId)}
          onStop={() => actions.stopM.mutate(running.appointmentId)}
          stopping={actions.stopM.isPending}
        />
      )}

      {/* THIS WEEK — only when the company has configured a target (spec §K). */}
      {weekly.data?.configured && <WeeklyProgress data={weekly.data} />}

      <QueryBoundary query={panel}>
        {cards.length === 0 ? (
          <Card>
            <EmptyState
              icon={Icon.Calendar}
              title="No appointments assigned to you"
              body="Appointments booked with you as the BCBA appear here, ready to start."
            />
          </Card>
        ) : (
          <>
            <AppointmentSection id="panel-current" title="Current sessions" cards={currentCards} names={names} actions={actions}
              emptyHint="No session is open to start right now." />
            <AppointmentSection id="panel-upcoming" title="Upcoming appointments" cards={upcomingCards} names={names} actions={actions} />
            <AppointmentSection id="panel-expired" title="Expired appointments" cards={expiredCards} names={names} actions={actions} limit={8} order="desc" />
          </>
        )}
      </QueryBoundary>

      <BcbaCompletionModal actions={actions} cards={cards} names={names} />
    </div>
  );
}

export default BcbaSessionPanelPage;
