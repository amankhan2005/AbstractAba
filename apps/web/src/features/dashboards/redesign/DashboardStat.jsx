import { Link } from 'react-router-dom';

/**
 * One figure in a clinician dashboard's compact stats list (label → value),
 * optionally linking to the page it summarises. Values are real API counts;
 * a missing value renders as 0, never an invented figure.
 */
export function DashboardStat({ label, value, to, tone, hint }) {
  const content = (
    <>
      <dt>{label}{hint && <span className="rx-cw__stat-hint">{hint}</span>}</dt>
      <dd>{value ?? 0}</dd>
    </>
  );
  const cls = `rx-cw__stat${tone ? ` is-${tone}` : ''}`;
  return to ? <Link className={cls} to={to}>{content}</Link> : <div className={cls}>{content}</div>;
}

export default DashboardStat;
