import { jobRepository } from './job.repository.js';

/**
 * JobQueue port — the ONLY way business modules enqueue work. Validates the
 * type is registered, dedupes on (tenant, type, idempotencyKey), inserts a
 * pending row. Mirrors the frozen contract from the original Job Runner.
 */
export class JobQueueService {
  constructor(registry, repo = jobRepository) {
    this.registry = registry;
    this.repo = repo;
  }

  async enqueue({ type, tenantId = null, actorId = null, payload = {}, idempotencyKey = null, runAt = new Date() }) {
    const descriptor = this.registry.get(type);
    if (!descriptor) throw new Error(`Cannot enqueue unregistered job type: ${type}`);

    if (idempotencyKey) {
      const existing = await this.repo.findByIdempotency(tenantId, type, idempotencyKey);
      if (existing) return existing;
    }
    return this.repo.insert({ type, tenantId, actorId, payload, idempotencyKey, runAt, maxAttempts: descriptor.maxAttempts });
  }
}
