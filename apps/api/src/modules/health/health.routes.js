import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import mongoose from 'mongoose';
import { supportsTransactions } from '../../config/db.js';

export const healthRouter = Router();

healthRouter.get('/health', asyncHandler(async (_req, res) => {
  const dbState = mongoose.connection.readyState; // 1 = connected
  res.status(dbState === 1 ? 200 : 503).json({
    status: dbState === 1 ? 'ok' : 'degraded',
    db: { connected: dbState === 1, transactions: supportsTransactions() },
    uptimeSeconds: Math.round(process.uptime()),
    time: new Date().toISOString(),
  });
}));
