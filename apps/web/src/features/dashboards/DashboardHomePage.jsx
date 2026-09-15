import { Link } from 'react-router-dom';
import { useAuthStore } from '@/auth/store';
import { Card } from '@/components';

/**
 * Dashboard landing. Lists the role dashboards the signed-in user can open — all
 * are gated by dashboards.read (enforced server-side); the user's own roles are
 * used only to highlight the most relevant board first. No redesign: plain Cards
 * and links reusing the existing shell styles.
 */
const BOARDS = [
  { to: '/dashboards/organization', label: 'Organization', roles: ['owner', 'org_admin'], blurb: 'Org-wide clinical posture: clients, staff, plans, documents.' },
  { to: '/dashboards/admin', label: 'Admin', roles: ['owner', 'org_admin'], blurb: 'Operational queue: approvals, credential expirations, utilization.' },
  { to: '/dashboards/bcba', label: 'BCBA', roles: ['bcba'], blurb: 'Supervisor board: sign-off queue, caseload, today’s sessions.' },
  { to: '/dashboards/rbt', label: 'RBT', roles: ['rbt'], blurb: 'Technician day: today’s sessions, upcoming visits, completion.' },
];

export function DashboardHomePage() {
  const roles = useAuthStore((state) => state.principal?.roles ?? []);
  const relevant = (board) => board.roles.some((r) => roles.includes(r));
  const ordered = [...BOARDS].sort((a, b) => Number(relevant(b)) - Number(relevant(a)));

  return (
    <div className="ui-stack">
      <h1>Dashboards</h1>
      {ordered.map((board) => (
        <Card key={board.to}>
          <div className="ui-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="ui-stack" style={{ gap: '0.25rem' }}>
              <strong>{board.label}{relevant(board) ? ' · for you' : ''}</strong>
              <span className="muted">{board.blurb}</span>
            </div>
            <Link className="ui-button" to={board.to}>Open</Link>
          </div>
        </Card>
      ))}
    </div>
  );
}
