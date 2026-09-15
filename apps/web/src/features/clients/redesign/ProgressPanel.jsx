import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { fetchChildProgress, fetchChildAlerts } from '@/api/client';
import { Card, Badge, Icon, Spinner, ErrorState, EmptyState } from '@/ui';
import { formatDate } from '@/lib/format';

/**
 * Child progress (Phase 6). Read-only, derived from the canonical goal records
 * (0–100 progress + status) — no fabricated numbers. Empty, loading and error
 * states are distinct: a failed fetch never renders as "0% progress".
 */
const GOAL_STATUS_LABEL = { NOT_STARTED: 'Not started', IN_PROGRESS: 'In progress', MET: 'Met', DISCONTINUED: 'Discontinued', ARCHIVED: 'Archived' };

export function ProgressPanel({ clientId }) {
  const q = useQuery({ queryKey: ['child-progress', clientId], queryFn: () => fetchChildProgress(clientId) });

  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const d = q.data ?? {};
  const goals = d.goals ?? [];

  if (goals.length === 0) {
    return <EmptyState icon={Icon.Chart} title="No progress data yet" body="Goals and their progress appear here once a treatment plan is active for this child." />;
  }

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div className="rx-cols-3">
        <SummaryStat label="Goals" value={d.totalGoals ?? goals.length} />
        <SummaryStat label="Met" value={d.metGoals ?? 0} />
        <SummaryStat label="Average progress" value={d.averageProgress == null ? 'Not measured' : `${d.averageProgress}%`} />
      </div>

      <Card title="Goals">
        <div style={{ display: 'grid', gap: 12 }}>
          {goals.map((g, i) => (
            <motion.div key={g.id || i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}
              style={{ padding: 14, border: '1px solid var(--rx-line)', borderRadius: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <div style={{ flex: 1, fontWeight: 600 }}>{g.description || 'Goal'}</div>
                <Badge status={g.status === 'MET' ? 'APPROVED' : g.status === 'IN_PROGRESS' ? 'IN_PROGRESS' : g.status === 'DISCONTINUED' ? 'DENIED' : 'DRAFT'}>{GOAL_STATUS_LABEL[g.status] || g.status}</Badge>
                {g.term && <span className="rx-row__meta">{g.term === 'LONG_TERM' ? 'Long-term' : 'Short-term'}</span>}
              </div>
              {typeof g.progress === 'number' ? (
                <div>
                  <div style={{ height: 8, background: 'var(--rx-line)', borderRadius: 999, overflow: 'hidden' }}>
                    <motion.div initial={{ width: 0 }} animate={{ width: `${Math.max(0, Math.min(100, g.progress))}%` }} transition={{ duration: 0.6 }}
                      style={{ height: '100%', background: 'var(--rx-accent)' }} />
                  </div>
                  <div className="rx-row__meta" style={{ marginTop: 4 }}>{g.progress}%{g.updatedAt ? ` · updated ${formatDate(g.updatedAt)}` : ''}</div>
                </div>
              ) : <div className="rx-row__meta">No progress reading yet</div>}
            </motion.div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function SummaryStat({ label, value }) {
  return (
    <Card><div className="rx-row__meta">{label}</div><div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{value}</div></Card>
  );
}

/**
 * Child attention card — operational alerts derived server-side from the child's
 * real state. Each alert deep-links to the tab that resolves it. Hidden entirely
 * when there are no alerts (nothing to nag about).
 */
const SEVERITY_TONE = { CRITICAL: 'denied', WARNING: 'pending', INFO: 'info' };

export function ChildAlertsCard({ clientId, onNavigate }) {
  const q = useQuery({ queryKey: ['child-alerts', clientId], queryFn: () => fetchChildAlerts(clientId) });
  if (q.isLoading || q.isError) return null; // non-blocking; never render an error where an alert belongs
  const alerts = q.data?.alerts ?? [];
  if (alerts.length === 0) return null;

  return (
    <Card title="Needs attention" hint={`${alerts.length} item${alerts.length === 1 ? '' : 's'}`}>
      <div style={{ display: 'grid', gap: 8 }}>
        {alerts.map((a, i) => (
          <motion.button key={a.code || i} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.03 }}
            onClick={() => onNavigate?.(a.action)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: '1px solid var(--rx-line)', borderRadius: 10, background: 'var(--rx-surface)', cursor: onNavigate ? 'pointer' : 'default', textAlign: 'left', width: '100%' }}>
            <Badge tone={SEVERITY_TONE[a.severity] || 'info'}>{a.severity}</Badge>
            <span style={{ flex: 1 }}>{a.message}</span>
            {onNavigate && <Icon.Arrow size={16} />}
          </motion.button>
        ))}
      </div>
    </Card>
  );
}

export default ProgressPanel;
