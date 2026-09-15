/**
 * In-memory stand-in for appointmentNotes.repository with the SAME semantics
 * the service relies on:
 *   - one row per (tenant, appointment, serviceDate) — the unique key, INCLUDING
 *     soft-deleted rows (so create takes a deleted/non-current row over);
 *   - create() writes author/client/body explicitly and can push a superseded
 *     version; update() only touches a live row and only writes clientId when
 *     sent; softDelete() stamps deletedAt;
 *   - createdAt/updatedAt stamped from the injected clock, like Mongoose
 *     timestamps would be at write time.
 */
export function makeNotesStore(clock) {
  const rows = new Map();
  let seq = 0;
  const key = (t, a, d) => `${t}|${a}|${d}`;
  const now = () => new Date(clock.now());
  const clone = (r) => (r ? JSON.parse(JSON.stringify(r), (k, v) => (['createdAt', 'updatedAt', 'deletedAt', 'supersededAt'].includes(k) && v ? new Date(v) : v)) : null);
  return {
    rows,
    raw: (t, a, d) => rows.get(key(t, a, d)),
    async listByAppointment(t, a) { return [...rows.values()].filter((r) => r.tenantId === t && r.appointmentId === a && !r.deletedAt).map(clone); },
    async findByAppointmentAndDate(t, a, d) { const r = rows.get(key(t, a, d)); return r && !r.deletedAt ? clone(r) : null; },
    async listForBusinessDate(t, d) { return [...rows.values()].filter((r) => r.tenantId === t && r.serviceDate === d && r.body != null && !r.deletedAt).map(clone); },
    async create(t, { appointmentId, serviceDate, authorStaffProfileId, clientId = null, body, updatedBy, supersede = null }) {
      const k = key(t, appointmentId, serviceDate);
      const existing = rows.get(k);
      const row = existing
        ? { ...existing, authorStaffProfileId, clientId, body, updatedBy, deletedAt: null, deletedBy: null, updatedAt: now(),
          supersededVersions: [...(existing.supersededVersions ?? []), ...(supersede ? [{ ...supersede, supersededAt: now() }] : [])] }
        : { id: `note_${++seq}`, tenantId: t, appointmentId, serviceDate, authorStaffProfileId, clientId, body, updatedBy,
          deletedAt: null, deletedBy: null, createdAt: now(), updatedAt: now(), supersededVersions: [] };
      rows.set(k, row);
      return clone(row);
    },
    async update(t, { appointmentId, serviceDate, body, updatedBy, clientId }) {
      const r = rows.get(key(t, appointmentId, serviceDate));
      if (!r || r.deletedAt) return null;
      Object.assign(r, { body, updatedBy, updatedAt: now(), ...(clientId !== undefined ? { clientId } : {}) });
      return clone(r);
    },
    async softDelete(t, { appointmentId, serviceDate, deletedBy }) {
      const r = rows.get(key(t, appointmentId, serviceDate));
      if (!r || r.deletedAt) return null;
      Object.assign(r, { deletedAt: now(), deletedBy, updatedBy: deletedBy, updatedAt: now() });
      return clone(r);
    },
    /** Test-only: plant a row as the RETIRED per-date picker would have written it. */
    plant(row) { rows.set(key(row.tenantId, row.appointmentId, row.serviceDate), { deletedAt: null, supersededVersions: [], ...row }); },
  };
}
