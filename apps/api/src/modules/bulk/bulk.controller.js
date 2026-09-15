import { AppError } from '../../common/errors/AppError.js';
import { sendSuccess, sendCreated } from '../../common/http/responder.js';

const MAX_CSV_BYTES = 5 * 1024 * 1024; // 5 MiB decoded cap

/**
 * Bulk import/export HTTP surface. Tenant + actor come from the authenticated
 * principal (server-authoritative); the client supplies only the CSV payload.
 */
export class BulkController {
  constructor(service) {
    this.service = service;
  }

  static requirePrincipal(req) {
    if (!req.principal) throw AppError.unauthorized('AUTH-401', 'Authentication required');
    return req.principal;
  }

  static requireTenantId(req) {
    const tenantId = req.principal?.activeTenantId;
    if (tenantId === undefined || tenantId === null) throw AppError.unauthorized('AUTH-401', 'Tenant context missing');
    return tenantId;
  }

  static decodeCsv(base64) {
    if (typeof base64 !== 'string' || base64 === '') throw AppError.validation('CSV content is required.');
    const comma = base64.indexOf(',');
    const raw = base64.startsWith('data:') && comma !== -1 ? base64.slice(comma + 1) : base64;
    if (!/^[A-Za-z0-9+/\s]+={0,2}$/.test(raw)) throw AppError.validation('CSV content is not valid base64.');
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 0) throw AppError.validation('Decoded CSV is empty.');
    if (buf.length > MAX_CSV_BYTES) throw AppError.validation('CSV file exceeds the maximum allowed size.');
    return buf.toString('utf8');
  }

  previewImport = async (req, res) => {
    BulkController.requirePrincipal(req);
    const csvText = BulkController.decodeCsv(req.body.base64);
    const result = await this.service.previewImport({
      tenantId: BulkController.requireTenantId(req),
      entity: req.params.entity,
      csvText,
    });
    sendSuccess(res, result);
  };

  commitImport = async (req, res) => {
    const principal = BulkController.requirePrincipal(req);
    const csvText = BulkController.decodeCsv(req.body.base64);
    const result = await this.service.commitImport({
      tenantId: BulkController.requireTenantId(req),
      actorUserId: principal.userId,
      entity: req.params.entity,
      csvText,
    });
    sendCreated(res, result, null);
  };

  generateExport = async (req, res) => {
    const principal = BulkController.requirePrincipal(req);
    const record = await this.service.generateExport({
      tenantId: BulkController.requireTenantId(req),
      actorUserId: principal.userId,
    });
    sendCreated(res, record, `/api/v1/bulk/exports/${record.id}`);
  };

  listExports = async (req, res) => {
    BulkController.requirePrincipal(req);
    const rows = await this.service.listExports({ tenantId: BulkController.requireTenantId(req) });
    sendSuccess(res, rows);
  };

  downloadExport = async (req, res) => {
    const principal = BulkController.requirePrincipal(req);
    const { buffer, fileName } = await this.service.downloadExport({
      tenantId: BulkController.requireTenantId(req),
      exportId: req.params.exportId,
      actorUserId: principal.userId,
    });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).send(buffer);
  };
}
