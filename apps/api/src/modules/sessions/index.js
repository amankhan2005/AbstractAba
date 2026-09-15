import { sealPhi, openPhi } from '../../utils/phi.js';
import { organizationService } from '../organization/index.js';
import { schedulingRepository } from '../scheduling/index.js';
import { resolveAuthorizations } from '../scheduling/authorizationDisplay.js';
import { plansRepository } from '../plans/index.js';
import { clientsRepository } from '../clients/index.js';
import { staffRepository } from '../staff/staff.repository.js';
import { bcbaSessionRepository } from '../bcba-session/bcbaSession.repository.js';
import { SessionsService } from './sessions.service.js';
import { sessionsRepository } from './sessions.repository.js';
import { createSessionsRouter } from './sessions.routes.js';

/**
 * Composition root for the session-capture module. The service reads
 * organization state (ACTIVE gate) and validates cross-module references —
 * the appointment (via scheduling), the treatment plan and the data-point
 * targets (via plans) — through narrow ports over the existing repositories, so
 * no module reaches into another's internals. PHI (the clinical narrative) is
 * sealed and opened through the shared seam.
 */
export const sessionsService = new SessionsService({
  repository: sessionsRepository,
  organizations: { getById: (id) => organizationService.getById(id) },
  appointments: {
    findById: (tenantId, id) => schedulingRepository.findAppointmentById(tenantId, id),
    findManyByIds: (tenantId, ids) => schedulingRepository.findAppointmentsByIds(tenantId, ids),
  },
  plans: {
    findPlanById: (tenantId, id) => plansRepository.findPlanById(tenantId, id),
    findTargetById: (tenantId, id) => plansRepository.findTargetById(tenantId, id),
  },
  // Read-only ports for the user-facing Session Detail context (child name/age,
  // authorization label, per-session payroll). They reuse the existing client
  // repository, the shared authorization display resolver, and the BCBA session
  // time-record (payroll receipt) — no duplicate systems.
  clients: {
    findById: (tenantId, id) => clientsRepository.findClientById(tenantId, id),
    findNamesByIds: (tenantId, ids) => clientsRepository.findClientNamesByIds(tenantId, ids),
  },
  staff: {
    findById: (tenantId, id) => staffRepository.findStaffById(tenantId, id),
    findNamesByIds: (tenantId, ids) => staffRepository.findStaffNamesByIds(tenantId, ids),
  },
  authorizations: { resolveMany: (tenantId, ids) => resolveAuthorizations(tenantId, ids) },
  // The child's active care team (existing ClientAssignment records): used to
  // name the assigned RBT for a BCBA when the session's own appointment has no
  // RBT (appointments carry one clinician each).
  careTeam: {
    activeRbtIds: (tenantId, clientId) => clientsRepository.findActiveRbtStaffIds(tenantId, clientId),
  },
  timeRecords: {
    findBySession: (tenantId, sessionId) => bcbaSessionRepository.findBySession(tenantId, sessionId),
    findBySessions: (tenantId, sessionIds) => bcbaSessionRepository.findBySessions(tenantId, sessionIds),
  },
  phi: { seal: sealPhi, open: openPhi },
});

export const sessionsRouter = createSessionsRouter(sessionsService);

export { SessionsService } from './sessions.service.js';
export { SessionsController } from './sessions.controller.js';
export { sessionsRepository } from './sessions.repository.js';
