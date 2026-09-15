import { sendSuccess, sendCreated, sendNoContent } from '../../common/http/responder.js';
import { AppError } from '../../common/errors/AppError.js';

export class InsuranceCatalogController {
  constructor(service) {
    this.service = service;
  }

  static requireTenantId(req) {
    const tenantId = req.principal?.activeTenantId;
    if (tenantId === undefined || tenantId === null) {
      throw AppError.forbidden('TENANT_CONTEXT_MISSING', 'No active company context.');
    }
    return tenantId;
  }

  // platform (Super Admin)
  list = async (req, res) => {
    const activeOnly = req.query.active === 'true';
    const entries = await this.service.list({ activeOnly, state: req.query.state ?? null });
    sendSuccess(res, entries);
  };

  get = async (req, res) => {
    sendSuccess(res, await this.service.get(req.params.id));
  };

  create = async (req, res) => {
    const entry = await this.service.create({ actorUserId: req.principal?.userId ?? null, input: req.body });
    sendCreated(res, entry, `/platform/insurance-catalog/${entry.id}`);
  };

  update = async (req, res) => {
    const entry = await this.service.update({ id: req.params.id, actorUserId: req.principal?.userId ?? null, input: req.body });
    sendSuccess(res, entry);
  };

  remove = async (req, res) => {
    await this.service.remove({ id: req.params.id, actorUserId: req.principal?.userId ?? null });
    sendNoContent(res);
  };

  // Logo upload/replace. Base64 in a JSON body (the same shape the company logo
  // endpoint uses); the DECODED bytes are validated by the uploader.
  uploadLogo = async (req, res) => {
    const raw = String(req.body.file).replace(/^data:[^;]+;base64,/, '');
    let buffer;
    try {
      buffer = Buffer.from(raw, 'base64');
    } catch {
      throw AppError.validation('We couldn’t read that file. Please choose another image.');
    }
    const entry = await this.service.uploadLogo({
      id: req.params.id,
      buffer,
      actorUserId: req.principal?.userId ?? null,
    });
    sendSuccess(res, entry);
  };

  // tenant (company) — state-filtered, read-only
  listForCompany = async (req, res) => {
    const tenantId = InsuranceCatalogController.requireTenantId(req);
    const entries = await this.service.listForCompany({ tenantId });
    sendSuccess(res, entries);
  };
}
