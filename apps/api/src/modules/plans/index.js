import { organizationService } from '../organization/index.js';
import { clientsRepository } from '../clients/index.js';
import { staffRepository } from '../staff/index.js';
import { PlansService } from './plans.service.js';
import { plansRepository } from './plans.repository.js';
import { createPlansRouter } from './plans.routes.js';

/**
 * Composition root for the clinical planning module. The service reads
 * organization state (ACTIVE gate) and validates cross-module references —
 * the client (must be ACTIVE) and the responsible BCBA (must be active staff) —
 * through narrow ports over the existing repositories.
 */
export const plansService = new PlansService({
  repository: plansRepository,
  organizations: { getById: (id) => organizationService.getById(id) },
  clients: { findById: (tenantId, id) => clientsRepository.findClientById(tenantId, id) },
  staff: {
    findById: (tenantId, id) => staffRepository.findStaffById(tenantId, id),
    findByUserId: (tenantId, userId) => staffRepository.findStaffByUserId(tenantId, userId),
  },
});

export const plansRouter = createPlansRouter(plansService);

export { PlansService } from './plans.service.js';
export { PlansController } from './plans.controller.js';
export { plansRepository } from './plans.repository.js';
