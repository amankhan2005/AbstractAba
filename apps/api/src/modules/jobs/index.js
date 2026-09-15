import { JobRegistry } from './job.registry.js';
import { JobQueueService } from './job.queue.js';

/**
 * Shared job wiring. Owning modules register their handlers on jobRegistry at
 * composition time; business modules enqueue only through jobQueue (the port).
 * The worker is started by the server process, not here, to avoid side effects
 * at import.
 */
export const jobRegistry = new JobRegistry();
export const jobQueue = new JobQueueService(jobRegistry);

export { JobRegistry } from './job.registry.js';
export { JobQueueService } from './job.queue.js';
