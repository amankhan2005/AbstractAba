import { auditService } from '../modules/audit/audit.service.js';
import { withTenant } from '../tenancy/tenantContext.js';

/**
 * The audit catalogue: which write endpoints are recorded, and under what action.
 * Reads are not audited (Level A records writes). Keyed by METHOD + a path
 * matcher; :params are matched as segments. Ported from the original's
 * catalogue-driven recorder — every protected write registers here.
 */
export const AUDIT_CATALOGUE = [
  { method: 'POST', pattern: '/api/v1/platform/organizations', action: 'organization.created', entityType: 'organization' },
  { method: 'POST', pattern: '/api/v1/platform/organizations/:id/transitions', action: 'organization.transitioned', entityType: 'organization' },
  { method: 'PATCH', pattern: '/api/v1/organization', action: 'organization.profile.updated', entityType: 'organization' },
  { method: 'POST', pattern: '/api/v1/platform/organizations/:id/owner-invitations', action: 'user.owner_invited', entityType: 'membership' },
  { method: 'POST', pattern: '/api/v1/users', action: 'user.invited', entityType: 'membership' },
  { method: 'POST', pattern: '/api/v1/users/invitations/:invitationId/resend', action: 'user.invitation_resent', entityType: 'invitation' },
  { method: 'DELETE', pattern: '/api/v1/users/invitations/:invitationId', action: 'user.invitation_revoked', entityType: 'invitation' },
  { method: 'PATCH', pattern: '/api/v1/users/:membershipId/status', action: 'user.status_changed', entityType: 'membership' },
  { method: 'DELETE', pattern: '/api/v1/users/:membershipId', action: 'user.removed', entityType: 'membership' },
  { method: 'POST', pattern: '/api/v1/users/:membershipId/roles', action: 'user.roles_assigned', entityType: 'membership' },
  { method: 'DELETE', pattern: '/api/v1/users/:membershipId/roles/:roleKey', action: 'user.role_unassigned', entityType: 'membership' },
  { method: 'PUT', pattern: '/api/v1/organization/settings/:namespace', action: 'settings.updated', entityType: 'organization_setting' },
  { method: 'PUT', pattern: '/api/v1/organization/branding', action: 'branding.updated', entityType: 'organization_setting' },
  { method: 'POST', pattern: '/api/v1/platform/organizations/:id/onboarding/provision', action: 'onboarding.provisioned', entityType: 'organization' },
  { method: 'POST', pattern: '/api/v1/platform/organizations/:id/onboarding/activate', action: 'onboarding.activated', entityType: 'organization' },
  { method: 'POST', pattern: '/api/v1/platform/organizations/:id/agreements', action: 'onboarding.agreement_recorded', entityType: 'organization' },
  { method: 'POST', pattern: '/api/v1/platform/organizations/:id/agreements/:agreementId/countersign', action: 'onboarding.agreement_countersigned', entityType: 'organization' },
  { method: 'POST', pattern: '/api/v1/platform/organizations/:id/offboarding', action: 'onboarding.offboarding_begun', entityType: 'organization' },
  { method: 'POST', pattern: '/api/v1/platform/organizations/:id/destruction/approve', action: 'onboarding.destruction_approved', entityType: 'organization' },
  // saved parent-email templates — metadata only (never the template body)
  { method: 'POST', pattern: '/api/v1/email-templates', action: 'email_template.created', entityType: 'email_template' },
  { method: 'PATCH', pattern: '/api/v1/email-templates/:templateId', action: 'email_template.updated', entityType: 'email_template' },
  { method: 'DELETE', pattern: '/api/v1/email-templates/:templateId', action: 'email_template.deleted', entityType: 'email_template' },
  // clients (Phase 2 · clinical spine) — metadata only, never PHI
  { method: 'POST', pattern: '/api/v1/clients', action: 'client.created', entityType: 'client' },
  { method: 'PATCH', pattern: '/api/v1/clients/:clientId', action: 'client.updated', entityType: 'client' },
  { method: 'POST', pattern: '/api/v1/clients/:clientId/archive', action: 'client.archived', entityType: 'client' },
  { method: 'POST', pattern: '/api/v1/clients/:clientId/guardians', action: 'client.guardian_added', entityType: 'client' },
  { method: 'PATCH', pattern: '/api/v1/clients/:clientId/guardians/:guardianId', action: 'client.guardian_updated', entityType: 'client' },
  { method: 'DELETE', pattern: '/api/v1/clients/:clientId/guardians/:guardianId', action: 'client.guardian_removed', entityType: 'client' },
  { method: 'POST', pattern: '/api/v1/clients/:clientId/contacts', action: 'client.contact_added', entityType: 'client' },
  { method: 'PATCH', pattern: '/api/v1/clients/:clientId/contacts/:contactId', action: 'client.contact_updated', entityType: 'client' },
  { method: 'DELETE', pattern: '/api/v1/clients/:clientId/contacts/:contactId', action: 'client.contact_removed', entityType: 'client' },
  { method: 'PUT', pattern: '/api/v1/clients/:clientId/intake', action: 'client.intake_upserted', entityType: 'client' },
  // staff & credentials (Phase 2 · clinical spine) — metadata only
  { method: 'POST', pattern: '/api/v1/staff', action: 'staff.created', entityType: 'staff' },
  { method: 'PATCH', pattern: '/api/v1/staff/:staffId', action: 'staff.updated', entityType: 'staff' },
  { method: 'POST', pattern: '/api/v1/staff/:staffId/deactivate', action: 'staff.deactivated', entityType: 'staff' },
  { method: 'POST', pattern: '/api/v1/staff/:staffId/credentials', action: 'staff.credential_added', entityType: 'staff' },
  { method: 'PATCH', pattern: '/api/v1/staff/:staffId/credentials/:credentialId', action: 'staff.credential_updated', entityType: 'staff' },
  { method: 'DELETE', pattern: '/api/v1/staff/:staffId/credentials/:credentialId', action: 'staff.credential_removed', entityType: 'staff' },
  { method: 'POST', pattern: '/api/v1/staff/:staffId/supervisees', action: 'staff.supervisee_assigned', entityType: 'staff' },
  { method: 'DELETE', pattern: '/api/v1/staff/:staffId/supervisees/:superviseeStaffId', action: 'staff.supervision_ended', entityType: 'staff' },
  // scheduling & calendar (Phase 2 · clinical spine) — metadata only
  { method: 'POST', pattern: '/api/v1/scheduling/appointments', action: 'scheduling.appointment_booked', entityType: 'appointment' },
  { method: 'PATCH', pattern: '/api/v1/scheduling/appointments/:appointmentId', action: 'scheduling.appointment_updated', entityType: 'appointment' },
  { method: 'POST', pattern: '/api/v1/scheduling/appointments/:appointmentId/cancel', action: 'scheduling.appointment_cancelled', entityType: 'appointment' },
  { method: 'PUT', pattern: '/api/v1/scheduling/staff/:staffId/availability', action: 'scheduling.availability_replaced', entityType: 'staff' },
  { method: 'POST', pattern: '/api/v1/scheduling/authorizations', action: 'scheduling.authorization_created', entityType: 'authorization' },
  { method: 'PATCH', pattern: '/api/v1/scheduling/authorizations/:authorizationId', action: 'scheduling.authorization_updated', entityType: 'authorization' },
  // clinical plans, goals, programs & targets (Phase 2) — metadata only
  { method: 'POST', pattern: '/api/v1/plans', action: 'treatment_plan.created', entityType: 'treatment_plan' },
  { method: 'PATCH', pattern: '/api/v1/plans/:planId', action: 'treatment_plan.updated', entityType: 'treatment_plan' },
  { method: 'POST', pattern: '/api/v1/plans/:planId/archive', action: 'treatment_plan.archived', entityType: 'treatment_plan' },
  { method: 'POST', pattern: '/api/v1/plans/:planId/goals', action: 'goal.created', entityType: 'treatment_plan' },
  { method: 'PATCH', pattern: '/api/v1/plans/:planId/goals/:goalId', action: 'goal.updated', entityType: 'treatment_plan' },
  { method: 'POST', pattern: '/api/v1/plans/:planId/goals/:goalId/archive', action: 'goal.archived', entityType: 'treatment_plan' },
  { method: 'POST', pattern: '/api/v1/plans/:planId/goals/:goalId/programs', action: 'program.created', entityType: 'treatment_plan' },
  { method: 'PATCH', pattern: '/api/v1/plans/:planId/programs/:programId', action: 'program.updated', entityType: 'treatment_plan' },
  { method: 'POST', pattern: '/api/v1/plans/:planId/programs/:programId/archive', action: 'program.archived', entityType: 'treatment_plan' },
  { method: 'POST', pattern: '/api/v1/plans/:planId/programs/:programId/targets', action: 'target.created', entityType: 'treatment_plan' },
  { method: 'PATCH', pattern: '/api/v1/plans/:planId/programs/:programId/targets/:targetId', action: 'target.updated', entityType: 'treatment_plan' },
  { method: 'POST', pattern: '/api/v1/plans/:planId/programs/:programId/targets/:targetId/archive', action: 'target.archived', entityType: 'treatment_plan' },
  // session capture & freeze (Phase 2 · clinical spine) — metadata only, never PHI
  { method: 'POST', pattern: '/api/v1/sessions', action: 'session.created', entityType: 'session' },
  { method: 'PATCH', pattern: '/api/v1/sessions/:sessionId', action: 'session.updated', entityType: 'session' },
  { method: 'POST', pattern: '/api/v1/sessions/:sessionId/freeze', action: 'session.frozen', entityType: 'session' },
  { method: 'POST', pattern: '/api/v1/sessions/:sessionId/data-points', action: 'session.data_point_added', entityType: 'session' },
  { method: 'PATCH', pattern: '/api/v1/sessions/:sessionId/data-points/:dataPointId', action: 'session.data_point_updated', entityType: 'session' },
  { method: 'DELETE', pattern: '/api/v1/sessions/:sessionId/data-points/:dataPointId', action: 'session.data_point_removed', entityType: 'session' },
  // clinical documents (Phase 2 · clinical spine) — metadata only, never PHI
  { method: 'POST', pattern: '/api/v1/documents', action: 'document.created', entityType: 'clinical_document' },
  { method: 'PATCH', pattern: '/api/v1/documents/:documentId', action: 'document.updated', entityType: 'clinical_document' },
  { method: 'POST', pattern: '/api/v1/documents/:documentId/finalize', action: 'document.finalized', entityType: 'clinical_document' },
  { method: 'POST', pattern: '/api/v1/documents/:documentId/archive', action: 'document.archived', entityType: 'clinical_document' },
  { method: 'POST', pattern: '/api/v1/documents/:documentId/supersede', action: 'document.superseded', entityType: 'clinical_document' },
];

function matchRoute(method, path) {
  for (const entry of AUDIT_CATALOGUE) {
    if (entry.method !== method) continue;
    const p = entry.pattern.split('/');
    const a = path.split('?')[0].split('/');
    if (p.length !== a.length) continue;
    let ok = true;
    for (let i = 0; i < p.length; i += 1) {
      if (p[i].startsWith(':')) continue;
      if (p[i] !== a[i]) { ok = false; break; }
    }
    if (ok) return entry;
  }
  return null;
}

/**
 * App-level middleware that records a catalogued write to the append-only,
 * hash-chained audit log on a successful (2xx) response. It reads the principal
 * and tenant at response-finish time (after the router set them), records
 * metadata only (never PHI), and never blocks or fails the request. This is the
 * automatic recorder that replaces per-controller audit calls.
 */
export function auditRecorder() {
  return (req, res, next) => {
    res.on('finish', () => {
      try {
        if (res.statusCode < 200 || res.statusCode >= 300) return;
        const entry = matchRoute(req.method, req.originalUrl || req.url);
        if (!entry) return;
        const principal = req.principal;
        if (!principal) return;
        const tenantId = principal.activeTenantId ?? req.params?.id ?? null;
        if (!tenantId) return; // platform-only actions without a tenant chain are skipped
        // The audited entity for clinical writes is the client the write hangs
        // off of; guardian/contact ids identify the sub-resource but the record
        // stays anchored to the client. Falls back to the existing id params.
        const entityId =
          req.params?.clientId ?? req.params?.staffId ?? req.params?.appointmentId ?? req.params?.authorizationId ?? req.params?.planId ?? req.params?.sessionId ?? req.params?.documentId ?? req.params?.id ?? req.params?.membershipId ?? req.params?.invitationId ?? req.params?.templateId ?? tenantId;
        // Fire-and-forget: auditing must never break the request it records.
        void withTenant(tenantId, () =>
          auditService.record({
            tenantId,
            actorId: principal.userId,
            action: entry.action,
            entityType: entry.entityType,
            entityId,
            outcome: 'success',
            payload: { method: req.method, path: req.originalUrl || req.url },
          }),
        ).catch(() => {});
      } catch {
        // never throw from a finish handler
      }
    });
    next();
  };
}
