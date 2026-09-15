import { env } from '../../config/env.js';
import { organizationService } from '../organization/index.js';
import { clientsRepository } from '../clients/index.js';
import { staffRepository } from '../staff/index.js';
import { SchedulingService, makeAssignmentGate } from './scheduling.service.js';
import { schedulingRepository } from './scheduling.repository.js';
import { createSchedulingRouter } from './scheduling.routes.js';
import { AppointmentNotesService } from './appointmentNotes.service.js';
import { appointmentNotesRepository } from './appointmentNotes.repository.js';
import { sealPhi, openPhi } from '../../utils/phi.js';

/**
 * Composition root for the scheduling module. The service reads organization
 * state (ACTIVE gate) and cross-module data — clients (bookable status) and
 * staff (eligibility + credentials) — through narrow ports over the existing
 * repositories, so no module reaches into another's internals.
 */
export const schedulingService = new SchedulingService({
  repository: schedulingRepository,
  organizations: { getById: (id) => organizationService.getById(id) },
  clients: { findById: (tenantId, id) => clientsRepository.findClientById(tenantId, id) },
  // Care-team assignments — the new booking pipeline validates that the chosen
  // BCBA and RBT are each an ACTIVE care-team member of the client.
  assignments: { listActiveForClient: (tenantId, clientId) => clientsRepository.listAssignments(tenantId, clientId) },
  staff: {
    findById: (tenantId, id) => staffRepository.findStaffById(tenantId, id),
    listCredentials: (tenantId, id) => staffRepository.listCredentials(tenantId, id),
  },
  assignmentGate: makeAssignmentGate({
    assignments: { listActiveForClient: (tenantId, clientId) => clientsRepository.listAssignments(tenantId, clientId) },
    enabled: env.scheduling.requireCareTeamAssignment,
  }),
});

/**
 * Appointment notes reuse the scheduling repository for the appointment itself
 * (so ownership is resolved from the SAME record the rest of scheduling uses)
 * and the organization port for the business timezone. The note body is sealed
 * with the platform's existing PHI service — no second encryption path.
 */
export const appointmentNotesService = new AppointmentNotesService({
  repository: schedulingRepository,
  notes: appointmentNotesRepository,
  organizations: { getById: (id) => organizationService.getById(id) },
  // Read-only: resolves the note author's display name for the byline.
  staff: { findById: (tenantId, id) => staffRepository.findStaffById(tenantId, id) },
  // Read-only: client display names, and the care-team assignments that decide
  // which clients a BCBA may associate with a note.
  clients: { findById: (tenantId, id) => clientsRepository.findClientById(tenantId, id) },
  assignments: { listActiveForClient: (tenantId, clientId) => clientsRepository.listAssignments(tenantId, clientId) },
  phi: { seal: sealPhi, open: openPhi },
});

export const schedulingRouter = createSchedulingRouter(schedulingService, appointmentNotesService);

export { SchedulingService } from './scheduling.service.js';
export { SchedulingController } from './scheduling.controller.js';
export { schedulingRepository } from './scheduling.repository.js';
export { AppointmentNotesService } from './appointmentNotes.service.js';
