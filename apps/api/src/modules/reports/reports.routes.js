import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { sendSuccess } from '../../common/http/responder.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { enterTenantContext } from '../../middleware/tenantContext.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { AppError } from '../../common/errors/AppError.js';
import * as S from './reports.schemas.js';

export function createReportsRouter(service) {
  const r = Router();

  // Every route below is tenant-scoped. `enterTenantContext` was missing here:
  // authorization needed nothing from the database, so the omission was
  // invisible. requirePermission now resolves the caller's data scope by
  // reading tenant-owned models, which requires an active context. Mounting it
  // once on the router also stops the next route being added without it.
  r.use(authenticate, enterTenantContext);

  const orgId = (req) => { const id = req.principal?.activeTenantId; if (!id) throw AppError.forbidden('AUTH-403', 'No active tenant'); return id; };
  const range = (req) => ({ preset: req.query.preset, start: req.query.start, end: req.query.end });

  r.get('/overview', requirePermission('finance.reports.read'), asyncHandler(async (req, res) => sendSuccess(res, await service.overview(orgId(req), range(req)))));
  r.get('/revenue', requirePermission('finance.reports.read'), asyncHandler(async (req, res) => sendSuccess(res, await service.revenue(orgId(req), range(req)))));
  r.get('/claims', requirePermission('finance.reports.read'), asyncHandler(async (req, res) => sendSuccess(res, await service.claims(orgId(req), range(req)))));
  r.get('/collections', requirePermission('finance.reports.read'), asyncHandler(async (req, res) => sendSuccess(res, await service.collections(orgId(req), range(req)))));
  r.get('/payroll', requirePermission('finance.reports.read'), asyncHandler(async (req, res) => sendSuccess(res, await service.payroll(orgId(req), range(req)))));
  r.get('/reconciliation', requirePermission('finance.reports.read'), asyncHandler(async (req, res) => sendSuccess(res, await service.reconciliation(orgId(req)))));

  // Export — CSV by default, real .xlsx when ?format=xlsx. Same finance.export
  // permission and same tenant-scoped data for both formats.
  r.get('/export/:kind', requirePermission('finance.export'), asyncHandler(async (req, res) => {
    const kind = req.params.kind;
    if (String(req.query.format).toLowerCase() === 'xlsx') {
      const { XLSX_CONTENT_TYPE } = await import('./reports.xlsx.js');
      const workbook = await service.exportXlsx(orgId(req), kind, range(req));
      res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
      res.setHeader('Content-Disposition', `attachment; filename="${kind}-report.xlsx"`);
      res.status(200).send(workbook);
      return;
    }
    const csv = await service.exportCsv(orgId(req), kind, range(req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${kind}-report.csv"`);
    res.status(200).send(csv);
  }));

  return r;
}
