import { AppError } from '../../common/errors/AppError.js';
import { sendCreated, sendPaginated, sendSuccess } from '../../common/http/responder.js';
import { documentsError } from './documents.errors.js';

/**
 * HTTP boundary for clinical documents. Holds no rules — the ACTIVE gate, the
 * client validation, the finalized-immutability guard, and the supersede chain
 * all live in the service. Follows the established conventions: {data} envelope,
 * sendCreated with Location, mandatory If-Match on the versioned update.
 */
export class DocumentsController {
  constructor(service) {
    this.service = service;
  }

  listDocuments = async (req, res) => {
    const tenantId = DocumentsController.requireTenantId(req);
    const q = req.query;
    const page = await this.service.listDocuments({
      tenantId,
      limit: q.limit,
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.clientId !== undefined ? { clientId: q.clientId } : {}),
      ...(q.documentType !== undefined ? { documentType: q.documentType } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
    });
    sendPaginated(res, page.items, { nextCursor: page.nextCursor, limit: q.limit });
  };

  createDocument = async (req, res) => {
    const principal = DocumentsController.requirePrincipal(req);
    const doc = await this.service.createDocument({
      tenantId: DocumentsController.requireTenantId(req),
      actorUserId: principal.userId,
      input: req.body,
    });
    sendCreated(res, doc, `/api/v1/documents/${doc.id}`);
  };

  getDocument = async (req, res) => {
    const doc = await this.service.getDocument({
      tenantId: DocumentsController.requireTenantId(req),
      documentId: req.params.documentId,
    });
    sendSuccess(res, doc);
  };

  updateDocument = async (req, res) => {
    const principal = DocumentsController.requirePrincipal(req);
    const doc = await this.service.updateDocument({
      tenantId: DocumentsController.requireTenantId(req),
      documentId: req.params.documentId,
      actorUserId: principal.userId,
      expectedVersion: DocumentsController.requireVersion(req),
      input: req.body,
    });
    sendSuccess(res, doc);
  };

  finalizeDocument = async (req, res) => {
    const principal = DocumentsController.requirePrincipal(req);
    const result = await this.service.finalizeDocument({
      tenantId: DocumentsController.requireTenantId(req),
      documentId: req.params.documentId,
      actorUserId: principal.userId,
    });
    sendSuccess(res, result);
  };

  archiveDocument = async (req, res) => {
    const principal = DocumentsController.requirePrincipal(req);
    const result = await this.service.archiveDocument({
      tenantId: DocumentsController.requireTenantId(req),
      documentId: req.params.documentId,
      actorUserId: principal.userId,
    });
    sendSuccess(res, result);
  };

  supersedeDocument = async (req, res) => {
    const principal = DocumentsController.requirePrincipal(req);
    const doc = await this.service.supersedeDocument({
      tenantId: DocumentsController.requireTenantId(req),
      documentId: req.params.documentId,
      actorUserId: principal.userId,
      input: req.body,
    });
    sendCreated(res, doc, `/api/v1/documents/${doc.id}`);
  };

  attachFile = async (req, res) => {
    const principal = DocumentsController.requirePrincipal(req);
    const doc = await this.service.attachFile({
      tenantId: DocumentsController.requireTenantId(req),
      documentId: req.params.documentId,
      actorUserId: principal.userId,
      upload: req.body,
    });
    sendSuccess(res, doc);
  };

  downloadFile = async (req, res) => {
    DocumentsController.requirePrincipal(req);
    const { buffer, contentType, fileName } = await this.service.downloadFile({
      tenantId: DocumentsController.requireTenantId(req),
      documentId: req.params.documentId,
    });
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName || 'document')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).send(buffer);
  };

  // --- guards --------------------------------------------------------------

  static requirePrincipal(req) {
    if (!req.principal) throw AppError.unauthorized('AUTH-401', 'Authentication required');
    return req.principal;
  }

  static requireTenantId(req) {
    const tenantId = req.principal?.activeTenantId;
    if (tenantId === undefined || tenantId === null) throw documentsError('TENANT_CONTEXT_MISSING');
    return tenantId;
  }

  static requireVersion(req) {
    const header = req.get('if-match');
    if (header === undefined || !/^\d+$/.test(header)) {
      throw AppError.validation('Supply the version you read in an If-Match header.', [
        { path: 'headers.if-match', message: 'Required' },
      ]);
    }
    return Number.parseInt(header, 10);
  }
}
