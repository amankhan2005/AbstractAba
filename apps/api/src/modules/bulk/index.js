import { BulkService } from './bulk.service.js';
import { bulkRepository } from './bulk.repository.js';
import { createBulkRouter } from './bulk.routes.js';
import { buildExportKey, exportKeyBelongsToTenant } from './exportKey.js';
import { clientsService } from '../clients/index.js';
import { staffService } from '../staff/index.js';
import { documentStorage } from '../documents/index.js';

/**
 * Composition root for bulk import/export. Import delegates row creation to the
 * existing clients/staff services (same validation/audit/PHI path); export reuses
 * the Phase 4.1 storage adapter. No parallel create or storage stack.
 */
export const bulkService = new BulkService({
  clients: clientsService,
  staff: staffService,
  repositories: bulkRepository,
  exportRepo: bulkRepository,
  storage: documentStorage,
  buildExportKey,
  keyBelongsToTenant: exportKeyBelongsToTenant,
});

export const bulkRouter = createBulkRouter(bulkService);

export { BulkService } from './bulk.service.js';
