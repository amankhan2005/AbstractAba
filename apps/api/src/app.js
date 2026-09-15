import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { securityHeaders, globalRateLimit } from './middleware/security.js';
import { apiRouter } from './routes/index.js';
import { notFoundHandler, errorHandler } from './common/errors/errorHandler.js';
import { env } from './config/env.js';
import { auditRecorder } from './middleware/auditRecorder.js';

/**
 * Express application. Kept free of process concerns (listen, DB connect,
 * worker) so it can be imported by tests and mounted anywhere. server.js owns
 * the lifecycle.
 */
export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(securityHeaders);
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  // Parses the hardened httpOnly refresh cookie (blueprint 9.1). Unsigned: the
  // token is already a high-entropy opaque value verified server-side by hash,
  // so a cookie signature would add ceremony without adding a guarantee.
  app.use(cookieParser());
  app.use(globalRateLimit);

  app.use(auditRecorder());
  app.use('/api/v1', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
