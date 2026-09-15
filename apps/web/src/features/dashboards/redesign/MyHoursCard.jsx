import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getBcbaMyHours } from '@/api/client';
import { Card, Icon, Spinner, ErrorState } from '@/ui';
import { windowDateStrings } from '@/lib/businessDate';
import { formatDate } from '@/lib/format';

/**
 * "My Hours" (spec Change 4) — ONE card for both clinician dashboards.
 *
 * Shows the authenticated clinician's OWN (BCBA by default; the RBT dashboard
 * passes getRbtMyHours)
 * exact worked time as hours / minutes / SECONDS, aggregated server-side from
 * the authoritative SessionTimeRecord data for the selected period. It is
 * strictly a worked-time display: it shows no payroll amount, earnings, rate or
 * any dollar value. The number is server-authoritative (never a browser timer);
 * changing the filter refetches real persisted time for that period.
 */
const PERIODS = [
  { value: 'week', label: 'This Week' },
  { value: 'biweek', label: 'This Bi-Week' },
  { value: 'month', label: 'This Month' },
  { value: '3months', label: '3 Months' },
  { value: '6months', label: '6 Months' },
  { value: 'year', label: '1 Year' },
];

function pad(n) { return String(n ?? 0).padStart(2, '0'); }

export function MyHoursCard({ fetchHours, role = 'bcba' }) {
  const [period, setPeriod] = useState('week'); // default: This Week
  const query = useQuery({
    queryKey: [role, 'my-hours', period],
    queryFn: () => (fetchHours ?? getBcbaMyHours)(period),
  });
  const d = query.data;
  // The exact window the server summed, in the org timezone (MM/DD/YYYY). For
  // "This Week" that is Monday → Sunday.
  const win = d ? windowDateStrings(d.from, d.to, d.timeZone) : null;

  return (
    <Card title="My Hours" hint="Your worked time from completed sessions">
      <div className="rx-segmented rx-myhours__filters" role="tablist" aria-label="My Hours period">
        {PERIODS.map((p) => (
          <button
            key={p.value}
            type="button"
            role="tab"
            aria-selected={period === p.value}
            className={`rx-segmented__item${period === p.value ? ' is-active' : ''}`}
            onClick={() => setPeriod(p.value)}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="rx-myhours__body">
        {query.isLoading && <Spinner />}
        {query.isError && <ErrorState onRetry={() => query.refetch()} />}
        {query.isSuccess && d && (
          <>
            <div className="rx-myhours__clock" aria-label={`${d.hours} hours ${d.minutes} minutes ${d.seconds} seconds worked`}>
              <span className="rx-myhours__num">{d.hours}</span><span className="rx-myhours__unit">h</span>{' '}
              <span className="rx-myhours__num">{pad(d.minutes)}</span><span className="rx-myhours__unit">m</span>{' '}
              <span className="rx-myhours__num">{pad(d.seconds)}</span><span className="rx-myhours__unit">s</span>
            </div>
            <div className="rx-myhours__meta">
              <span><Icon.Clipboard size={14} /> {d.sessionCount ?? 0} session{(d.sessionCount ?? 0) === 1 ? '' : 's'}</span>
              {win && <span data-testid="my-hours-range"><Icon.Calendar size={14} /> {formatDate(win.first)} – {formatDate(win.last)}</span>}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

export default MyHoursCard;
