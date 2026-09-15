import { useHealth } from '@/api/queries';
import {
  PageHeader, Card, StatCard, Badge, Icon, LoadingState, ErrorState, EmptyState,
} from '@/components';
import { formatDateTime } from '@/lib/format';
import { healthStatus, formatDuration, humanizeCode } from '@/lib/labels';
import { PLATFORM_BRAND } from '@aba1on1/schemas';

/** Platform status — overall readiness, service version/uptime and each dependency check. */
export function HealthRx() {
  const { data, isLoading, isError, refetch, isFetching, dataUpdatedAt } = useHealth();

  const header = (
    <PageHeader
      eyebrow="System"
      title="Platform status"
      description={`Live health of the ${PLATFORM_BRAND.productName} API and the services it depends on.`}
      actions={(
        <button type="button" className="rxc-btn rxc-btn--secondary" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? <span className="rxc-spinner rxc-spinner--inline" aria-hidden="true" /> : <Icon name="refresh" size={16} />}
          <span>{isFetching ? 'Checking…' : 'Check again'}</span>
        </button>
      )}
    />
  );

  if (isLoading) return <section>{header}<Card><LoadingState label="Checking platform status…" /></Card></section>;
  if (isError || data === undefined) {
    return (
      <section>
        {header}
        <Card><ErrorState title="Status unavailable" message="The platform status check didn’t respond. The API may be unreachable." onRetry={() => refetch()} /></Card>
      </section>
    );
  }

  const overall = healthStatus(data.status);
  const ok = overall.tone === 'ok';
  const checks = Array.isArray(data.checks) ? data.checks : [];

  return (
    <section>
      {header}

      <Card as="div">
        <div className="rxc-health-hero" role="status">
          <span className={`rxc-health-hero__icon rxc-tone--${ok ? 'green' : 'amber'}`}>
            <Icon name={ok ? 'checkCircle' : 'alert'} size={24} />
          </span>
          <div className="rxc-health-hero__text">
            <div className="rxc-health-hero__title">{ok ? 'All systems operational' : 'Some services need attention'}</div>
            <div className="rxc-muted" style={{ fontSize: '.84rem' }}>
              Last checked {formatDateTime(dataUpdatedAt ? new Date(dataUpdatedAt) : new Date())}
            </div>
          </div>
          <Badge tone={overall.tone}>{overall.label}</Badge>
        </div>
      </Card>

      <div className="rxc-grid rxc-grid--3 rxc-section">
        <StatCard icon="server" tone="blue" label="API version" value={data.version ?? '—'} />
        <StatCard icon="clock" tone="violet" label="Uptime" value={formatDuration(data.uptimeSeconds)} hint={data.startedAt ? `Since ${formatDateTime(data.startedAt)}` : null} />
        <StatCard icon="activity" tone={ok ? 'green' : 'amber'} label="Service checks" value={`${checks.filter((c) => healthStatus(c.status).tone === 'ok').length} / ${checks.length}`} hint="Operational" />
      </div>

      <Card flush title="Service checks" className="rxc-section">
        {checks.length === 0 ? <EmptyState icon="server" title="No service checks registered" /> : (
          <div className="rxc-table-wrap">
            <table className="rxc-table rxc-table--stack">
              <caption className="sr-only">Service checks</caption>
              <thead><tr><th scope="col">Service</th><th scope="col">Details</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {checks.map((check) => {
                  const st = healthStatus(check.status);
                  return (
                    <tr key={check.name}>
                      <td data-primary>
                        <div className="rxc-entity">
                          <span className="rxc-stat__icon rxc-tone--slate"><Icon name="server" size={16} /></span>
                          <span className="rxc-entity__name">{humanizeCode(check.name)}</span>
                        </div>
                      </td>
                      <td data-label="Details" className="is-muted">{check.detail ? humanizeCode(check.detail) : '—'}</td>
                      <td data-label="Status"><Badge tone={st.tone}>{st.label}</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </section>
  );
}

export default HealthRx;
