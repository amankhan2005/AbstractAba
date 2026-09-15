import { organizationService } from '../organization/index.js';
import { SupervisionService } from './supervision.service.js';
import { supervisionRepository } from './supervision.repository.js';
import { createSupervisionRouter } from './supervision.routes.js';

/**
 * Composition root for the supervision workflow. Reuses the organization ACTIVE
 * gate through a narrow port; all persistence is tenant-scoped in the repository.
 */
export const supervisionService = new SupervisionService({
  repository: supervisionRepository,
  organizations: { getById: (id) => organizationService.getById(id) },
});

export const supervisionRouter = createSupervisionRouter(supervisionService);

export { SupervisionService } from './supervision.service.js';
export { supervisionRepository } from './supervision.repository.js';
