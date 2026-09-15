import { DashboardsService } from './dashboards.service.js';
import { dashboardsRepository } from './dashboards.repository.js';
import { createDashboardsRouter } from './dashboards.routes.js';
import { organizationService } from '../organization/index.js';
import { appointmentNotesService } from '../scheduling/index.js';

/**
 * Composition root for the role-dashboards module. The service reads existing
 * clinical collections through the dashboards repository's tenant-scoped
 * methods only — it owns no writable entities. The Company dashboard also reads
 * the organization's timezone (business date) and reuses the Appointment Notes
 * service's current-day overview, so notes follow their one existing rule set.
 */
export const dashboardsService = new DashboardsService({
  repository: dashboardsRepository,
  organizations: { getById: (id) => organizationService.getById(id) },
  appointmentNotes: appointmentNotesService,
});

export const dashboardsRouter = createDashboardsRouter(dashboardsService);

export { DashboardsService } from './dashboards.service.js';
export { DashboardsController } from './dashboards.controller.js';
export { dashboardsRepository } from './dashboards.repository.js';
