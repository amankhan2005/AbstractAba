import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { reconcileIndexes } from './config/reconcileIndexes.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { jobRegistry } from './modules/jobs/index.js';
import { JobWorker } from './modules/jobs/job.worker.js';

/**
 * Composition root. Connects the database, constructs the job registry +
 * worker (empty in Phase 1; owning modules register handlers here as they are
 * built), starts the HTTP server, and wires graceful shutdown.
 */
async function main() {
  await connectDatabase();

  // Reconcile the LIVE database indexes with the corrected schema before serving
  // traffic. A corrected Mongoose schema does not repair a running database on
  // its own — autoIndex creates new indexes but never drops obsolete ones, so a
  // stale unique { tenantId, clientId, serviceType } index would keep rejecting
  // a child's second ABA/FBA authorization with a duplicate-key error. This is
  // best-effort: a restricted DB role that cannot alter indexes logs a warning
  // (with the manual fallback command) rather than crashing startup.
  await reconcileIndexes();

  // The application graph (imported via ./app.js above) has already registered
  // every owning module's job handler on the SHARED jobRegistry — including
  // company_invitation.deliver, which delivers the Super Admin onboarding
  // invitation email. The worker must poll that same registry. Constructing a
  // fresh empty JobRegistry here (the previous bug) left the worker with zero
  // handlers, so it dead-lettered every queued job as "unknown job type" and the
  // onboarding email was never sent — while direct-send emails (password reset,
  // guardian invite) kept working, which is exactly the symptom observed.
  const jobWorker = new JobWorker(jobRegistry, { pollIntervalMs: env.jobPollIntervalMs });

  const app = createApp();
  const server = app.listen(env.port, () => {
    logger.info({ port: env.port, env: env.nodeEnv }, 'Abstract ABA API listening');
    jobWorker.start();
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    await jobWorker.stop();
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err: err.stack ?? String(err) }, 'fatal startup error');
  process.exit(1);
});
