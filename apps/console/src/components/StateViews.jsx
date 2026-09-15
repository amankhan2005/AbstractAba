import { Icon } from './Icon';

/**
 * Loading / error / empty states — one shared system for every console page,
 * card and table. Backward compatible with the original props (`label`,
 * `message`, `onRetry`); `title`, `action` and `compact` are optional.
 */

/** Shown while a query is in flight. */
export function LoadingState({ label = 'Loading…', compact }) {
  return (
    <div className={`rxc-state rxc-state--loading${compact ? ' rxc-state--compact' : ''}`} role="status" aria-live="polite">
      <span className="rxc-spinner" aria-hidden="true" />
      <span className="rxc-state__msg">{label}</span>
    </div>
  );
}

/** Shown when a query fails, with a retry affordance. */
export function ErrorState({ title = 'We couldn’t load this', message = 'Something went wrong.', onRetry, compact }) {
  return (
    <div className={`rxc-state rxc-state--error${compact ? ' rxc-state--compact' : ''}`} role="alert">
      <span className="rxc-state__icon rxc-tone--red"><Icon name="alertCircle" size={20} /></span>
      <div className="rxc-state__text">
        <p className="rxc-state__title">{title}</p>
        <p className="rxc-state__msg">{message}</p>
      </div>
      {onRetry !== undefined ? (
        <button type="button" className="rxc-btn rxc-btn--secondary rxc-btn--sm" onClick={() => onRetry()}>
          <Icon name="refresh" size={15} /><span>Try again</span>
        </button>
      ) : null}
    </div>
  );
}

/** Shown when a query succeeds but returns nothing (or nothing matches). */
export function EmptyState({ title, message, icon = 'inbox', action, compact }) {
  return (
    <div className={`rxc-state rxc-state--empty${compact ? ' rxc-state--compact' : ''}`}>
      <span className="rxc-state__icon"><Icon name={icon} size={20} /></span>
      <div className="rxc-state__text">
        {title ? <p className="rxc-state__title">{title}</p> : null}
        {message ? <p className="rxc-state__msg">{message}</p> : null}
      </div>
      {action ?? null}
    </div>
  );
}
