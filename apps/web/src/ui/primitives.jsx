import { motion } from 'framer-motion';
import { Icon } from './icons.jsx';
import { CountUp } from './CountUp.jsx';
import { itemVariants } from './motion.js';

/* Button ---------------------------------------------------------------- */
export function Button({ variant = 'primary', size, block, loading, icon: IconCmp, children, className = '', ...rest }) {
  const cls = ['rx-btn', `rx-btn--${variant}`, size === 'lg' && 'rx-btn--lg', size === 'sm' && 'rx-btn--sm', block && 'rx-btn--block', className]
    .filter(Boolean).join(' ');
  return (
    <button className={cls} disabled={rest.disabled || loading} {...rest}>
      {loading ? <span className="rx-spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> : IconCmp ? <IconCmp size={16} /> : null}
      {children}
    </button>
  );
}

/* Card ------------------------------------------------------------------ */
export function Card({ title, hint, action, children, pad = true, className = '', as = 'section', style }) {
  const Cmp = motion[as] || motion.section;
  return (
    <Cmp variants={itemVariants} className={['rx-card', pad && 'rx-card--pad', className].filter(Boolean).join(' ')} style={style}>
      {(title || action) && (
        <header className="rx-card__head">
          <div>
            <div className="rx-card__title">{title}</div>
            {hint && <div className="rx-card__hint">{hint}</div>}
          </div>
          {action}
        </header>
      )}
      {children}
    </Cmp>
  );
}

/* Badge ----------------------------------------------------------------- */
const STATUS_TONE = {
  APPROVED: 'approved', FROZEN: 'approved', ACTIVE: 'approved', VERIFIED: 'approved', COMPLETED: 'approved',
  SUBMITTED: 'pending', PENDING: 'pending', INTAKE: 'pending', SCHEDULED: 'info', IN_PROGRESS: 'info',
  DRAFT: 'draft', ARCHIVED: 'draft', DISCHARGED: 'draft', INACTIVE: 'draft',
  RETURNED: 'denied', DENIED: 'denied', CANCELLED: 'denied', EXPIRED: 'denied', ON_HOLD: 'pending',
  // Medical entry statuses (Module 3): ACTIVE reuses 'approved' above.
  RESOLVED: 'draft', CHRONIC: 'info', MONITORING: 'pending',
};
export function Badge({ tone, status, children, dot = true }) {
  const t = tone || STATUS_TONE[status] || 'accent';
  return (
    <span className={`rx-badge rx-badge--${t}`}>
      {dot && <span className="rx-badge__dot" />}
      {children || (status ? status.replace(/_/g, ' ').toLowerCase() : null)}
    </span>
  );
}

/* KPI ------------------------------------------------------------------- */
export function KpiCard({ icon: IconCmp = Icon.Chart, label, value = 0, hint, format }) {
  return (
    <motion.div variants={itemVariants} className="rx-kpi">
      <div className="rx-kpi__chip"><IconCmp size={20} /></div>
      <div className="rx-kpi__value"><CountUp value={Number(value) || 0} format={format} /></div>
      <div className="rx-kpi__label">{label}</div>
      {hint && <div className="rx-kpi__hint">{hint}</div>}
    </motion.div>
  );
}

/* Page header ----------------------------------------------------------- */
export function PageHeader({ title, subtitle, actions, eyebrow }) {
  return (
    <div className="rx-pagehead">
      <div className="rx-pagehead__row">
        <div>
          {eyebrow && <div className="rx-pagehead__eyebrow">{eyebrow}</div>}
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {actions && <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{actions}</div>}
      </div>
    </div>
  );
}

/* States ---------------------------------------------------------------- */
export function Spinner() { return <div className="rx-state"><div className="rx-spinner" /></div>; }

export function EmptyState({ icon: IconCmp = Icon.Inbox, title, body, action }) {
  return (
    <div className="rx-state">
      <div className="rx-state__icon"><IconCmp size={24} /></div>
      <div className="rx-state__title">{title}</div>
      {body && <div className="rx-state__body">{body}</div>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}

export function ErrorState({ title = "We couldn’t load this", body = 'Please try again in a moment.', onRetry }) {
  return (
    <div className="rx-state">
      <div className="rx-state__icon" style={{ color: 'var(--color-state-denied)', background: 'var(--color-state-denied-surface)' }}>
        <Icon.Bell size={24} />
      </div>
      <div className="rx-state__title">{title}</div>
      <div className="rx-state__body">{body}</div>
      {onRetry && <div style={{ marginTop: 14 }}><Button variant="ghost" onClick={onRetry}>Retry</Button></div>}
    </div>
  );
}

/**
 * Query gate — the single place loading/error/empty are decided for a
 * react-query result, so every redesigned page renders the same three states.
 */
export function QueryBoundary({ query, empty, children }) {
  if (query.isLoading) return <Spinner />;
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} />;
  if (empty && empty(query.data)) return empty(query.data);
  return children;
}
