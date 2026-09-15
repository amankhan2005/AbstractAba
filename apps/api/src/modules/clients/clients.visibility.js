/**
 * Role-based FIELD-LEVEL visibility for client serialization.
 *
 * Blueprint (role model): Company MANAGES the child, BCBA PLANS clinical work,
 * RBT EXECUTES it — and "the returned data must enforce this same model." The
 * spec is explicit that sensitive fields must be stripped on the SERVER, never
 * fetched to the browser and hidden in React (Parts 8/10/11/27/29):
 *   - Compensation (hourlyPayRate, rateHistory) → payroll-authorized roles only.
 *   - Guardian PRIVATE CONTACT (email/phone/address) → Company/front-desk only.
 *   - RBT child view is intentionally MINIMAL: no guardians, no extra contacts.
 *
 * The discriminator is the caller's already-resolved permission scope + payroll
 * capability, so this stays consistent with the RBAC layer instead of inventing
 * a parallel role check:
 *   ORGANIZATION scope  → Company / front-desk  (full)
 *   TEAM scope          → BCBA                    (clinical: guardian contact hidden)
 *   SELF scope          → RBT                     (minimal: guardians/contacts removed)
 *
 * A `null`/absent viewer means "no restriction" so internal callers and the
 * existing service unit tests keep full visibility; the controller always passes
 * a real viewer, so the wire response is always enforced.
 */

/**
 * @param {{ scope?: string, canSeeCompensation?: boolean }} [viewer]
 * @returns {{ scope: string, canSeeCompensation: boolean, canSeeGuardianContact: boolean, canSeeGuardians: boolean }}
 */
export function resolveViewer(viewer) {
  const scope = viewer?.scope ?? 'ORGANIZATION';
  const isOrg = scope === 'ORGANIZATION';
  const isTeam = scope === 'TEAM';
  return {
    scope,
    // Compensation is gated on an explicit payroll capability, not scope: a
    // BCBA holds clients.update but must never receive pay rates (Part 11).
    canSeeCompensation: viewer ? Boolean(viewer.canSeeCompensation) : true,
    // Guardian private contact: Company / front-desk only.
    canSeeGuardianContact: viewer ? isOrg : true,
    // Guardians appear at all for Company (full) and BCBA (contact-redacted);
    // the RBT (SELF) child view carries no guardians at all.
    canSeeGuardians: viewer ? isOrg || isTeam : true,
  };
}

/** Strip compensation from a single care-team assignment unless authorized. */
export function redactAssignment(assignment, v) {
  if (!assignment || v.canSeeCompensation) return assignment;
  const { hourlyPayRate, rateHistory, ...rest } = assignment;
  return rest;
}

/** Strip compensation across a care-team roster. */
export function redactCareTeam(assignments, v) {
  if (!Array.isArray(assignments) || v.canSeeCompensation) return assignments;
  return assignments.map((a) => redactAssignment(a, v));
}

/** Strip a guardian's private contact channels unless authorized. */
export function redactGuardian(guardian, v) {
  if (!guardian || v.canSeeGuardianContact) return guardian;
  const { email, phone, address, notes, ...rest } = guardian;
  return rest; // keep name, relationship, isPrimary as clinical context
}

/** Apply guardian rules across a list (removed entirely for the RBT view). */
export function redactGuardians(guardians, v) {
  if (!Array.isArray(guardians)) return guardians;
  if (!v.canSeeGuardians) return [];
  if (v.canSeeGuardianContact) return guardians;
  return guardians.map((g) => redactGuardian(g, v));
}

/**
 * RBT medical visibility: NO medical history at all, and only a minimal
 * conditions summary (label + status) for safe care. Company + BCBA read full
 * medical (conditions AND history). Blueprint: "RBT MUST NOT see Medical History."
 */
export function redactMedical(entries, v) {
  if (!Array.isArray(entries)) return entries;
  if (v.canSeeGuardians) return entries; // Company (full) + BCBA (clinical read)
  // SELF scope (RBT): drop history entirely; conditions reduced to essentials.
  return entries
    .filter((m) => m.type === 'CONDITION')
    .map((m) => ({ id: m.id, type: m.type, label: m.label, status: m.status }));
}

/**
 * Apply the full field-level policy to a getClient detail object. Returns a new
 * object; never mutates the input. Unknown/extra keys pass through untouched.
 */
export function applyClientDetailVisibility(detail, viewer) {
  if (!detail) return detail;
  const v = resolveViewer(viewer);
  const out = { ...detail };
  if ('careTeam' in out) out.careTeam = redactCareTeam(out.careTeam, v);
  if ('guardians' in out) out.guardians = redactGuardians(out.guardians, v);
  if ('medical' in out) out.medical = redactMedical(out.medical, v);
  // The RBT (SELF) child view is minimal — drop non-clinical rosters entirely
  // rather than shipping them to be hidden client-side.
  if (!v.canSeeGuardians && 'contacts' in out) out.contacts = [];
  return out;
}
