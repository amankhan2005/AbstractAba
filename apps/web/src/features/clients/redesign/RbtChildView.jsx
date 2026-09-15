import { useQuery } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { getClient, listPlans, getPlan, listSessions } from '@/api/client';
import { PageHeader, Card, Badge, Button, Icon, Spinner, ErrorState, EmptyState, DataTable } from '@/ui';
import { formatFullName, formatDate, sessionStatusText } from '@/lib/format';

/**
 * RBT EXECUTION child view — intentionally MINIMAL (blueprint Part 6). The RBT
 * executes the BCBA's plan and records sessions; they are neither a planner nor
 * a Company admin. This page shows only what execution needs — child name,
 * assigned BCBA, current plan, this week's goals, and a prominent Start Session
 * — and NOTHING else (no guardian data, no payroll, no care-team controls, no
 * child editor). The backend returns the minimal payload for this role, so the
 * sensitive fields are never even sent here.
 */
export function weeklyItemsFrom(plan) {
  // Reuse the existing plan/goal/program/target model. "This week" = targets the
  // BCBA flagged weeklyFocus; fall back to goal descriptions so the list is never
  // empty when a plan exists. Uses the REAL model fields (spec Module 8.1): goals
  // carry `description`, programs `name`, targets `label`. Fully defensive.
  if (!plan) return [];
  const goals = plan.goals ?? [];
  const focus = [];
  for (const g of goals) {
    for (const p of g.programs ?? []) {
      for (const t of p.targets ?? []) {
        if (t.weeklyFocus) focus.push({ id: t.id, label: t.label || p.name || g.description || 'Target', note: t.weeklyInstructions || '' });
      }
    }
  }
  if (focus.length > 0) return focus;
  return goals.map((g) => ({ id: g.id, label: g.description || 'Goal', note: '' }));
}

export function RbtChildView() {
  const { clientId } = useParams();
  const navigate = useNavigate();
  const client = useQuery({ queryKey: ['client', clientId], queryFn: () => getClient(clientId) });
  const plans = useQuery({ queryKey: ['plans', 'client', clientId], queryFn: () => listPlans({ clientId }) });

  const planItems = plans.data?.items ?? [];
  const activePlan = planItems.find((p) => p.status === 'ACTIVE') ?? planItems[0];
  const planDetail = useQuery({
    queryKey: ['plan', activePlan?.id],
    queryFn: () => getPlan(activePlan.id),
    enabled: Boolean(activePlan?.id),
  });
  const sessions = useQuery({ queryKey: ['sessions', 'client', clientId], queryFn: () => listSessions({ clientId }) });

  if (client.isLoading) return <Spinner />;
  if (client.isError) return <ErrorState onRetry={() => client.refetch()} />;

  const detail = client.data ?? {};
  const c = detail.client ?? detail;
  const careTeam = detail.careTeam ?? [];
  const bcba = careTeam.find((m) => m.role === 'BCBA' && (m.status ?? 'ACTIVE') === 'ACTIVE');
  const medical = detail.medical ?? []; // already minimal (label + status) from the server for RBT
  const fullName = formatFullName({ firstName: c.firstName, lastName: c.lastName }) || 'Not provided';
  const weekly = weeklyItemsFrom(planDetail.data?.plan ? { ...planDetail.data.plan, goals: planDetail.data.goals } : null);

  return (
    <>
      <PageHeader
        eyebrow="Client"
        title={fullName}
        subtitle={bcba ? `Supervising BCBA: ${bcba.staffName || 'Assigned'}` : undefined}
        actions={<Button icon={Icon.Clock} onClick={() => navigate('/sessions/new')}>Start session</Button>}
      />

      <div className="rx-cols-2" style={{ marginTop: 8 }}>
        <Card title="Current plan" hint="Read-only · maintained by your BCBA">
          {activePlan ? (
            <div className="rx-list">
              <button type="button" className="rx-row is-click" onClick={() => navigate(`/plans/${activePlan.id}`)} style={{ width: '100%', textAlign: 'left', background: 'none', border: 0, cursor: 'pointer' }}>
                <div className="rx-row__main"><div className="rx-row__title">{activePlan.name || activePlan.title || 'Treatment plan'}</div><div className="rx-row__meta">View goals, programs and targets</div></div>
                <Badge status={activePlan.status} />
              </button>
            </div>
          ) : <EmptyState icon={Icon.Doc} title="No program yet" body="Your BCBA hasn’t published a treatment plan for this client yet." />}
        </Card>

        <Card title="This week">
          {planDetail.isLoading ? <Spinner /> : weekly.length > 0 ? (
            <div className="rx-list">
              {weekly.map((w) => (
                <div className="rx-row" key={w.id}><div className="rx-row__main"><div className="rx-row__title">{w.label}</div>{w.note ? <div className="rx-row__meta">{w.note}</div> : null}</div></div>
              ))}
            </div>
          ) : <EmptyState icon={Icon.Check} title="Nothing assigned this week" body="Weekly targets from your BCBA appear here." />}
        </Card>
      </div>

      <div style={{ marginTop: 14 }}>
        {medical.length > 0 && (
          <Card title="Medical summary" hint="Key information for safe care">
            <div className="rx-list">
              {medical.map((m) => (
                <div className="rx-row" key={m.id}><div className="rx-row__main"><div className="rx-row__title">{m.label}</div></div>{m.status ? <Badge status={m.status} /> : null}</div>
              ))}
            </div>
          </Card>
        )}
      </div>

      <div style={{ marginTop: 14 }}>
        <Card title="Your recent sessions" hint="Sessions you delivered for this client">
          <DataTable
            query={sessions}
            onRowClick={(r) => navigate(`/sessions/${r.id}`)}
            columns={[
              { key: 'date', header: 'Date', render: (r) => formatDate(r.actualStart || r.startedAt || r.scheduledStart) || '—' },
              { key: 'worked', header: 'Worked time', render: (r) => (r.workedMinutes != null ? `${Math.floor(r.workedMinutes / 60)}h ${String(r.workedMinutes % 60).padStart(2, '0')}m` : '—') },
              { key: 'status', header: 'Status', render: (r) => <Badge status={r.status}>{sessionStatusText(r)}</Badge> },
            ]}
            empty={<EmptyState icon={Icon.Clipboard} title="No sessions yet" body="Sessions you deliver for this client appear here." />}
          />
        </Card>
      </div>
    </>
  );
}

export default RbtChildView;
