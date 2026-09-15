/**
 * Escape a user-supplied string for safe use inside a RegExp. Prevents ReDoS /
 * injection via metacharacters in search terms — the term is always treated as a
 * literal. Shared by search and per-entity list filters.
 */
export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
