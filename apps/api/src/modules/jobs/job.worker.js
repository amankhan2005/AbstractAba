import { jobRepository } from './job.repository.js';
import { nextBackoffDelayMs, DEFAULT_BACKOFF } from './job.backoff.js';
import { withTenant, withPlatform } from '../../tenancy/tenantContext.js';
import { logger } from '../../config/logger.js';

/**
 * Polling worker. Claims due jobs one at a time via the atomic repository claim
 * and runs each handler. On success → succeeded; on throw → retry with backoff
 * until attempts are exhausted, then dead-letter; unknown type → dead-letter.
 *
 * A tenant job runs inside withTenant() so the handler sees correct isolation;
 * a platform job runs inside withPlatform(). This re-establishes the tenant
 * context PostgreSQL would have carried, the analogue of setting the job's
 * tenant on the connection before the handler ran.
 */
export class JobWorker {
  constructor(registry, { repo = jobRepository, pollIntervalMs = 1_000, batch = 10 } = {}) {
    this.registry = registry;
    this.repo = repo;
    this.pollIntervalMs = pollIntervalMs;
    this.batch = batch;
    this.running = false;
    this.timer = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.drain();
      } catch (err) {
        logger.error({ err: err.message }, 'job worker drain error');
      }
      if (this.running) {
        this.timer = setTimeout(loop, this.pollIntervalMs);
        this.timer.unref?.();
      }
    };
    loop();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  async drain() {
    for (let i = 0; i < this.batch; i += 1) {
      const job = await this.repo.claimNext();
      if (!job) break;
      await this.run(job);
    }
  }

  async run(job) {
    const descriptor = this.registry.get(job.type);
    if (!descriptor) {
      await this.repo.markDead(job._id, `unknown job type: ${job.type}`);
      return;
    }
    try {
      const invoke = () => descriptor.handler(job.payload, { job });
      if (job.tenantId) await withTenant(job.tenantId, invoke);
      else await withPlatform(invoke);
      await this.repo.markSucceeded(job._id);
    } catch (err) {
      // Log jobId, type, attempt and a safe error message only — NEVER the
      // payload (it carries the raw one-time token) or any credential.
      const safeError = err?.message ?? String(err);
      if (job.attempts >= descriptor.maxAttempts) {
        await this.repo.markDead(job._id, safeError);
        logger.error({ jobId: job._id, type: job.type, attempt: job.attempts, error: safeError }, 'job dead-lettered');
      } else {
        const delay = nextBackoffDelayMs(job.attempts, descriptor.backoff ?? DEFAULT_BACKOFF);
        await this.repo.markRetry(job._id, new Date(Date.now() + delay), safeError);
        logger.warn({ jobId: job._id, type: job.type, attempt: job.attempts, error: safeError }, 'job failed; scheduled for retry');
      }
    }
  }
}
