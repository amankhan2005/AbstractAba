import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getRbtDashboard, startRbtSession, stopRbtSession,
  completeRbtSession, getRbtMyHours, getRbtChildDetail, saveRbtSessionDocumentation,
} from '@/api/client';
import { PageHeader, Card, QueryBoundary, Icon, EmptyState } from '@/ui';
import { useOrgTimezone } from '@/auth/store';
import { groupSessionCards } from '@/lib/appointment.js';
import { StartSessionPanel } from '@/features/sessions/StartSessionPanel.jsx';
import { useStartWindowClock } from '@/features/sessions/useStartWindowClock.js';
import { useBcbaNames, useRbtActiveSession } from '@/features/sessions/useBcbaSession.js';
import { ActiveSessionHero, SessionCompletionModal, SessionQueue } from '@/features/sessions/bcbaSessionUi.jsx';
import { MyHoursCard } from './MyHoursCard.jsx';
import { DashboardStat as Stat } from './DashboardStat.jsx';

/**
 * RBT DASHBOARD — the technician's working day, top to bottom:
 *
 *   1. NOW      the running session (timer, read-only treatment plan, Session
 *               Memo, Stop) — or, when nothing runs, the sessions that can be
 *               started right now with a prominent Start Session.
 *   2. TODAY    current and upcoming appointments as one compact queue.
 *   3. HOURS    My Hours (worked time only — never pay).
 *   4. WORK     real documentation counts from the RBT dashboard API.
 *   5. PAST     past appointments, most recent first, limited with "Show all".
 *
 * Everything is server-scoped: panel/start/stop/complete/my-hours reuse the same
 * session pipeline the BCBA uses, served over /v1/rbt/* for the acting RBT. The
 * RBT workflow is the Session Memo (no BCBA clinical documentation fields).
 */
export function RbtDashboardPage() {
  const qc = useQueryClient();
  const dashboard = useQuery({ queryKey: ['dashboard', 'rbt'], queryFn: () => getRbtDashboard() });
  const d = dashboard.data;

  const { panel, cards, running } = useRbtActiveSession();
  const names = useBcbaNames();

  const [completing, setCompleting] = useState(null);
  const [startError, setStartError] = useState({});

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['rbt', 'panel'] });
    qc.invalidateQueries({ queryKey: ['rbt', 'my-hours'] });
    qc.invalidateQueries({ queryKey: ['dashboard', 'rbt'] });
  };

  const startM = useMutation({
    mutationFn: (id) => startRbtSession(id),
    onMutate: (id) => setStartError((e) => { const { [id]: _drop, ...rest } = e; return rest; }),
    onSuccess: refresh,
    onError: (err, id) => {
      setStartError((e) => ({ ...e, [id]: err?.response?.data?.error?.message || 'Could not start the session. Please try again.' }));
      refresh();
    },
  });
  const stopM = useMutation({
    mutationFn: (id) => stopRbtSession(id),
    onSuccess: (payload) => { setCompleting(payload); refresh(); },
  });

  // Grouped by the shared 24-hour start-window rule (never by calendar date),
  // re-evaluated exactly when a window opens or closes.
  const orgTimeZone = useOrgTimezone();
  const now = useStartWindowClock(cards, orgTimeZone);
  const { current, upcoming, expired } = groupSessionCards(cards, orgTimeZone, now);
  const childNameFor = (c) => c.childName || names.clientName(c.clientId);

  const queueProps = {
    childNameFor,
    startError,
    onStart: (id) => startM.mutate(id),
    onStop: (id) => stopM.mutate(id),
    startingId: startM.isPending ? startM.variables : null,
    stoppingId: stopM.isPending ? stopM.variables : null,
  };
  const completingCard = completing ? cards.find((c) => c.appointmentId === completing.appointmentId) : null;

  return (
    <div className="rx-cw rx-cw--rbt">
      <PageHeader
        eyebrow="Today"
        title="Dashboard"
        subtitle="Your sessions, clients and hours."
        actions={<Link className="rx-btn rx-btn--ghost" to="/scheduling"><Icon.Calendar size={16} />View schedule</Link>}
      />

      {/* 1. NOW */}
      {running ? (
        <ActiveSessionHero
          card={running}
          childName={childNameFor(running)}
          onStop={() => stopM.mutate(running.appointmentId)}
          stopping={stopM.isPending}
          fetchChildDetail={getRbtChildDetail}
          detailKey="rbt"
          saveDocumentation={saveRbtSessionDocumentation}
          /* RBT workflow: Session Memo + read-only treatment plan. The BCBA's
             clinical documentation fields are not part of it, and the server
             rejects them from an RBT regardless. */
          variant="rbt"
        />
      ) : (
        <StartSessionPanel
          cards={cards}
          onStart={(appointmentId) => startM.mutate(appointmentId)}
          starting={startM.isPending}
          startingId={startM.variables ?? null}
          childNameFor={childNameFor}
          hasRunning={false}
        />
      )}

      <div className="rx-cw__grid">
        <div className="rx-cw__main">
          {/* 2. TODAY */}
          <QueryBoundary query={panel}>
            {cards.length === 0 ? (
              <Card>
                <EmptyState icon={Icon.Calendar} title="No sessions assigned to you" body="Sessions booked with you as the RBT appear here, ready to start." />
              </Card>
            ) : (
              <>
                <SessionQueue id="rbt-current" title="Current sessions" cards={current} emptyHint="No session is open to start right now." {...queueProps} />
                <SessionQueue id="rbt-upcoming" title="Upcoming" cards={upcoming} {...queueProps} />
                {/* 5. PAST */}
                <SessionQueue id="rbt-past" title="Past appointments" cards={expired} limit={5} order="desc" {...queueProps} />
              </>
            )}
          </QueryBoundary>
        </div>

        <aside className="rx-cw__side" aria-label="Hours and work summary">
          {/* 3. HOURS */}
          <MyHoursCard fetchHours={getRbtMyHours} role="rbt" />

          {/* 4. WORK — real counts from the RBT dashboard API. */}
          <Card title="Your work" hint="Across your assigned clients">
            <QueryBoundary query={dashboard}>
              {d && (
                <>
                  <dl className="rx-cw__stats">
                    <Stat label="Clients" value={d.assignedClients} to="/clients" />
                    <Stat label="Today’s sessions" value={d.todaysSessions} />
                    <Stat label="Upcoming (7 days)" value={d.upcomingAppointments} />
                    <Stat label="Drafts to finish" value={d.draftSessions} tone={d.draftSessions ? 'attention' : undefined} />
                    <Stat label="Submitted" value={d.submittedSessions} />
                  </dl>
                  {d.sessionCompletion && (
                    <div className="rx-cw__completion">
                      <div className="rx-cw__completion-row">
                        <span>Documentation complete</span>
                        <strong>{d.sessionCompletion.completed ?? 0} of {d.sessionCompletion.total ?? 0}</strong>
                      </div>
                      <div className="rx-progressbar" role="progressbar" aria-label="Documentation complete"
                        aria-valuenow={d.sessionCompletion.completionPercent ?? 0} aria-valuemin={0} aria-valuemax={100}>
                        <div className="rx-progressbar__fill" style={{ width: `${Math.max(0, Math.min(100, d.sessionCompletion.completionPercent ?? 0))}%` }} />
                      </div>
                    </div>
                  )}
                </>
              )}
            </QueryBoundary>
          </Card>
        </aside>
      </div>

      {completing && (
        <SessionCompletionModal
          payload={completing}
          childName={completingCard ? childNameFor(completingCard) : null}
          complete={completeRbtSession}
          onClose={() => setCompleting(null)}
          onCompleted={() => { setCompleting(null); refresh(); }}
        />
      )}
    </div>
  );
}

export default RbtDashboardPage;
