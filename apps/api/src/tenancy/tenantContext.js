import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * ---------------------------------------------------------------------------
 * Tenant context — the MongoDB replacement for PostgreSQL's transaction-scoped
 * `SET LOCAL app.current_tenant_id`.
 *
 * THIS IS THE MOST SAFETY-CRITICAL MODULE IN THE PLATFORM.
 *
 * PostgreSQL bound the tenant identifier to a transaction with `set_config(...,
 * is_local => true)`, and row-level security filtered every statement against
 * it. MongoDB has neither construct, so isolation is re-established here with
 * two cooperating parts:
 *
 *   1. This module — an `AsyncLocalStorage` store that carries the active tenant
 *      for the entire async lifetime of a request. It is the async analogue of
 *      `SET LOCAL`: the value lives on the logical execution context, NOT on a
 *      shared connection, so it can never leak from one request onto another
 *      that happens to reuse the same pooled socket. There is no `SET` (session)
 *      form to misuse; `run()` is the only way to establish context and it is
 *      strictly scoped to the callback.
 *
 *   2. `tenantPlugin.js` — a Mongoose plugin, applied to every tenant-owned
 *      model, that reads this context on every query and write and refuses to
 *      run a tenant-scoped operation without it. That is what makes a forgotten
 *      `.where({ orgId })` impossible rather than merely discouraged.
 *
 * FAIL CLOSED. PostgreSQL RLS returned zero rows when the context was unset
 * (`tenant_id = NULL` is never true). We go one better: a tenant-scoped
 * operation with no context *throws*, surfacing the defect immediately instead
 * of silently returning nothing. A silent empty result can be mistaken for
 * "this tenant has no data"; a thrown error cannot.
 * ---------------------------------------------------------------------------
 */

/** @typedef {{ tenantId: string | null, platform: boolean }} TenantScope */

/** @type {AsyncLocalStorage<TenantScope>} */
const storage = new AsyncLocalStorage();

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class TenantContextError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TenantContextError';
  }
}

/**
 * Runs `callback` with tenant isolation bound to the current async context.
 *
 * The identifier is validated before it is stored. It arrives from a verified
 * token rather than user input, but validating here means a defect upstream
 * cannot become a query-level surprise — the same defence the PostgreSQL
 * `withTenant` applied before `set_config`.
 *
 * @template T
 * @param {string} tenantId
 * @param {() => Promise<T>} callback
 * @returns {Promise<T>}
 */
export function withTenant(tenantId, callback) {
  if (!UUID_PATTERN.test(tenantId)) {
    throw new TenantContextError(
      'A tenant-scoped operation requires a valid tenant identifier',
    );
  }
  return storage.run({ tenantId, platform: false }, callback);
}

/**
 * Runs `callback` with NO tenant context — platform operations only
 * (creating an organization, listing tenants in the console, aggregating usage
 * for billing).
 *
 * This is the analogue of PostgreSQL's `withPlatform`, which cleared the
 * setting explicitly. Entering platform scope is deliberate and auditable: a
 * handler must opt in, and the plugin treats "platform scope" and "no scope at
 * all" as different states. Callers own their own authorization here — nothing
 * is filtering these queries, exactly as nothing filtered the PostgreSQL
 * platform path.
 *
 * @template T
 * @param {() => Promise<T>} callback
 * @returns {Promise<T>}
 */
export function withPlatform(callback) {
  return storage.run({ tenantId: null, platform: true }, callback);
}

/**
 * The tenant identifier bound to the current async context, or `null` when the
 * context is platform-scoped. Throws when no context has been established at
 * all — a tenant-scoped operation outside any `withTenant`/`withPlatform` is a
 * programming error and must fail loudly.
 *
 * @returns {string | null}
 */
export function requireScope() {
  const scope = storage.getStore();
  if (!scope) {
    throw new TenantContextError(
      'No tenant context is active. A tenant-scoped operation must run inside ' +
        'withTenant() (a clinic request) or withPlatform() (a platform operation).',
    );
  }
  return scope.tenantId;
}

/**
 * Non-throwing peek at the current scope, for diagnostics and for the plugin's
 * platform-scope check. Returns `undefined` when no context is active.
 *
 * @returns {TenantScope | undefined}
 */
export function currentScope() {
  return storage.getStore();
}

/** The active tenant id, or null if platform-scoped / no context. Never throws. */
export function currentTenantId() {
  return storage.getStore()?.tenantId ?? null;
}
