import { useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';

/**
 * Console UI primitives — the single component vocabulary every Super Admin
 * page is built from (page header, cards, stat tiles, badges, toolbar search,
 * filter tabs, tabs, tables, pagination, description lists, form fields).
 * Pure presentation: no data fetching, no business rules.
 */

export function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ Page header */
export function PageHeader({ eyebrow, title, description, actions, back, meta }) {
  return (
    <header className="rxc-page-head">
      {back ? (
        <Link to={back.to} className="rxc-back">
          <Icon name="arrowLeft" size={16} />
          <span>{back.label}</span>
        </Link>
      ) : null}
      <div className="rxc-page-head__row">
        <div className="rxc-page-head__text">
          {eyebrow ? <p className="rxc-eyebrow">{eyebrow}</p> : null}
          <h1 className="rxc-page-title">{title}</h1>
          {description ? <p className="rxc-page-desc">{description}</p> : null}
          {meta ? <div className="rxc-page-meta">{meta}</div> : null}
        </div>
        {actions ? <div className="rxc-page-actions">{actions}</div> : null}
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------------ Card */
export function Card({ title, description, actions, children, className, flush, as: Tag = 'section', id }) {
  const headingId = useId();
  return (
    <Tag className={cx('rxc-card', flush && 'rxc-card--flush', className)} aria-labelledby={title ? headingId : undefined} id={id}>
      {title || actions ? (
        <div className="rxc-card__head">
          <div className="rxc-card__titles">
            {title ? <h2 className="rxc-card__title" id={headingId}>{title}</h2> : null}
            {description ? <p className="rxc-card__desc">{description}</p> : null}
          </div>
          {actions ? <div className="rxc-card__actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </Tag>
  );
}

/* ------------------------------------------------------------------ Stat card */
export function StatCard({ icon, label, value, hint, to, tone = 'blue', loading }) {
  const body = (
    <>
      <div className="rxc-stat__top">
        <span className="rxc-stat__label">{label}</span>
        {icon ? <span className={`rxc-stat__icon rxc-tone--${tone}`}><Icon name={icon} size={17} /></span> : null}
      </div>
      <div className="rxc-stat__value">{loading ? <span className="rxc-skel rxc-skel--value" aria-hidden="true" /> : value}</div>
      {hint ? <div className="rxc-stat__hint">{hint}</div> : null}
    </>
  );
  if (to) return <Link className="rxc-stat rxc-stat--link" to={to}>{body}</Link>;
  return <div className="rxc-stat">{body}</div>;
}

/* ----------------------------------------------------------------------- Badge */
export function Badge({ tone = 'neutral', children, dot = true, className }) {
  return <span className={cx('rxc-badge', `rxc-badge--${tone}`, !dot && 'rxc-badge--nodot', className)}>{children}</span>;
}

/* ---------------------------------------------------------------------- Avatar */
export function initialsOf(name, fallback = '?') {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  return parts.slice(0, 2).map((p) => p[0]?.toUpperCase()).join('');
}

export function Avatar({ name, src, size = 'md', square }) {
  const [broken, setBroken] = useState(false);
  const cls = cx('rxc-avatar', `rxc-avatar--${size}`, square && 'rxc-avatar--square');
  if (src && !broken) return <img className={cls} src={src} alt="" onError={() => setBroken(true)} />;
  return <span className={cls} aria-hidden="true">{initialsOf(name)}</span>;
}

/* ---------------------------------------------------------------- Search input */
export function SearchInput({ value, onChange, placeholder = 'Search', label = 'Search', className }) {
  return (
    <div className={cx('rxc-search', className)}>
      <Icon name="search" size={16} />
      <input
        type="search"
        className="rxc-search__input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
      />
      {value ? (
        <button type="button" className="rxc-search__clear" onClick={() => onChange('')} aria-label="Clear search">
          <Icon name="x" size={14} />
        </button>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------- Filter tabs */
export function FilterTabs({ options, value, onChange, label = 'Filter' }) {
  return (
    <div className="rxc-filters" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          className={cx('rxc-filter', value === o.key && 'is-active')}
          aria-pressed={value === o.key}
          onClick={() => onChange(o.key)}
        >
          <span>{o.label}</span>
          {o.count != null ? <span className="rxc-filter__count">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------ Tabs */
export function Tabs({ tabs, value, onChange, label = 'Sections', idBase }) {
  const listRef = useRef(null);
  const base = idBase ?? 'rxc-tab';
  const onKey = (e) => {
    const idx = tabs.findIndex((t) => t.key === value);
    let next = null;
    if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
    if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = tabs.length - 1;
    if (next == null) return;
    e.preventDefault();
    onChange(tabs[next].key);
    listRef.current?.querySelectorAll('[role="tab"]')[next]?.focus();
  };
  return (
    <div className="rxc-tabs" role="tablist" aria-label={label} ref={listRef} onKeyDown={onKey}>
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          id={`${base}-${t.key}`}
          aria-selected={value === t.key}
          aria-controls={`${base}-panel-${t.key}`}
          tabIndex={value === t.key ? 0 : -1}
          className={cx('rxc-tab', value === t.key && 'is-active')}
          onClick={() => onChange(t.key)}
        >
          {t.icon ? <Icon name={t.icon} size={16} /> : null}
          <span>{t.label}</span>
          {t.count != null ? <span className="rxc-tab__count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ tabKey, idBase, children }) {
  const base = idBase ?? 'rxc-tab';
  return (
    <div role="tabpanel" id={`${base}-panel-${tabKey}`} aria-labelledby={`${base}-${tabKey}`} className="rxc-tabpanel">
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ Pagination */
export function Pagination({ page, pageSize, total, onPage, noun = 'results' }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  const from = page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <nav className="rxc-pager" aria-label="Pagination">
      <span className="rxc-pager__info">
        Showing <strong>{from}–{to}</strong> of <strong>{total}</strong> {noun}
      </span>
      {pages > 1 ? (
        <div className="rxc-pager__controls">
          <button type="button" className="rxc-btn rxc-btn--secondary rxc-btn--sm" disabled={page === 0} onClick={() => onPage(page - 1)}>
            <Icon name="chevronLeft" size={15} /><span>Previous</span>
          </button>
          <span className="rxc-pager__page" aria-live="polite">Page {page + 1} of {pages}</span>
          <button type="button" className="rxc-btn rxc-btn--secondary rxc-btn--sm" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
            <span>Next</span><Icon name="chevronRight" size={15} />
          </button>
        </div>
      ) : null}
    </nav>
  );
}

/* ----------------------------------------------------------- Description list */
export function DescriptionList({ items, columns = 1 }) {
  return (
    <dl className={cx('rxc-dl', columns === 2 && 'rxc-dl--2')}>
      {items.filter(Boolean).map(([label, value]) => (
        <div className="rxc-dl__row" key={label}>
          <dt>{label}</dt>
          <dd>{value === '' || value == null ? <span className="rxc-muted">—</span> : value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------------ Form field */
/**
 * A labelled control. Renders <label><span>Label</span>{control}</label> so the
 * label text is programmatically tied to the control it wraps; hint and error
 * lines sit below. `required` adds a visual marker only (validation is the
 * caller's responsibility).
 */
export function Field({ label, hint, error, children, className, required, full }) {
  return (
    <label className={cx('rxc-field', full && 'rxc-field--full', error && 'has-error', className)}>
      <span className="rxc-field__label">{label}</span>
      {required ? <em className="rxc-field__req" aria-hidden="true">Required</em> : null}
      {children}
      {hint && !error ? <small className="rxc-field__hint">{hint}</small> : null}
      {error ? <small className="rxc-field__error" role="alert">{error}</small> : null}
    </label>
  );
}

/** Password input with an accessible show/hide toggle. */
export function PasswordInput({ value, onChange, autoComplete, placeholder, id, invalid, autoFocus, name }) {
  const [shown, setShown] = useState(false);
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  return (
    <span className="rxc-password">
      <input
        id={inputId}
        name={name}
        className="rxc-input"
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        placeholder={placeholder}
        aria-invalid={invalid ? 'true' : undefined}
        autoFocus={autoFocus}
      />
      <button
        type="button"
        className="rxc-password__toggle"
        onClick={(e) => { e.preventDefault(); setShown((v) => !v); }}
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        aria-controls={inputId}
      >
        <Icon name={shown ? 'eyeOff' : 'eye'} size={17} />
      </button>
    </span>
  );
}

/* --------------------------------------------------------------------- Spinner */
export function Spinner({ size = 16, label }) {
  return <span className="rxc-spinner" style={{ width: size, height: size }} role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : 'true'} />;
}

/* ----------------------------------------------------------------- Skeleton rows */
export function SkeletonRows({ rows = 5, label = 'Loading' }) {
  return (
    <div className="rxc-skel-rows" role="status" aria-live="polite" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div className="rxc-skel-row" key={i}>
          <span className="rxc-skel rxc-skel--circle" />
          <span className="rxc-skel rxc-skel--line" style={{ width: `${38 + ((i * 17) % 30)}%` }} />
          <span className="rxc-skel rxc-skel--line rxc-skel--short" />
        </div>
      ))}
    </div>
  );
}
