import { Router } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { sendSuccess } from '../../common/http/responder.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePlatformOperator } from '../../middleware/requirePlatformOperator.js';
import { supportsTransactions } from '../../config/db.js';
import { auditService } from '../audit/audit.service.js';

/**
 * Platform Console read endpoints. Guarded by the isPlatformOperator boundary.
 * Per-tenant audit inspection reuses the frozen AuditService per selected
 * tenant — NOT a cross-tenant firehose (a true stream needs a bypass role,
 * deferred as in the original). All reads → no audit catalogue change.
 */
// NOTE: tenant list/detail are served by the organization module
// (GET /platform/organizations) and reused here, exactly as in the original.
export const consoleRouter = Router();
const startedAt = new Date();
consoleRouter.use(authenticate, requirePlatformOperator);

consoleRouter.get('/health', asyncHandler(async (_req, res) => {
  // Real readiness signals the backend already has. Wrapped with sendSuccess so
  // the response is { data: {...} } like every other endpoint; the console
  // client reads response.data.data and must never receive undefined.
  const dbConnected = mongoose.connection.readyState === 1;
  const checks = [
    {
      name: 'database',
      status: dbConnected ? 'up' : 'down',
      detail: dbConnected
        ? `transactions ${supportsTransactions() ? 'available' : 'unavailable'}`
        : 'not connected',
    },
  ];
  const status = checks.every((c) => c.status === 'up') ? 'up' : 'down';
  sendSuccess(res, {
    status,
    version: process.env.npm_package_version ?? '1.0.0',
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    checks,
  });
}));

consoleRouter.get('/tenants/:tenantId/audit', asyncHandler(async (req, res) => {
  // Every other endpoint replies { data: ... } via sendSuccess, and the console
  // client always reads response.data.data. This handler used to call
  // res.json({ records }) directly, which put the payload at response.data —
  // one level too shallow — so response.data.data was undefined and React
  // Query rejected the query with "Query data cannot be undefined". The fix
  // is just to use the same envelope helper as everything else.
  const records = await auditService.query(req.params.tenantId, { limit: 100 });
  sendSuccess(res, records);
}));

consoleRouter.get('/tenants/:tenantId/audit/verify', asyncHandler(async (req, res) => {
  const result = await auditService.verify(req.params.tenantId);
  sendSuccess(res, result);
}));
