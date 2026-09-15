/** Shown while a session restore or query is in flight. */
export function LoadingState({ label = 'Loading…' }) {
  return (
    <div className="state state--loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/** Shown when a query fails, with an optional retry affordance. */
export function ErrorState({ message = 'Something went wrong.', onRetry }) {
  return (
    <div className="state state--error" role="alert">
      <p>{message}</p>
      {onRetry !== undefined ? (
        <button type="button" className="ui-button" onClick={onRetry}>Try again</button>
      ) : null}
    </div>
  );
}

/** Shown when a query succeeds but returns nothing. */
export function EmptyState({ message }) {
  return (
    <div className="state state--empty">
      <p>{message}</p>
    </div>
  );
}
