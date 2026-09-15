import { EraService, ERA_PROCESS_JOB } from './era.service.js';
import { createEraRouter } from './era.routes.js';
import { jobRegistry, jobQueue } from '../jobs/index.js';

export const eraService = new EraService({ jobQueue });
export const eraRouter = createEraRouter(eraService);

// ERA processing job — runs on the shared worker (inside withTenant via job.tenantId).
// Idempotent and retry-safe; the service guards against double posting.
jobRegistry.register({
  type: ERA_PROCESS_JOB,
  handler: async (payload, { job }) => {
    await eraService.processFile(job.tenantId, payload.eraFileId, job.actorId ?? null);
  },
  maxAttempts: 3,
});

export { EraService } from './era.service.js';
