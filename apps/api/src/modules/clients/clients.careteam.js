/**
 * Pure care-team resolution (no I/O), mirroring clients.alerts.js.
 *
 * The CURRENT care team for a child is the single ACTIVE BCBA and the single
 * ACTIVE RBT assigned to them. ENDED/historical assignments are never current.
 * MANAGER/THERAPIST roles are not part of the BCBA/RBT summary. If the same role
 * somehow has more than one ACTIVE row, the first (stable-ordered) wins — the
 * one-BCBA/one-RBT rule is enforced at write time, this is a defensive read.
 *
 * `staffName(staffProfileId)` resolves a display name; a missing staff record
 * yields null for that member (never undefined), so callers render a safe
 * "Not assigned" state.
 */
export function currentCareTeam(assignments, staffName) {
  const team = { bcba: null, rbt: null };
  for (const a of assignments ?? []) {
    if ((a.status ?? 'ACTIVE') !== 'ACTIVE') continue;
    const slot = a.role === 'BCBA' ? 'bcba' : a.role === 'RBT' ? 'rbt' : null;
    if (!slot || team[slot]) continue;
    const name = staffName(a.staffProfileId);
    team[slot] = name ? { staffProfileId: a.staffProfileId, name } : null;
  }
  return team;
}

/**
 * Group current care teams for many children in one pass.
 * `assignments` is a flat list carrying `clientId`; returns a Map<clientId, team>.
 * Every requested id gets an entry (defaulting to {bcba:null, rbt:null}).
 */
export function currentCareTeamByClient(clientIds, assignments, staffName) {
  const byClient = new Map(clientIds.map((id) => [id, []]));
  for (const a of assignments ?? []) {
    const list = byClient.get(a.clientId);
    if (list) list.push(a);
  }
  const out = new Map();
  for (const id of clientIds) out.set(id, currentCareTeam(byClient.get(id) ?? [], staffName));
  return out;
}
