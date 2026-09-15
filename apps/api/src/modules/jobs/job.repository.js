import { Job } from '../../models/index.js';
import { withPlatform } from '../../tenancy/tenantContext.js';
import { newId } from '../../utils/id.js';

/**
 * Job repository (MongoDB, platform-scoped).
 *
 * The claim — PostgreSQL's `SELECT ... FOR UPDATE SKIP LOCKED` — becomes an
 * atomic `findOneAndUpdate` that flips the oldest due `pending` job to
 * `running` and returns it. `findOneAndUpdate` is atomic at the document level,
 * so two workers can never claim the same job: the first update wins, the
 * second matches nothing. This is the canonical MongoDB work-queue claim.
 */
export class JobRepository {
  async insert(job) {
    return withPlatform(async () => {
      const [created] = await Job.create([
        {
          _id: newId(),
          type: job.type,
          tenantId: job.tenantId ?? null,
          actorId: job.actorId ?? null,
          payload: job.payload ?? {},
          idempotencyKey: job.idempotencyKey ?? null,
          status: 'pending',
          attempts: 0,
          maxAttempts: job.maxAttempts,
          runAt: job.runAt ?? new Date(),
        },
      ]);
      return created.toObject();
    });
  }

  async findByIdempotency(tenantId, type, idempotencyKey) {
    if (!idempotencyKey) return null;
    return withPlatform(async () =>
      Job.findOne({ tenantId: tenantId ?? null, type, idempotencyKey }).lean(),
    );
  }

  /** Atomically claim the oldest due pending job. Returns the claimed job or null. */
  async claimNext(now = new Date()) {
    return withPlatform(async () =>
      Job.findOneAndUpdate(
        { status: 'pending', runAt: { $lte: now } },
        { $set: { status: 'running', claimedAt: now }, $inc: { attempts: 1 } },
        { sort: { runAt: 1 }, new: true },
      ).lean(),
    );
  }

  async markSucceeded(id) {
    return withPlatform(async () => {
      await Job.updateOne({ _id: id }, { $set: { status: 'succeeded', lastError: null } });
    });
  }

  async markRetry(id, runAt, error) {
    return withPlatform(async () => {
      await Job.updateOne(
        { _id: id },
        { $set: { status: 'pending', runAt, lastError: String(error).slice(0, 1000) } },
      );
    });
  }

  async markDead(id, error) {
    return withPlatform(async () => {
      await Job.updateOne({ _id: id }, { $set: { status: 'dead', lastError: String(error).slice(0, 1000) } });
    });
  }
}

export const jobRepository = new JobRepository();
