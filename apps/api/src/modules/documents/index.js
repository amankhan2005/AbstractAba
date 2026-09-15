import { organizationService } from '../organization/index.js';
import { clientsRepository } from '../clients/index.js';
import { DocumentsService } from './documents.service.js';
import { documentsRepository } from './documents.repository.js';
import { createDocumentsRouter } from './documents.routes.js';
import { createStorageAdapter } from './storage/index.js';
import { env } from '../../config/env.js';

/**
 * Composition root for the clinical-documents module. The service reads
 * organization state (ACTIVE gate) and validates the client a document is filed
 * against through a narrow port over the existing clients repository, so no
 * module reaches into another's internals. Binary artifacts go through a
 * pluggable storage adapter (local by default; S3-swappable via env) and the
 * server-authoritative upload limits.
 */
export const documentStorage = createStorageAdapter();

export const documentsService = new DocumentsService({
  repository: documentsRepository,
  organizations: { getById: (id) => organizationService.getById(id) },
  clients: { findById: (tenantId, id) => clientsRepository.findClientById(tenantId, id) },
  storage: documentStorage,
  limits: { maxBytes: env.documentMaxBytes, allowedMimeTypes: env.documentAllowedMimeTypes },
});

export const documentsRouter = createDocumentsRouter(documentsService);

export { DocumentsService } from './documents.service.js';
export { DocumentsController } from './documents.controller.js';
export { documentsRepository } from './documents.repository.js';
