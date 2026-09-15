import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { sendSuccess, sendCreated, sendNoContent } from '../../common/http/responder.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { enterTenantContext } from '../../middleware/tenantContext.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { AppError } from '../../common/errors/AppError.js';
import * as S from './payroll.schemas.js';

/**
 * Tenant-scoped timesheet & payroll routes. Every handler resolves the caller's
 * organization from the authenticated principal (activeTenantId) and passes it
 * to the service, which runs inside withTenant() — so cross-company access is
 * impossible. Permissions:
 *   timesheets.read/write   — view / edit timesheets & entries
 *   timesheets.approve      — submit/approve/reject transitions
 *   payroll.read/manage     — view / generate / approve / finalize payroll
 */
export function createPayrollRouter(service) {
  const r = Router();

  // DEFECT FIX. Every route below mounted `authenticate` but never
  // `enterTenantContext`, relying instead on each service method opening its
  // own withTenant(orgId). That worked only while authorization needed nothing
  // from the database. requirePermission now resolves the caller's data scope
  // by reading tenant-owned models (staff profile, assignments, supervision),
  // so without a tenant context every payroll route throws TenantContextError.
  //
  // Mounting it here rather than per-route also removes the chance of the next
  // route being added without it. The per-handler withTenant() calls remain —
  // they are idempotent, and defence in depth is the point.
  r.use(authenticate, enterTenantContext);
  const orgId = (req) => {
    const id = req.principal?.activeTenantId;
    if (!id) throw AppError.forbidden('AUTH-403', 'No active tenant');
    return id;
  };
  const actor = (req) => req.principal.userId;

  // pay rates
  r.post('/pay-rates', requirePermission('payroll.manage'), validate(S.createPayRateSchema),
    asyncHandler(async (req, res) => sendCreated(res, await service.createPayRate(orgId(req), req.body, actor(req)))));
  r.get('/pay-rates', requirePermission('payroll.read'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.listPayRates(orgId(req), { staffProfileId: req.query.staffProfileId }))));

  // pay periods
  r.post('/pay-periods', requirePermission('payroll.manage'), validate(S.createPayPeriodSchema),
    asyncHandler(async (req, res) => sendCreated(res, await service.createPayPeriod(orgId(req), req.body, actor(req)))));
  r.get('/pay-periods', requirePermission('payroll.read'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.listPayPeriods(orgId(req)))));

  // timesheets
  r.post('/timesheets', requirePermission('timesheets.write'), validate(S.openTimesheetSchema),
    asyncHandler(async (req, res) => sendCreated(res, await service.getOrCreateTimesheet(orgId(req), req.body, actor(req)))));
  r.get('/timesheets', requirePermission('timesheets.read'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.listTimesheets(orgId(req), { ...req.query, dataScope: req.dataScope }))));
  r.get('/timesheets/:id', requirePermission('timesheets.read'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.getTimesheet(orgId(req), req.params.id, { dataScope: req.dataScope }))));
  r.post('/timesheets/:id/import-sessions', requirePermission('timesheets.write'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.importSessions(orgId(req), req.params.id, actor(req)))));
  r.post('/timesheets/:id/entries', requirePermission('timesheets.write'), validate(S.manualEntrySchema),
    asyncHandler(async (req, res) => sendCreated(res, await service.addManualEntry(orgId(req), req.params.id, req.body, actor(req)))));
  r.delete('/timesheets/:id/entries/:entryId', requirePermission('timesheets.write'),
    asyncHandler(async (req, res) => { await service.removeEntry(orgId(req), req.params.id, req.params.entryId, actor(req)); sendNoContent(res); }));
  r.post('/timesheets/:id/transitions', requirePermission('timesheets.approve'), validate(S.timesheetTransitionSchema),
    asyncHandler(async (req, res) => sendSuccess(res, await service.transitionTimesheet(orgId(req), req.params.id, req.body.target, actor(req), req.body))));

  // payroll runs
  r.post('/runs', requirePermission('payroll.manage'), validate(S.generateRunSchema),
    asyncHandler(async (req, res) => sendCreated(res, await service.generatePayrollRun(orgId(req), req.body, actor(req)))));
  r.get('/runs/preview', requirePermission('payroll.read'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.previewPayrollRun(orgId(req), { payPeriodId: req.query.payPeriodId }))));
  r.get('/runs', requirePermission('payroll.read'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.listPayrollRuns(orgId(req), req.query))));
  r.get('/runs/:id', requirePermission('payroll.read'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.getPayrollRun(orgId(req), req.params.id))));
  r.post('/runs/:id/transitions', requirePermission('payroll.manage'), validate(S.runTransitionSchema),
    asyncHandler(async (req, res) => sendSuccess(res, await service.transitionPayrollRun(orgId(req), req.params.id, req.body.target, actor(req)))));

  // Company Admin period payroll (weekly / bi-weekly / custom). Preview is
  // read-only (payroll.read); generate persists a run (payroll.manage). The
  // organization is always the caller's own active tenant — never the body.
  r.get('/period/preview', requirePermission('payroll.read'), validate(S.periodPayrollQuerySchema, 'query'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.previewPeriodPayroll(orgId(req), req.query))));
  r.post('/period/generate', requirePermission('payroll.manage'), validate(S.generatePeriodSchema),
    asyncHandler(async (req, res) => sendCreated(res, await service.generatePeriodPayroll(orgId(req), req.body, actor(req)))));

  // The generated payroll for a period (null when not generated yet).
  r.get('/period/generated', requirePermission('payroll.read'), validate(S.periodPayrollQuerySchema, 'query'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.getGeneratedPeriodPayroll(orgId(req), req.query))));
  // Payroll Summary PDF — built from the generated payroll.
  r.get('/period/export.pdf', requirePermission('payroll.read'), validate(S.periodPayrollQuerySchema, 'query'),
    asyncHandler(async (req, res) => {
      const { buffer, filename } = await service.buildPeriodPayrollPdf(orgId(req), req.query);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', buffer.length);
      res.status(200).end(buffer);
    }));

  // Payroll Summary Excel — built from the generated payroll. Server-authoritative dataset,
  // tenant + permission enforced, streamed as a real .xlsx attachment.
  r.get('/period/export.xlsx', requirePermission('payroll.read'), validate(S.periodPayrollQuerySchema, 'query'),
    asyncHandler(async (req, res) => {
      const { buffer, filename } = await service.buildPeriodPayrollWorkbook(orgId(req), req.query);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', buffer.length);
      res.status(200).end(buffer);
    }));

  return r;
}
