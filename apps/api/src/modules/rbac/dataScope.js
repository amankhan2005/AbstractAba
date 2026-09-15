import { StaffProfile, ClientAssignment, SupervisionLink } from '../../models/index.js';

/**
 * ---------------------------------------------------------------------------
 * DATA SCOPE RESOLUTION — the missing half of RBAC.
 *
 * Blueprint §4.1: "Every permission carries a data scope: none, own (records
 * assigned to the acting user), or tenant (all records in the clinic). This is
 * how a BCBA and an Admin can both 'read clients' yet see different sets."
 *
 * Before this module the platform enforced only the LEFT half of that sentence:
 * `requirePermission('clients.read')` proved the key was held and then ran an
 * unfiltered tenant-wide query. Tenant isolation was sound (tenantPlugin), so
 * Company A never saw Company B — but inside a tenant every role saw
 * everything. An RBT calling GET /v1/clients received the full roster.
 *
 * This module resolves, for one principal in one request:
 *
 *   staffProfileId  — who the acting user IS as a clinician (never taken from
 *                     a query parameter; always derived from the token subject)
 *   clientIds       — the set of client records the principal may touch, or
 *                     `null` meaning "tenant-wide, no filter"
 *   staffIds        — the set of staff records in scope (self + supervisees)
 *
 * SCOPE SEMANTICS (blueprint §4.11 / §11.4)
 *   ORGANIZATION → clientIds = null   (tenant-wide; the tenantPlugin still binds)
 *   TEAM         → clients where the principal OR one of their supervisees
 *                  holds a care-team assignment (a BCBA's caseload)
 *   SELF         → clients where the principal personally holds a care-team
 *                  assignment (an RBT's assigned children)
 *
 * FAIL CLOSED. A principal that holds a non-ORGANIZATION scope but has no staff
 * profile resolves to an EMPTY set, never to `null`. "We could not work out who
 * you are" must read as "you may see nothing", never as "you may see all".
 *
 * Must run inside withTenant() — every model here carries the tenant plugin.
 * ---------------------------------------------------------------------------
 */

/** Care-team roles that confer a *supervising clinical* relationship to a client. */
const CLINICAL_LEAD_ROLES = ['BCBA', 'MANAGER'];

/**
 * The staff profile belonging to the authenticated user, or null when the user
 * is an administrative account with no clinician record.
 *
 * @param {string} userId
 * @returns {Promise<string | null>}
 */
export async function resolveStaffProfileId(userId) {
  if (!userId) return null;
  const row = await StaffProfile.findOne({ userId, deletedAt: null }).select({ _id: 1 }).lean();
  return row?._id ?? null;
}

/** Active supervisee staff ids for a supervisor (blueprint §4.12: supervision is a relationship). */
export async function resolveSuperviseeIds(supervisorStaffId) {
  if (!supervisorStaffId) return [];
  const rows = await SupervisionLink.find({
    supervisorStaffId,
    active: true,
    deletedAt: null,
  })
    .select({ superviseeStaffId: 1 })
    .lean();
  return rows.map((r) => r.superviseeStaffId);
}

/** Client ids on which any of `staffIds` holds a live care-team assignment. */
export async function resolveAssignedClientIds(staffIds, { roles = null } = {}) {
  if (!staffIds || staffIds.length === 0) return [];
  const filter = { staffProfileId: { $in: staffIds }, deletedAt: null };
  if (roles) filter.role = { $in: roles };
  const rows = await ClientAssignment.find(filter).select({ clientId: 1 }).lean();
  return [...new Set(rows.map((r) => r.clientId))];
}

/**
 * Resolve the full data scope for a principal at a given permission scope.
 *
 * @param {{ userId: string }} principal
 * @param {'ORGANIZATION'|'TEAM'|'SELF'|'PLATFORM'} scope
 * @returns {Promise<{ scope: string, staffProfileId: string|null, clientIds: string[]|null, staffIds: string[]|null }>}
 */
export async function resolveDataScope(principal, scope) {
  const staffProfileId = await resolveStaffProfileId(principal?.userId);

  // Tenant-wide: no additional filter. The tenant plugin remains the boundary.
  if (scope === 'ORGANIZATION' || scope === 'PLATFORM') {
    return { scope, staffProfileId, clientIds: null, staffIds: null };
  }

  // Below here every branch is a narrowing one. No staff profile ⇒ empty set.
  if (!staffProfileId) {
    return { scope, staffProfileId: null, clientIds: [], staffIds: [] };
  }

  if (scope === 'TEAM') {
    const superviseeIds = await resolveSuperviseeIds(staffProfileId);
    const staffIds = [staffProfileId, ...superviseeIds];
    // A BCBA's caseload: clients they lead clinically, plus clients their
    // supervised technicians deliver to (they are accountable for those too).
    const clientIds = await resolveAssignedClientIds(staffIds);
    return { scope, staffProfileId, clientIds, staffIds };
  }

  // SELF — only what this person is personally assigned to.
  const clientIds = await resolveAssignedClientIds([staffProfileId]);
  return { scope, staffProfileId, clientIds, staffIds: [staffProfileId] };
}

/**
 * Is `clientId` inside the resolved scope? Used by every detail read/write so a
 * direct-by-id request cannot bypass the list filter — the exact attack the
 * blueprint's isolation suite models ("RBT A requesting Client B by id").
 */
export function scopeAllowsClient(dataScope, clientId) {
  if (!dataScope) return false;
  if (dataScope.clientIds === null) return true; // tenant-wide
  return dataScope.clientIds.includes(clientId);
}

/** Is `staffProfileId` inside the resolved scope (self, or a supervisee)? */
export function scopeAllowsStaff(dataScope, staffProfileId) {
  if (!dataScope) return false;
  if (dataScope.staffIds === null) return true;
  return dataScope.staffIds.includes(staffProfileId);
}

/**
 * SESSION REVIEW RELATIONSHIPS for a clinical lead (the BCBA, TEAM scope).
 *
 * A BCBA may read their own sessions and the RBT sessions for the children they
 * are assigned to — never another clinician's session on a child they are not
 * assigned to, and never another lead's session. Both halves come from
 * persisted care-team assignments (never from the request):
 *
 *   the BCBA holds an ACTIVE lead assignment (BCBA / MANAGER) on the child, and
 *   the session's clinician holds an RBT assignment on that same child.
 *
 * Returns [{ clientId, staffIds }] — for each child the BCBA leads, the RBT
 * staff whose sessions on that child they may review. Must run inside
 * withTenant() (the tenant plugin binds every query).
 */
export async function resolveSessionReviewPairs(staffProfileId) {
  if (!staffProfileId) return [];
  const lead = await ClientAssignment.find({ staffProfileId, role: { $in: CLINICAL_LEAD_ROLES }, status: 'ACTIVE', deletedAt: null })
    .select({ clientId: 1 }).lean();
  const clientIds = [...new Set(lead.map((r) => r.clientId))];
  if (!clientIds.length) return [];
  const rbts = await ClientAssignment.find({ clientId: { $in: clientIds }, role: 'RBT', deletedAt: null })
    .select({ clientId: 1, staffProfileId: 1 }).lean();
  const byClient = new Map(clientIds.map((id) => [id, new Set()]));
  for (const r of rbts) if (r.staffProfileId !== staffProfileId) byClient.get(r.clientId)?.add(r.staffProfileId);
  return [...byClient].filter(([, ids]) => ids.size).map(([clientId, ids]) => ({ clientId, staffIds: [...ids] }));
}

/** Attach the session review relationships to a TEAM data scope (other scopes are returned unchanged). */
export async function withSessionReviewScope(dataScope) {
  if (dataScope?.scope !== 'TEAM' || dataScope.sessionReviewPairs) return dataScope;
  return { ...dataScope, sessionReviewPairs: await resolveSessionReviewPairs(dataScope.staffProfileId) };
}

/**
 * May this data scope open this session record ({ clientId, staffProfileId })?
 *   SELF (RBT)   only their own session.
 *   TEAM (BCBA)  their own session, or an RBT session on a child they lead.
 *   wider        unchanged (the standard scope guard decides).
 */
export function sessionVisibleToScope(dataScope, record) {
  if (!dataScope || !record) return false;
  if (dataScope.scope === 'SELF') return Boolean(dataScope.staffProfileId) && record.staffProfileId === dataScope.staffProfileId;
  if (dataScope.scope === 'TEAM') {
    if (dataScope.staffProfileId && record.staffProfileId === dataScope.staffProfileId) return true;
    return (dataScope.sessionReviewPairs ?? []).some((p) => p.clientId === record.clientId && p.staffIds.includes(record.staffProfileId));
  }
  return true;
}

export { CLINICAL_LEAD_ROLES };
