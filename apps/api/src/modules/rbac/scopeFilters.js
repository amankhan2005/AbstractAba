/**
 * ---------------------------------------------------------------------------
 * SCOPE FILTERS — applying a resolved data scope to a Mongo filter.
 *
 * `dataScope.js` answers "what may this principal reach?". This module answers
 * "how do I say that in a query?". Keeping the two apart means a repository
 * never reasons about roles, and the scope rules live in exactly one place.
 *
 * THE CONTRACT, and the reason it is written as one function rather than
 * inlined at each call site:
 *
 *   clientIds === null   → tenant-wide. Add nothing. The tenant plugin is
 *                          still the boundary.
 *   clientIds === []     → reachable set is EMPTY. This MUST produce zero rows.
 *   clientIds === [...]  → narrow to those ids.
 *
 * The empty case is the one that goes wrong. `if (ids.length) filter.x = ...`
 * reads naturally and is exactly backwards: a technician with no assignments
 * would fall through to an unfiltered query and receive the entire clinic. The
 * helpers below treat "empty" and "unrestricted" as different states, because
 * conflating them is the single most likely way to reintroduce the defect.
 *
 * A caller-supplied filter on the same field is INTERSECTED, never replaced —
 * `?clientId=X` from a technician not assigned to X must return nothing rather
 * than overriding the scope.
 * ---------------------------------------------------------------------------
 */

/** Is this scope unrestricted (tenant-wide) for the given dimension? */
function unrestricted(ids) {
  return ids === null || ids === undefined;
}

/**
 * Intersects an existing equality/`$in` constraint with the permitted set.
 * Returns a Mongo condition, or the sentinel `IMPOSSIBLE` when the intersection
 * is empty.
 */
const IMPOSSIBLE = Object.freeze({ $in: [] });

function intersect(existing, permitted) {
  if (existing === undefined) return { $in: permitted };
  if (typeof existing === 'string') {
    return permitted.includes(existing) ? existing : IMPOSSIBLE;
  }
  if (existing && Array.isArray(existing.$in)) {
    const both = existing.$in.filter((v) => permitted.includes(v));
    return both.length ? { $in: both } : IMPOSSIBLE;
  }
  // An unrecognised operator shape: fail closed rather than guess.
  return IMPOSSIBLE;
}

/**
 * Narrows `filter[field]` to the clients the principal may reach.
 * Mutates and returns the filter for convenient chaining.
 *
 * @param {object} filter    the Mongo filter under construction
 * @param {object} dataScope from requirePermission
 * @param {string} field     the field naming the client (default 'clientId')
 */
export function scopeToClients(filter, dataScope, field = 'clientId') {
  if (!dataScope) {
    // No scope resolved at all is a programming error — a route that forgot
    // requirePermission. Fail closed rather than serve the tenant.
    filter[field] = IMPOSSIBLE;
    return filter;
  }
  if (unrestricted(dataScope.clientIds)) return filter;
  filter[field] = intersect(filter[field], dataScope.clientIds);
  return filter;
}

/**
 * Narrows `filter[field]` to the staff the principal may reach (themselves,
 * plus their supervisees for a TEAM scope).
 */
export function scopeToStaff(filter, dataScope, field = 'staffProfileId') {
  if (!dataScope) {
    filter[field] = IMPOSSIBLE;
    return filter;
  }
  if (unrestricted(dataScope.staffIds)) return filter;
  filter[field] = intersect(filter[field], dataScope.staffIds);
  return filter;
}

/**
 * Narrows to records the principal may reach through EITHER dimension — used
 * where a record is reachable because it concerns one of your clients OR
 * because you delivered it.
 *
 * A BCBA reviewing a session needs both halves: sessions for clients on their
 * caseload, and sessions delivered by a supervisee. Applying only one would
 * hide legitimate work rather than protect anything.
 */
export function scopeToClientsOrStaff(filter, dataScope, {
  clientField = 'clientId',
  staffField = 'staffProfileId',
} = {}) {
  if (!dataScope) {
    filter[clientField] = IMPOSSIBLE;
    return filter;
  }
  if (unrestricted(dataScope.clientIds) && unrestricted(dataScope.staffIds)) return filter;

  const alternatives = [];
  if (!unrestricted(dataScope.clientIds)) {
    alternatives.push({ [clientField]: { $in: dataScope.clientIds } });
  }
  if (!unrestricted(dataScope.staffIds)) {
    alternatives.push({ [staffField]: { $in: dataScope.staffIds } });
  }

  // Combine under $and so an existing caller filter on the same field is
  // preserved rather than clobbered by a top-level $or.
  const existingAnd = Array.isArray(filter.$and) ? filter.$and : [];
  filter.$and = [...existingAnd, { $or: alternatives }];
  return filter;
}

/**
 * Narrows an APPOINTMENT filter to the ones the authenticated clinician is
 * PERSONALLY ASSIGNED to — as the BCBA (bcbaId) or the RBT (rbtId). This is the
 * scope for calendars and appointment lists (spec §6/§7): a clinician's schedule
 * is defined by their own assignment, never by the client's caseload or by the
 * mirrored delivering `staffProfileId`, so one clinician never sees another's
 * schedule.
 *
 *   BCBA-1 + RBT-1 appointment → visible to BCBA-1 (bcbaId) AND RBT-1 (rbtId)
 *   BCBA-1 only                → BCBA-1 yes, RBT-1 no
 *   RBT-1 only                 → RBT-1 yes, BCBA-1 no
 *   another clinician's        → neither sees it
 *
 * Tenant-wide principals (Owner / Org-Admin / Scheduler — both clientIds and
 * staffIds unrestricted) see the whole clinic and are NOT narrowed. A restricted
 * principal with no resolvable staff profile matches nothing (fail closed).
 * A caller filter is intersected under $and, never clobbered.
 */
export function scopeToAssignedClinician(filter, dataScope) {
  if (!dataScope) {
    filter._id = IMPOSSIBLE;
    return filter;
  }
  // Tenant-wide (admin/scheduler): no clinician narrowing.
  if (unrestricted(dataScope.clientIds) && unrestricted(dataScope.staffIds)) return filter;
  const me = dataScope.staffProfileId;
  if (!me) { // restricted but no resolvable clinician identity → nothing
    filter._id = IMPOSSIBLE;
    return filter;
  }
  const condition = { $or: [{ bcbaId: me }, { rbtId: me }] };
  const existingAnd = Array.isArray(filter.$and) ? filter.$and : [];
  filter.$and = [...existingAnd, condition];
  return filter;
}

/** True when the scope permits nothing at all — useful for short-circuiting. */
export function scopeIsEmpty(dataScope) {
  if (!dataScope) return true;
  if (unrestricted(dataScope.clientIds)) return false;
  return dataScope.clientIds.length === 0
    && (unrestricted(dataScope.staffIds) ? false : dataScope.staffIds.length === 0);
}

export { IMPOSSIBLE };

/**
 * Session reads.
 *   SELF (RBT)   only the sessions they delivered — never the BCBA's session
 *                (record, memo, documentation) for the same client.
 *   TEAM (BCBA)  their own sessions + the RBT sessions on children they lead.
 *   wider        the standard client-or-staff rule (tenant-wide roles).
 * Fails closed: a missing staff identity matches nothing of anyone else's.
 */
export function scopeSessionsFilter(filter, dataScope, { staffField = 'staffProfileId', clientField = 'clientId' } = {}) {
  const existingAnd = Array.isArray(filter.$and) ? filter.$and : [];
  if (dataScope?.scope === 'SELF') {
    const own = Array.isArray(dataScope.staffIds) && dataScope.staffIds.length ? dataScope.staffIds : null;
    filter.$and = [...existingAnd, { [staffField]: own ? { $in: own } : IMPOSSIBLE }];
    return filter;
  }
  // TEAM (the BCBA): their own sessions + RBT sessions on the children they lead
  // (dataScope.sessionReviewPairs, resolved from care-team assignments by
  // withSessionReviewScope). Without resolved pairs it fails closed to own only.
  if (dataScope?.scope === 'TEAM') {
    const alternatives = [{ [staffField]: dataScope.staffProfileId ? dataScope.staffProfileId : IMPOSSIBLE }];
    for (const p of dataScope.sessionReviewPairs ?? []) {
      alternatives.push({ [clientField]: p.clientId, [staffField]: { $in: p.staffIds } });
    }
    filter.$and = [...existingAnd, { $or: alternatives }];
    return filter;
  }
  return scopeToClientsOrStaff(filter, dataScope);
}
