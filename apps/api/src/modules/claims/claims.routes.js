import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { sendSuccess, sendCreated } from '../../common/http/responder.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { enterTenantContext } from '../../middleware/tenantContext.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { AppError } from '../../common/errors/AppError.js';
import * as S from './claims.schemas.js';

/** Tenant-scoped claim routes. Org resolved from principal; service uses withTenant. */
export function createClaimsRouter(service) {
  const r = Router();

  // Every route below is tenant-scoped. `enterTenantContext` was missing here:
  // authorization needed nothing from the database, so the omission was
  // invisible. requirePermission now resolves the caller's data scope by
  // reading tenant-owned models, which requires an active context. Mounting it
  // once on the router also stops the next route being added without it.
  r.use(authenticate, enterTenantContext);

  const orgId = (req) => {
    const id = req.principal?.activeTenantId;
    if (!id) throw AppError.forbidden('AUTH-403', 'No active tenant');
    return id;
  };
  const actor = (req) => req.principal.userId;

  r.get('/', requirePermission('claims.read'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.listClaims(orgId(req), req.query))));
  r.get('/:id', requirePermission('claims.read'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.getClaim(orgId(req), req.params.id))));
  r.get('/:id/lines', requirePermission('claims.read'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.getClaimLines(orgId(req), req.params.id))));
  r.get('/:id/history', requirePermission('claims.read'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.getStatusHistory(orgId(req), req.params.id))));
  r.post('/preview', requirePermission('claims.read'), validate(S.previewClaimSchema),
    asyncHandler(async (req, res) => sendSuccess(res, await service.previewFromSessions(orgId(req), req.body))));

  // Child + period insurance-billing preview (spec §1–§9): server finds the
  // qualifying sessions, staff and authorizations automatically. Read-only.
  r.get('/billing/preview', requirePermission('claims.read'), validate(S.childBillingSchema, 'query'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.previewChildBilling(orgId(req), req.query))));
  // Generate insurance claim(s) for a child + period (spec §2/§10). Reuses the
  // existing per-authorization generator + idempotency. Gated on claims.manage:
  // the Company Admin (org_admin) and Owner insurance-billing roles hold
  // claims.manage (they do NOT hold the billing-staff-only claims.write), so
  // requiring claims.write here 403'd the Company Admin workflow. claims.manage
  // is the existing claim-administration permission and keeps least privilege —
  // BCBA/RBT/scheduler still cannot generate.
  r.post('/billing/generate', requirePermission('claims.manage'), validate(S.childBillingSchema),
    asyncHandler(async (req, res) => sendCreated(res, await service.generateChildBilling(orgId(req), req.body, actor(req)))));
  // XLSX export of the child + period billing view (spec §12).
  r.get('/billing/export.xlsx', requirePermission('claims.read'), validate(S.childBillingSchema, 'query'),
    asyncHandler(async (req, res) => {
      const { buffer, filename } = await service.buildChildBillingWorkbook(orgId(req), req.query);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', buffer.length);
      res.status(200).end(buffer);
    }));
  // ---- Company-wide Billing (Billing rebuild spec §2–§19) ----------------
  // Date range only; the server finds every relevant client. Read-only preview.
  r.get('/billing/company/preview', requirePermission('claims.read'), validate(S.companyBillingSchema, 'query'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.previewCompanyBilling(orgId(req), req.query))));
  // The GENERATED bill for a period, read back from the persisted claims (null
  // when the period has not been generated) — what the page shows and exports.
  r.get('/billing/company/bill', requirePermission('claims.read'), validate(S.companyBillingSchema, 'query'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.getGeneratedBill(orgId(req), req.query))));
  // Billing periods with a generated bill, newest first (reopen a bill).
  r.get('/billing/company/bills', requirePermission('claims.read'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.listGeneratedBills(orgId(req)))));
  // Generate all eligible bills across every client in ONE operation (spec §14).
  r.post('/billing/company/generate', requirePermission('claims.manage'), validate(S.companyBillingSchema),
    asyncHandler(async (req, res) => sendCreated(res, await service.generateCompanyBilling(orgId(req), req.body, actor(req)))));
  // Generated-bill Excel download — built from the persisted bill only.
  r.get('/billing/company/export.xlsx', requirePermission('claims.read'), validate(S.companyBillingSchema, 'query'),
    asyncHandler(async (req, res) => {
      const { buffer, filename } = await service.buildCompanyBillingWorkbook(orgId(req), req.query);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', buffer.length);
      res.status(200).end(buffer);
    }));
  // Generated-bill PDF download — built from the persisted bill only.
  r.get('/billing/company/export.pdf', requirePermission('claims.read'), validate(S.companyBillingSchema, 'query'),
    asyncHandler(async (req, res) => {
      const { buffer, filename } = await service.buildCompanyBillingPdf(orgId(req), req.query);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', buffer.length);
      res.status(200).end(buffer);
    }));

  r.post('/generate', requirePermission('claims.write'), validate(S.generateClaimSchema),
    asyncHandler(async (req, res) => sendCreated(res, await service.generateFromSessions(orgId(req), req.body, actor(req)))));
  r.post('/:id/submit', requirePermission('claims.submit'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.submitClaim(orgId(req), req.params.id, actor(req)))));
  r.post('/:id/resubmit', requirePermission('claims.submit'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.resubmitClaim(orgId(req), req.params.id, actor(req)))));
  r.post('/:id/transitions', requirePermission('claims.manage'), validate(S.transitionClaimSchema),
    asyncHandler(async (req, res) => sendSuccess(res, await service.transition(orgId(req), req.params.id, req.body.target, actor(req), { reason: req.body.reason }))));

  return r;
}
