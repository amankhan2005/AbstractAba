import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { enterTenantContext } from '../../middleware/tenantContext.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { ClientsController } from './clients.controller.js';
import {
  createClientSchema,
  updateClientSchema,
  listClientsQuerySchema,
  clientIdParamsSchema,
  intakeWorkflowTransitionSchema,
  updateAssignmentSchema,
  endAssignmentSchema,
  createServiceAuthorizationSchema,
  updateServiceAuthorizationSchema,
  transitionServiceAuthorizationSchema,
  authorizationParamsSchema,
  messageCareTeamSchema,
  parentEmailPreviewSchema,
  parentEmailSendSchema,
  createGuardianSchema,
  updateGuardianSchema,
  guardianParamsSchema,
  createMedicalSchema,
  updateMedicalSchema,
  listMedicalQuerySchema,
  medicalParamsSchema,
  createContactSchema,
  updateContactSchema,
  contactParamsSchema,
  upsertIntakeSchema,
  assignCareTeamSchema,
  coverageIdParamsSchema,
  guardianInviteParamsSchema,
  guardianInvitationParamsSchema,
  createCoverageSchema,
  updateCoverageSchema,
  verifyCoverageSchema,
  careTeamParamsSchema,
} from './clients.schemas.js';

/**
 * Clients module router. Every route is authenticated, bound to the tenant
 * context, and — unlike the Phase-1 users routes, which gated on auth + tenant
 * only — guarded by an explicit permission. As the first PHI-bearing module,
 * clients uses per-permission authorization from day one (an approved Phase-2
 * decision). Reads require clients.read; mutations require the specific write
 * permission; archive requires clients.archive.
 */
export function createClientsRouter(service) {
  const controller = new ClientsController(service);
  const router = Router();
  router.use(authenticate, enterTenantContext);

  // clients
  router.get(
    '/',
    requirePermission('clients.read'),
    validate(listClientsQuerySchema, 'query'),
    asyncHandler(controller.list),
  );
  router.post(
    '/',
    requirePermission('clients.create'),
    validate(createClientSchema, 'body'),
    asyncHandler(controller.create),
  );
  router.get(
    '/summary',
    requirePermission('clients.read'),
    asyncHandler(controller.summary),
  );
  router.get(
    '/attention',
    requirePermission('clients.read'),
    asyncHandler(controller.attentionRoster),
  );
  router.get(
    '/:clientId',
    requirePermission('clients.read'),
    validate(clientIdParamsSchema, 'params'),
    asyncHandler(controller.get),
  );
  router.patch(
    '/:clientId',
    requirePermission('clients.update'),
    validate(clientIdParamsSchema, 'params'),
    validate(updateClientSchema, 'body'),
    asyncHandler(controller.update),
  );
  router.get(
    '/:clientId/alerts',
    requirePermission('clients.read'),
    validate(clientIdParamsSchema, 'params'),
    asyncHandler(controller.childAlerts),
  );
  router.get(
    '/:clientId/email-templates',
    requirePermission('clients.read'),
    validate(clientIdParamsSchema, 'params'),
    asyncHandler(controller.parentEmailTemplates),
  );
  router.post(
    '/:clientId/email-preview',
    requirePermission('clients.read'),
    validate(clientIdParamsSchema, 'params'),
    validate(parentEmailPreviewSchema, 'body'),
    asyncHandler(controller.previewParentEmail),
  );
  router.post(
    '/:clientId/email-send',
    requirePermission('clients.update'),
    validate(clientIdParamsSchema, 'params'),
    validate(parentEmailSendSchema, 'body'),
    asyncHandler(controller.sendParentEmail),
  );
  router.post(
    '/:clientId/message-care-team',
    requirePermission('clients.update'),
    validate(clientIdParamsSchema, 'params'),
    validate(messageCareTeamSchema, 'body'),
    asyncHandler(controller.messageCareTeam),
  );
  router.get(
    '/:clientId/progress',
    requirePermission('clients.read'),
    validate(clientIdParamsSchema, 'params'),
    asyncHandler(controller.childProgress),
  );
  router.post(
    '/:clientId/intake-status',
    requirePermission('clients.update'),
    validate(clientIdParamsSchema, 'params'),
    validate(intakeWorkflowTransitionSchema, 'body'),
    asyncHandler(controller.transitionIntake),
  );

  // --- FBA/ABA service authorizations (Phase 2) ----------------------------
  // Read uses clients.read; create/edit/transition use clients.update. Approval
  // is not a free status set: it flows through the guarded transition endpoint,
  // which only permits SENT -> APPROVED/DENIED, so it cannot be forged.
  router.get(
    '/:clientId/authorizations',
    requirePermission('clients.read'),
    validate(clientIdParamsSchema, 'params'),
    asyncHandler(controller.listAuthorizations),
  );
  router.post(
    '/:clientId/authorizations',
    requirePermission('clients.update'),
    validate(clientIdParamsSchema, 'params'),
    validate(createServiceAuthorizationSchema, 'body'),
    asyncHandler(controller.createAuthorization),
  );
  router.patch(
    '/:clientId/authorizations/:authorizationId',
    requirePermission('clients.update'),
    validate(authorizationParamsSchema, 'params'),
    validate(updateServiceAuthorizationSchema, 'body'),
    asyncHandler(controller.updateAuthorization),
  );
  router.post(
    '/:clientId/authorizations/:authorizationId/transition',
    requirePermission('clients.update'),
    validate(authorizationParamsSchema, 'params'),
    validate(transitionServiceAuthorizationSchema, 'body'),
    asyncHandler(controller.transitionAuthorization),
  );
  router.delete(
    '/:clientId/authorizations/:authorizationId',
    requirePermission('clients.update'),
    validate(authorizationParamsSchema, 'params'),
    asyncHandler(controller.archiveAuthorization),
  );
  router.post(
    '/:clientId/archive',
    requirePermission('clients.archive'),
    validate(clientIdParamsSchema, 'params'),
    asyncHandler(controller.archive),
  );

  // guardians
  router.post(
    '/:clientId/guardians',
    requirePermission('clients.update'),
    validate(clientIdParamsSchema, 'params'),
    validate(createGuardianSchema, 'body'),
    asyncHandler(controller.addGuardian),
  );
  router.patch(
    '/:clientId/guardians/:guardianId',
    requirePermission('clients.update'),
    validate(guardianParamsSchema, 'params'),
    validate(updateGuardianSchema, 'body'),
    asyncHandler(controller.updateGuardian),
  );
  router.delete(
    '/:clientId/guardians/:guardianId',
    requirePermission('clients.update'),
    validate(guardianParamsSchema, 'params'),
    asyncHandler(controller.removeGuardian),
  );

  // medical entries (conditions + history)
  // READ: clients.read — clinicians (BCBA/RBT) read within scope; the response
  // is field-filtered (RBT gets a minimal summary). WRITE: clients.medical.manage
  // — Company/Admin only; a direct POST/PATCH/DELETE from a BCBA/RBT is rejected.
  router.get(
    '/:clientId/medical',
    requirePermission('clients.read'),
    validate(clientIdParamsSchema, 'params'),
    validate(listMedicalQuerySchema, 'query'),
    asyncHandler(controller.listMedical),
  );
  router.post(
    '/:clientId/medical',
    requirePermission('clients.medical.manage'),
    validate(clientIdParamsSchema, 'params'),
    validate(createMedicalSchema, 'body'),
    asyncHandler(controller.addMedical),
  );
  router.patch(
    '/:clientId/medical/:entryId',
    requirePermission('clients.medical.manage'),
    validate(medicalParamsSchema, 'params'),
    validate(updateMedicalSchema, 'body'),
    asyncHandler(controller.updateMedical),
  );
  router.delete(
    '/:clientId/medical/:entryId',
    requirePermission('clients.medical.manage'),
    validate(medicalParamsSchema, 'params'),
    asyncHandler(controller.removeMedical),
  );

  // contacts
  router.post(
    '/:clientId/contacts',
    requirePermission('clients.update'),
    validate(clientIdParamsSchema, 'params'),
    validate(createContactSchema, 'body'),
    asyncHandler(controller.addContact),
  );
  router.patch(
    '/:clientId/contacts/:contactId',
    requirePermission('clients.update'),
    validate(contactParamsSchema, 'params'),
    validate(updateContactSchema, 'body'),
    asyncHandler(controller.updateContact),
  );
  router.delete(
    '/:clientId/contacts/:contactId',
    requirePermission('clients.update'),
    validate(contactParamsSchema, 'params'),
    asyncHandler(controller.removeContact),
  );

  // care team (persistent staff assignment; additive to per-appointment staff)
  router.get(
    '/:clientId/care-team',
    requirePermission('clients.read'),
    validate(clientIdParamsSchema, 'params'),
    asyncHandler(controller.listCareTeam),
  );
  // Care-team MUTATION is Company/Admin-only (blueprint: "Company controls WHO
  // works with the child"). It is deliberately NOT clients.update: a BCBA holds
  // clients.update at TEAM scope to edit clinical fields on their caseload, and
  // must NOT be able to assign/replace/remove the BCBA or RBT via a direct API
  // call. Reads (GET above) stay on clients.read so a BCBA/RBT can still VIEW
  // their assigned care team.
  router.post(
    '/:clientId/care-team',
    requirePermission('clients.care_team.manage'),
    validate(clientIdParamsSchema, 'params'),
    validate(assignCareTeamSchema, 'body'),
    asyncHandler(controller.assignCareTeam),
  );
  router.delete(
    '/:clientId/care-team/:assignmentId',
    requirePermission('clients.care_team.manage'),
    validate(careTeamParamsSchema, 'params'),
    asyncHandler(controller.removeCareTeam),
  );
  router.patch(
    '/:clientId/care-team/:assignmentId',
    requirePermission('clients.care_team.manage'),
    validate(careTeamParamsSchema, 'params'),
    validate(updateAssignmentSchema, 'body'),
    asyncHandler(controller.updateAssignment),
  );
  router.post(
    '/:clientId/care-team/:assignmentId/end',
    requirePermission('clients.care_team.manage'),
    validate(careTeamParamsSchema, 'params'),
    validate(endAssignmentSchema, 'body'),
    asyncHandler(controller.endAssignment),
  );

  // guardian invitations (blueprint 2.6 / 6.2)
  router.get(
    '/:clientId/guardian-invitations',
    requirePermission('clients.read'),
    validate(clientIdParamsSchema, 'params'),
    asyncHandler(controller.listGuardianInvitations),
  );
  router.post(
    '/:clientId/guardians/:guardianId/invitation',
    requirePermission('clients.update'),
    validate(guardianInviteParamsSchema, 'params'),
    asyncHandler(controller.inviteGuardian),
  );
  router.post(
    '/:clientId/guardian-invitations/:invitationId/resend',
    requirePermission('clients.update'),
    validate(guardianInvitationParamsSchema, 'params'),
    asyncHandler(controller.resendGuardianInvitation),
  );
  router.delete(
    '/:clientId/guardian-invitations/:invitationId',
    requirePermission('clients.update'),
    validate(guardianInvitationParamsSchema, 'params'),
    asyncHandler(controller.revokeGuardianInvitation),
  );

  // insurance coverage (blueprint 6.2 / 6.9)
  //
  // Recording coverage is a clients.update act; RECORDING A VERIFICATION is a
  // separate, more privileged one. Verification is the fact the scheduling
  // gate trusts, so the ability to assert it is not handed to everyone who can
  // type a member id. There is no route that accepts `verificationStatus` on
  // create or update — the only path to VERIFIED is through this endpoint,
  // which records who checked and when.
  router.get(
    '/:clientId/insurance',
    requirePermission('clients.read'),
    validate(clientIdParamsSchema, 'params'),
    asyncHandler(controller.listCoverage),
  );
  router.post(
    '/:clientId/insurance',
    requirePermission('clients.update'),
    validate(clientIdParamsSchema, 'params'),
    validate(createCoverageSchema, 'body'),
    asyncHandler(controller.createCoverage),
  );
  router.patch(
    '/:clientId/insurance/:coverageId',
    requirePermission('clients.update'),
    validate(coverageIdParamsSchema, 'params'),
    validate(updateCoverageSchema, 'body'),
    asyncHandler(controller.updateCoverage),
  );
  router.post(
    '/:clientId/insurance/:coverageId/verification',
    requirePermission('clients.verify_insurance'),
    validate(coverageIdParamsSchema, 'params'),
    validate(verifyCoverageSchema, 'body'),
    asyncHandler(controller.verifyCoverage),
  );
  router.delete(
    '/:clientId/insurance/:coverageId',
    requirePermission('clients.update'),
    validate(coverageIdParamsSchema, 'params'),
    asyncHandler(controller.removeCoverage),
  );

  // intake
  router.put(
    '/:clientId/intake',
    requirePermission('clients.update'),
    validate(clientIdParamsSchema, 'params'),
    validate(upsertIntakeSchema, 'body'),
    asyncHandler(controller.upsertIntake),
  );

  return router;
}
