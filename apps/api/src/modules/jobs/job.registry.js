/**
 * Validates job registrations at construction (duplicate type, bad attempts,
 * bad backoff) and resolves type → descriptor + handler. Empty in Phase 1;
 * owning modules register their handlers at the composition root.
 */
export class JobRegistry {
  constructor() {
    this.map = new Map();
  }

  register({ type, handler, maxAttempts = 5, backoff }) {
    if (this.map.has(type)) throw new Error(`Duplicate job type registered: ${type}`);
    if (typeof handler !== 'function') throw new Error(`Job ${type} needs a handler function`);
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error(`Job ${type} maxAttempts must be >= 1`);
    this.map.set(type, { type, handler, maxAttempts, backoff });
    return this;
  }

  get(type) {
    return this.map.get(type) ?? null;
  }

  has(type) {
    return this.map.has(type);
  }
}
