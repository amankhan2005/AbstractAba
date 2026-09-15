import { motion, useReducedMotion } from 'framer-motion';

/**
 * Dependency-free SVG charts. No chart library is added — these read the same
 * real API payloads the dashboards fetch, and animate their geometry in with
 * Framer Motion (respecting reduced motion). Status colours come from the LOCKED
 * semantic palette so a "returned"/"denied" slice can never be re-themed green.
 */

const SEMANTIC = {
  approved: 'var(--color-state-approved)', pending: 'var(--color-state-pending)',
  denied: 'var(--color-state-denied)', info: 'var(--color-state-info)', draft: 'var(--color-state-draft)',
  accent: 'var(--rx-accent)',
};
const STATUS_COLOR = {
  ACTIVE: SEMANTIC.approved, FROZEN: SEMANTIC.approved, APPROVED: SEMANTIC.approved, VERIFIED: SEMANTIC.approved,
  SUBMITTED: SEMANTIC.pending, INTAKE: SEMANTIC.pending, PENDING: SEMANTIC.pending, ON_HOLD: SEMANTIC.pending,
  SCHEDULED: SEMANTIC.info, IN_PROGRESS: SEMANTIC.info, COMPLETED: SEMANTIC.info,
  DRAFT: SEMANTIC.draft, ARCHIVED: SEMANTIC.draft, DISCHARGED: SEMANTIC.draft, INACTIVE: SEMANTIC.draft,
  RETURNED: SEMANTIC.denied, DENIED: SEMANTIC.denied, CANCELLED: SEMANTIC.denied, EXPIRED: SEMANTIC.denied,
};
const colorFor = (k, i) => STATUS_COLOR[k] || [SEMANTIC.accent, SEMANTIC.info, SEMANTIC.pending, SEMANTIC.draft][i % 4];
const pretty = (k) => k.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/**
 * Donut — a breakdown of REAL counts ({ ACTIVE: 12, INACTIVE: 3 }).
 *
 * Optional presentation props (all backward compatible):
 *   labels     { key: 'Display label' } for the legend, tooltips and text alternative
 *   colors     { key: 'css colour' }    per-slice colour (default: semantic status palette)
 *   ariaLabel  chart name, announced with every slice's count and percentage
 *   showPercent  legend shows "count · pct%"
 *
 * Segments are drawn with flat ends so every arc is exactly its share of the
 * total (round caps visually overstate small slices). Each segment carries a
 * native tooltip, and the chart exposes a complete text equivalent.
 */
export function Donut({ data = {}, size = 168, thickness = 20, centerLabel, centerValue, labels = {}, colors = {}, ariaLabel, showPercent = false }) {
  const reduce = useReducedMotion();
  const entries = Object.entries(data).filter(([, v]) => Number(v) > 0);
  const total = entries.reduce((a, [, v]) => a + Number(v), 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const labelOf = (k) => labels[k] ?? pretty(k);
  const colourOf = (k, i) => colors[k] ?? colorFor(k, i);
  const pct = (v) => (total ? Math.round((Number(v) / total) * 100) : 0);
  let offset = 0;

  if (total === 0) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', gap: 8 }}>
        <svg width={size} height={size} aria-hidden="true"><circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--rx-line)" strokeWidth={thickness} /></svg>
        <span className="rx-card__hint">No data yet</span>
      </div>
    );
  }
  const summary = `${ariaLabel ? `${ariaLabel}: ` : ''}${entries.map(([k, v]) => `${labelOf(k)} ${v} of ${total} (${pct(v)}%)`).join(', ')}`;
  return (
    <div className="rx-donut" style={{ display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap' }}>
      <div role="img" aria-label={summary} style={{ position: 'relative', width: size, height: size, flex: 'none' }}>
        <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }} aria-hidden="true">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--rx-line)" strokeWidth={thickness} />
          {entries.map(([k, v], i) => {
            const frac = Number(v) / total;
            const seg = (
              <motion.circle
                key={k} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={colourOf(k, i)}
                strokeWidth={thickness} strokeLinecap={entries.length > 1 ? 'butt' : 'round'}
                strokeDasharray={`${frac * c} ${c}`} strokeDashoffset={-offset * c}
                initial={reduce ? false : { strokeDasharray: `0 ${c}` }}
                animate={{ strokeDasharray: `${frac * c} ${c}` }}
                transition={{ duration: 0.7, delay: 0.08 * i, ease: [0.22, 1, 0.36, 1] }}
                data-slice={k}
              >
                <title>{`${labelOf(k)}: ${v} (${pct(v)}%)`}</title>
              </motion.circle>
            );
            offset += frac;
            return seg;
          })}
        </svg>
        <div aria-hidden="true" style={{ position: 'absolute', inset: 0, display: 'grid', placeContent: 'center', textAlign: 'center' }}>
          <div style={{ fontSize: '1.7rem', fontWeight: 740, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}>{centerValue ?? total}</div>
          <div className="rx-card__hint">{centerLabel ?? 'total'}</div>
        </div>
      </div>
      <ul className="rx-legend" style={{ flexDirection: 'column', flex: 1, minWidth: 140 }}>
        {entries.map(([k, v], i) => (
          <li className="rx-legend__item" key={k} style={{ justifyContent: 'space-between', width: '100%' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span className="rx-legend__swatch" style={{ background: colourOf(k, i) }} />{labelOf(k)}
            </span>
            <span className="rx-legend__val">{v}{showPercent ? <span className="rx-legend__pct"> · {pct(v)}%</span> : null}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* Gauge — a single percentage (utilization, completion). */
export function Gauge({ percent = 0, label, tone = 'accent' }) {
  const reduce = useReducedMotion();
  const size = 150, thickness = 16, r = (size - thickness) / 2, c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const stroke = SEMANTIC[tone] || SEMANTIC.accent;
  return (
    <div style={{ display: 'grid', placeItems: 'center' }}>
      <div style={{ position: 'relative', width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--rx-line)" strokeWidth={thickness} />
          <motion.circle
            cx={size / 2} cy={size / 2} r={r} fill="none" stroke={stroke} strokeWidth={thickness} strokeLinecap="round"
            initial={reduce ? false : { strokeDasharray: `0 ${c}` }}
            animate={{ strokeDasharray: `${(p / 100) * c} ${c}` }}
            transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
          />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeContent: 'center', textAlign: 'center' }}>
          <div style={{ fontSize: '1.6rem', fontWeight: 740 }}>{p}%</div>
        </div>
      </div>
      {label && <div className="rx-card__hint" style={{ marginTop: 8 }}>{label}</div>}
    </div>
  );
}

/**
 * Labeled horizontal bars for real, pre-formatted metrics (e.g. payroll $ or
 * worked time per staff). Unlike `Bars`, labels and values are rendered EXACTLY
 * as given — no lowercasing, no re-derivation — so person names stay
 * First Middle Last and money/duration keep their currency/units. Each item:
 *   { key?, label, value (display string), weight (number for bar length), color? }
 * Animates width in with the shared easing and honours reduced motion.
 */
export function BarList({ items = [], emptyText = 'No data yet' }) {
  const reduce = useReducedMotion();
  const rows = items.filter((it) => it && it.label != null);
  if (rows.length === 0) return <div className="rx-card__hint">{emptyText}</div>;
  const max = Math.max(1, ...rows.map((it) => Number(it.weight) || 0));
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {rows.map((it, i) => (
        <div key={it.key ?? it.label ?? i} style={{ display: 'grid', gridTemplateColumns: 'minmax(84px, 160px) 1fr auto', alignItems: 'center', gap: 12 }}>
          <span title={it.label} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '.83rem', color: 'var(--rx-ink-soft)' }}>{it.label}</span>
          <div style={{ height: 12, borderRadius: 8, background: 'var(--rx-line-soft)', overflow: 'hidden' }}>
            <motion.div
              style={{ height: '100%', borderRadius: 8, background: it.color || SEMANTIC.accent }}
              initial={reduce ? false : { width: 0 }}
              animate={{ width: `${(Number(it.weight) / max) * 100}%` }}
              transition={{ duration: 0.6, delay: 0.05 * i, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
          <span style={{ textAlign: 'right', fontWeight: 650, fontVariantNumeric: 'tabular-nums', minWidth: 68 }}>{it.value}</span>
        </div>
      ))}
    </div>
  );
}

/* Horizontal bars — by-status counts. */
export function Bars({ data = {} }) {
  const reduce = useReducedMotion();
  const entries = Object.entries(data);
  const max = Math.max(1, ...entries.map(([, v]) => Number(v) || 0));
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {entries.map(([k, v], i) => (
        <div key={k} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 34px', alignItems: 'center', gap: 10 }}>
          <span className="rx-card__hint" style={{ color: 'var(--rx-ink-soft)' }}>{pretty(k)}</span>
          <div style={{ height: 10, borderRadius: 6, background: 'var(--rx-line-soft)', overflow: 'hidden' }}>
            <motion.div
              style={{ height: '100%', borderRadius: 6, background: colorFor(k, i) }}
              initial={reduce ? false : { width: 0 }}
              animate={{ width: `${(Number(v) / max) * 100}%` }}
              transition={{ duration: 0.6, delay: 0.05 * i, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
          <span style={{ textAlign: 'right', fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * ColumnChart — a calm time-series column chart for REAL buckets
 * ([{ key, label, value }]). No animation, no gradients: equal-width columns,
 * light gridlines, a readable value on hover (native tooltip) and a complete
 * text alternative for screen readers. Tick labels are thinned automatically so
 * dense series (e.g. 30 days) stay legible.
 */
export function ColumnChart({ points = [], height = 180, ariaLabel = 'Chart', formatValue = (v) => String(v), emptyText = 'No data for this period', color = 'var(--rx-accent)' }) {
  if (points.length === 0 || points.every((p) => !Number(p.value))) {
    return <div className="rx-colchart__empty" style={{ height, display: 'grid', placeItems: 'center', color: 'var(--rx-ink-faint)', fontSize: '.86rem' }}>{emptyText}</div>;
  }
  const max = Math.max(1, ...points.map((p) => Number(p.value) || 0));
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  const every = Math.max(1, Math.ceil(points.length / 8));
  const summary = points.map((p) => `${p.label}: ${formatValue(p.value)}`).join('; ');
  return (
    <figure className="rx-colchart" style={{ margin: 0 }} aria-label={ariaLabel}>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 8 }}>
        <div aria-hidden="true" style={{ height, display: 'flex', flexDirection: 'column-reverse', justifyContent: 'space-between', fontSize: '.7rem', color: 'var(--rx-ink-faint)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          {ticks.map((t) => <span key={t}>{t}</span>)}
        </div>
        <div>
          <div aria-hidden="true" style={{ position: 'relative', height, display: 'flex', alignItems: 'flex-end', gap: points.length > 40 ? 1 : 3,
            backgroundImage: 'linear-gradient(var(--rx-line-soft) 1px, transparent 1px)', backgroundSize: `100% ${height / 2}px`, borderBottom: '1px solid var(--rx-line)' }}>
            {points.map((p) => (
              <div key={p.key} title={`${p.label}: ${formatValue(p.value)}`}
                style={{ flex: 1, minWidth: 2, height: `${((Number(p.value) || 0) / max) * 100}%`, background: color, borderRadius: '3px 3px 0 0', opacity: Number(p.value) ? 0.9 : 0 }} />
            ))}
          </div>
          <div aria-hidden="true" style={{ display: 'flex', gap: points.length > 40 ? 1 : 3, marginTop: 6 }}>
            {points.map((p, i) => (
              <span key={p.key} style={{ flex: 1, minWidth: 2, fontSize: '.68rem', color: 'var(--rx-ink-faint)', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'visible' }}>
                {i % every === 0 ? p.shortLabel ?? p.label : ''}
              </span>
            ))}
          </div>
        </div>
      </div>
      <figcaption className="rx-st__sr">{summary}</figcaption>
    </figure>
  );
}
