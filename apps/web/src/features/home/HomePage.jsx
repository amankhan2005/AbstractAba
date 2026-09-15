import { useAuthStore } from '@/auth/store';
import { Card } from '@/components';

/**
 * The authenticated landing page. In Step 1 it confirms the signed-in session
 * and account context; the clinical sections (Clients, Scheduling, …) attach to
 * this shell as their modules land.
 */
export function HomePage() {
  const principal = useAuthStore((state) => state.principal);

  return (
    <div className="ui-stack">
      <h1>Home</h1>
      <Card>
        <h2>Welcome{principal?.fullName ? `, ${principal.fullName}` : ''}</h2>
        <p>You are signed in to your organization workspace.</p>
        <dl className="ui-fields">
          <div className="ui-field">
            <dt>Signed in as</dt>
            <dd>{principal?.email ?? '—'}</dd>
          </div>
          <div className="ui-field">
            <dt>Roles</dt>
            <dd>{principal?.roles?.length ? principal.roles.join(', ') : '—'}</dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}
