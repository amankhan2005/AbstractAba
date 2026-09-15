/** Exponential backoff with a ceiling — ported unchanged (pure function). */
export const DEFAULT_BACKOFF = { baseMs: 1_000, factor: 2, maxMs: 5 * 60 * 1_000 };

export function nextBackoffDelayMs(attempt, backoff = DEFAULT_BACKOFF) {
  const delay = backoff.baseMs * backoff.factor ** Math.max(0, attempt - 1);
  return Math.min(delay, backoff.maxMs);
}
