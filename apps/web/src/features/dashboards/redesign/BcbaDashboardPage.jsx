import { useQuery } from '@tanstack/react-query';
import { StartSessionPanel } from '@/features/sessions/StartSessionPanel.jsx';
import { Link } from 'react-router-dom';
import { getBcbaDashboard, getBcbaWeeklyHours } from '@/api/client';
import { PageHeader, Card, QueryBoundary, Icon, EmptyState } from '@/ui';
import { statusLabel } from '@/lib/format';
import { useBcbaNames, useBcbaActiveSession } from '@/features/sessions/useBcbaSession.js';
import {
  ActiveSessionHero, WeeklyProgress, AppointmentSection, BcbaCompletionModal,
  useBcbaSessionActions,
} from '@/features/sessions/bcbaSessionUi.jsx';
import { MyHoursCard } from './MyHoursCard.jsx';
import { DashboardStat as Stat } from './DashboardStat.jsx';
import { useOrgTimezone } from '@/auth/store';
import { groupSessionCards } from '@/lib/appointment';
import { useStartWindowClock } from '@/features/sessions/useStartWindowClock.js';

/**
 * Aggregate the raw {STATUS: count} map into the canonical, always-shown
 * business buckets (real counts, zeros filled) plus a total — for a scannable
 * "today by state" breakdown.
 */
const BY_STATE_ORDER = ['Approved', 'In progress', 'Scheduled', 'Submitted', 'Cancelled', 'No show'];

function byStateBreakdown(byStatus = {}) {
  const buckets = Object.fromEntries(BY_STATE_ORDER.map((l) => [l, 0]));
  let total = 0;

  for (const [raw, count] of Object.entries(byStatus)) {
    const n = Number(count) || 0;
    total += n;

    const label = statusLabel(raw);

    if (label in buckets) {
      buckets[label] += n;
    } else {
      buckets[label] = (buckets[label] || 0) + n;
    }
  }

  const order = [
    ...BY_STATE_ORDER,
    ...Object.keys(buckets).filter((k) => !BY_STATE_ORDER.includes(k)),
  ];

  return {
    total,
    rows: order.map((label) => ({
      label,
      count: buckets[label],
    })),
  };
}

/** Scannable "today by state" breakdown: a total line + one row per state. */
function StateBreakdown({ byStatus }) {
  const { total, rows } = byStateBreakdown(byStatus);

  return (
    <div>
      <div
        className="rx-row__meta"
        style={{ marginBottom: 12, fontWeight: 600 }}
      >
        Total: {total} session{total === 1 ? '' : 's'} today
      </div>

      <div className="rx-list">
        {rows.map(({ label, count }) => (
          <div key={label} className="rx-row">
            <div className="rx-row__main">
              <div className="rx-row__title">{label}</div>
            </div>

            <span
              style={{
                fontWeight: 700,
                fontVariantNumeric: 'tabular-nums',
                opacity: count ? 1 : 0.4,
              }}
            >
              {count}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * BCBA DASHBOARD — the clinical supervision workspace, top to bottom:
 *
 *   1. NOW        the running session (timer, documentation, memo, Stop) — or
 *                 the appointments that can be started right now.
 *   2. TODAY      the BCBA's own current and upcoming appointments as one
 *                 compact queue with the canonical Start / Stop / Finish.
 *   3. ATTENTION  what needs a decision (review queue, drafts, credentials).
 *   4. CASELOAD   caseload, active treatment plans and upcoming work.
 *   5. HOURS      My Hours (worked time only) and the weekly goal when set.
 *
 * Only the BCBA's own scope — no organization-wide figures. The session queue,
 * hero and completion modal are the shared bcbaSessionUi components the Session
 * Panel also uses, so there is exactly one BCBA session flow.
 */
export function BcbaDashboardPage() {
  const { running, cards } = useBcbaActiveSession({ refetchInterval: 20_000 });
  const names = useBcbaNames();
  const actions = useBcbaSessionActions();
  const orgTimeZone = useOrgTimezone();
  const now = useStartWindowClock(cards, orgTimeZone);
  const { current: todaysCards, upcoming } = groupSessionCards(cards, orgTimeZone, now);

  const weekly = useQuery({ queryKey: ['bcba', 'weekly-hours'], queryFn: () => getBcbaWeeklyHours() });
  const query = useQuery({ queryKey: ['dashboard', 'bcba'], queryFn: () => getBcbaDashboard() });
  const d = query.data;

  return (
    <div className="rx-cw rx-cw--bcba">
      <PageHeader
        eyebrow="Clinical supervision"
        title="Dashboard"
        subtitle="Today’s sessions, your review queue and your caseload."
        actions={(
          <>
            <Link className="rx-btn rx-btn--ghost" to="/sessions"><Icon.Inbox size={16} />Review Queue</Link>
            <Link className="rx-btn rx-btn--ghost" to="/sessions/panel"><Icon.Clock size={16} />Session Panel</Link>
          </>
        )}
      />

      {/* 1. NOW — the hero while a session runs; otherwise what can start. */}
      {running ? (
        <ActiveSessionHero
          card={running}
          childName={running.childName || names.clientName(running.clientId)}
          onStop={() => actions.stopM.mutate(running.appointmentId)}
          stopping={actions.stopM.isPending}
        />
      ) : (
        <StartSessionPanel
          cards={cards}
          onStart={(appointmentId) => actions.startM.mutate(appointmentId)}
          starting={actions.startM.isPending}
          startingId={actions.startM.variables ?? null}
          childNameFor={(c) => c.childName || names.clientName(c.clientId)}
          hasRunning={false}
        />
      )}

      <div className="rx-cw__grid">
        <div className="rx-cw__main">
          {/* 2. TODAY */}
          <AppointmentSection id="bcba-current" title="Current sessions" cards={todaysCards} names={names} actions={actions}
            emptyHint="No session is open to start right now." />
          <AppointmentSection id="bcba-upcoming" title="Up next" cards={upcoming} names={names} actions={actions} limit={5} />

          <QueryBoundary query={query}>
            {d && (
              <Card title="Today’s sessions by state">
                {d.todaysSessions > 0 ? (
                  <StateBreakdown byStatus={d.todaysSessionsByStatus || {}} />
                ) : (
                  <EmptyState icon={Icon.CheckCircle} title="No sessions scheduled today" body="You’re all caught up for today." />
                )}
              </Card>
            )}
          </QueryBoundary>
        </div>

        <aside className="rx-cw__side" aria-label="Attention, caseload and hours">
          <QueryBoundary query={query}>
            {d && (
              <>
                {/* 3. ATTENTION */}
                <Card title="Attention" hint="Items that need a decision from you">
                  <dl className="rx-cw__stats">
                    <Stat label="Pending approvals" hint="Submitted sessions and draft documents" value={d.pendingApprovals} to="/sessions" tone={d.pendingApprovals ? 'attention' : undefined} />
                    <Stat label="Draft sessions" hint="Not yet submitted by technicians" value={d.draftSessions} />
                    <Stat label="Credential expirations" hint="Next 30 days" value={d.credentialExpirations} tone={d.credentialExpirations ? 'attention' : undefined} />
                  </dl>
                </Card>

                {/* 4. CASELOAD */}
                <Card title="Caseload" hint="Your assigned clients and plans">
                  <dl className="rx-cw__stats">
                    <Stat label="My Caseload" value={d.caseloadClients} to="/clients" />
                    <Stat label="Active treatment plans" value={d.activeTreatmentPlans} to="/plans" />
                    <Stat label="Today’s sessions" value={d.todaysSessions} />
                    <Stat label="Upcoming (7 days)" value={d.upcomingAppointments} to="/scheduling" />
                    <Stat label="Approved sessions" value={d.frozenSessions} />
                  </dl>
                </Card>
              </>
            )}
          </QueryBoundary>

          {/* 5. HOURS */}
          {weekly.data?.configured && <WeeklyProgress data={weekly.data} />}
          <MyHoursCard />
        </aside>
      </div>

      <BcbaCompletionModal actions={actions} cards={cards} names={names} />
    </div>
  );
}

export default BcbaDashboardPage;
