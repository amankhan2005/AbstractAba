import { schedulingError } from './scheduling.errors.js';
import { civilDateString, parseCivilDate } from '../../domain/businessDate.js';

/**
 * ---------------------------------------------------------------------------
 * APPOINTMENT NOTES — the BCBA's note for an appointment on the CURRENT
 * business date.
 *
 * CURRENT-DATE ONLY. A note's date is ALWAYS today's business date in the
 * organization timezone, resolved here on the server clock. It is never taken
 * from the appointment: a 09/12 → 09/30 appointment has no bearing on which
 * date a note is for. On 09/13 the only note that exists for that appointment
 * is the 09/13 note; the 09/12 note is not "today's" note and nothing is ever
 * created for 09/14+ in advance. A client-supplied date that isn't today is
 * refused (NOTE_DATE_NOT_CURRENT) so a stale screen across midnight can't write
 * to yesterday.
 *
 * Identity stays the collection's unique key (tenant, appointment,
 * serviceDate), with serviceDate = the current business date.
 *
 * CLIENT IS THE NOTE'S OWN, OPTIONAL FIELD. It is null unless the BCBA
 * explicitly selected a client; the appointment's client is never copied into
 * the note, never returned as the note's client, and never shown as one.
 *
 * ACCESS MODEL, enforced HERE rather than by hiding UI:
 *   BCBA assigned to the appointment   create / read / update / delete
 *   Company Admin / org-wide scope     read
 *   RBT                                NO ACCESS (403, not an empty result)
 *
 * Kept separate from the Session Memo, Session Documentation and the
 * Authorization Memo; nothing is copied between them.
 * ---------------------------------------------------------------------------
 */
export class AppointmentNotesService {
  constructor(deps) {
    this.deps = deps;
  }

  now() {
    return this.deps.clock?.now ? this.deps.clock.now() : new Date();
  }

  /**
   * Resolve the appointment and decide what this caller may do with its note.
   * Returns { appointment, canWrite, timeZone }.
   */
  async _authorize({ tenantId, appointmentId, actorRole, actorStaffProfileId, scope }) {
    const appointment = await this.deps.repository.findAppointmentById(tenantId, appointmentId);
    if (!appointment) throw schedulingError('APPOINTMENT_NOT_FOUND');

    // An RBT never reaches appointment notes, even on an appointment they are
    // assigned to. Checked FIRST so no later branch can accidentally grant it.
    if (actorRole === 'RBT') throw schedulingError('APPOINTMENT_NOTE_FORBIDDEN');

    const isAssignedBcba = Boolean(
      actorStaffProfileId && appointment.bcbaId && appointment.bcbaId === actorStaffProfileId,
    );
    const isOrgWide = scope === 'ORGANIZATION';
    if (!isAssignedBcba && !isOrgWide) throw schedulingError('APPOINTMENT_NOTE_FORBIDDEN');

    const org = await this.deps.organizations.getById(tenantId);
    return { appointment, canWrite: isAssignedBcba, timeZone: org?.timezone || 'UTC' };
  }

  /** Today's business date ('YYYY-MM-DD') in the org timezone, from the server clock. */
  _today(timeZone) {
    return civilDateString(this.now(), timeZone);
  }

  /**
   * The note date is the current business date — full stop. A supplied date is
   * accepted only when it IS today (a harmless echo from the client); anything
   * else is refused rather than silently redirected.
   */
  _currentDate(serviceDate, timeZone) {
    const today = this._today(timeZone);
    if (serviceDate === undefined || serviceDate === null) return today;
    if (!parseCivilDate(serviceDate)) throw schedulingError('INVALID_SERVICE_DATE');
    if (serviceDate !== today) throw schedulingError('NOTE_DATE_NOT_CURRENT');
    return today;
  }

  /**
   * Whether a stored row is a real current-day note: it has content, and it
   * was last written ON its own business date. A row filed for today from an
   * earlier day (the retired per-date picker could write 09/20's note on 09/13)
   * is not today's note and is never presented as one.
   */
  _isCurrentNote(note, timeZone) {
    if (!note || note.deletedAt || note.body == null) return false;
    const written = note.updatedAt ?? note.createdAt;
    return written ? civilDateString(written, timeZone) === note.serviceDate : true;
  }

  /** Client display name (preferred name first), or null when it can't be resolved. */
  async _clientName(tenantId, clientId) {
    if (!clientId || !this.deps.clients?.findById) return null;
    try {
      const c = await this.deps.clients.findById(tenantId, clientId);
      if (!c) return null;
      const name = (c.preferredName && String(c.preferredName).trim())
        || [c.firstName, c.lastName].filter((x) => x && String(x).trim()).join(' ').trim();
      return name || null;
    } catch {
      return null;
    }
  }

  /** The tenant's StaffProfile, or null when it can't be resolved. */
  async _staff(tenantId, staffProfileId) {
    if (!staffProfileId || !this.deps.staff?.findById) return null;
    try {
      return (await this.deps.staff.findById(tenantId, staffProfileId)) ?? null;
    } catch {
      return null;
    }
  }

  /** Staff display name ("First Last"), or null when it can't be resolved. */
  async _staffName(tenantId, staffProfileId) {
    const sp = await this._staff(tenantId, staffProfileId);
    if (!sp) return null;
    const name = [sp.firstName, sp.lastName].filter((x) => x && String(x).trim()).join(' ').trim();
    return name || null;
  }

  /**
   * The note AUTHOR's persisted first name, as stored (display casing is the
   * client's canonical formatter's job — stored data is never rewritten here).
   */
  async _staffFirstName(tenantId, staffProfileId) {
    const sp = await this._staff(tenantId, staffProfileId);
    const first = sp?.firstName != null ? String(sp.firstName).trim() : '';
    return first || null;
  }

  /**
   * The note's selected client must be a real client in this tenant AND either
   * the appointment's client or one the BCBA holds an ACTIVE care-team
   * assignment for. Only runs when the BCBA actually selected a client.
   */
  async _assertSelectableClient(tenantId, appointment, clientId, actorStaffProfileId) {
    if (clientId == null) return;
    const client = this.deps.clients?.findById ? await this.deps.clients.findById(tenantId, clientId) : null;
    if (!client) throw schedulingError('NOTE_CLIENT_NOT_ALLOWED');
    if (clientId === appointment.clientId) return;
    const assignments = this.deps.assignments?.listActiveForClient
      ? await this.deps.assignments.listActiveForClient(tenantId, clientId)
      : [];
    const assigned = (assignments ?? []).some(
      (a) => a.staffProfileId === actorStaffProfileId && (a.status ?? 'ACTIVE') === 'ACTIVE',
    );
    if (!assigned) throw schedulingError('NOTE_CLIENT_NOT_ALLOWED');
  }

  /**
   * The response for the current-day note. Only the note's own data: its text,
   * its selected client (null when none was selected) and its author. When no
   * current-day note exists, `exists:false` and every note field is null.
   */
  async _present({ tenantId, appointmentId, businessDate, note, canWrite }) {
    if (!note) {
      return {
        appointmentId, businessDate, serviceDate: businessDate, exists: false,
        id: null, note: null, clientId: null, clientName: null,
        authorStaffProfileId: null, authorName: null, authorFirstName: null, updatedAt: null, canEdit: canWrite,
      };
    }
    return {
      appointmentId,
      businessDate,
      serviceDate: businessDate,
      exists: true,
      id: note.id,
      note: this.deps.phi.open(note.body),
      clientId: note.clientId ?? null,
      clientName: await this._clientName(tenantId, note.clientId),
      authorStaffProfileId: note.authorStaffProfileId ?? null,
      authorName: await this._staffName(tenantId, note.authorStaffProfileId),
      authorFirstName: await this._staffFirstName(tenantId, note.authorStaffProfileId),
      updatedAt: note.updatedAt ?? null,
      canEdit: canWrite,
    };
  }

  /** The live row for today and whether it is a real current-day note. */
  async _loadToday(tenantId, appointmentId, businessDate, timeZone) {
    const row = await this.deps.notes.findByAppointmentAndDate(tenantId, appointmentId, businessDate);
    return { row, current: this._isCurrentNote(row, timeZone) ? row : null };
  }

  /** GET — the current business date's note for this appointment (or exists:false). */
  async getNote({ tenantId, appointmentId, serviceDate, actorRole, actorStaffProfileId, scope }) {
    const { canWrite, timeZone } = await this._authorize({ tenantId, appointmentId, actorRole, actorStaffProfileId, scope });
    const businessDate = this._currentDate(serviceDate, timeZone);
    const { current } = await this._loadToday(tenantId, appointmentId, businessDate, timeZone);
    return this._present({ tenantId, appointmentId, businessDate, note: current, canWrite });
  }

  /**
   * GET …/notes — the appointment's notes as far as this screen is concerned:
   * only the current business date's note (zero or one). Other dates are
   * history, not notes to show or edit.
   */
  async listForAppointment({ tenantId, appointmentId, actorRole, actorStaffProfileId, scope }) {
    const { canWrite, timeZone } = await this._authorize({ tenantId, appointmentId, actorRole, actorStaffProfileId, scope });
    const businessDate = this._today(timeZone);
    const { current } = await this._loadToday(tenantId, appointmentId, businessDate, timeZone);
    return {
      appointmentId,
      businessDate,
      notes: current ? [await this._present({ tenantId, appointmentId, businessDate, note: current, canWrite })] : [],
      canEdit: canWrite,
    };
  }

  /**
   * PUT — create or update the CURRENT business date's note.
   *
   *   note      required, non-empty (use DELETE to remove a note)
   *   clientId  create: the selected client, or null when none was selected;
   *             update: omitted = unchanged, null = cleared, id = selected.
   *             Never defaulted from the appointment.
   */
  async saveNote({ tenantId, actorUserId, appointmentId, serviceDate, note, clientId, actorRole, actorStaffProfileId, scope }) {
    const { appointment, canWrite, timeZone } = await this._authorize({ tenantId, appointmentId, actorRole, actorStaffProfileId, scope });
    if (!canWrite) throw schedulingError('APPOINTMENT_NOTE_FORBIDDEN');
    const businessDate = this._currentDate(serviceDate, timeZone);

    const text = typeof note === 'string' ? note.trim() : '';
    if (!text) throw schedulingError('NOTE_REQUIRED');
    await this._assertSelectableClient(tenantId, appointment, clientId, actorStaffProfileId);

    const { row, current } = await this._loadToday(tenantId, appointmentId, businessDate, timeZone);
    let saved;
    if (current) {
      saved = await this.deps.notes.update(tenantId, {
        appointmentId, serviceDate: businessDate, body: this.deps.phi.seal(text), updatedBy: actorUserId,
        ...(clientId !== undefined ? { clientId } : {}),
      });
    } else {
      saved = await this.deps.notes.create(tenantId, {
        appointmentId,
        serviceDate: businessDate,
        authorStaffProfileId: actorStaffProfileId,
        clientId: clientId ?? null,
        body: this.deps.phi.seal(text),
        updatedBy: actorUserId,
        // A live row that is NOT a current-day note (filed for today on an
        // earlier day) is preserved in supersededVersions, never discarded.
        supersede: row && row.body != null
          ? { body: row.body, clientId: row.clientId ?? null, authorStaffProfileId: row.authorStaffProfileId ?? null, updatedAt: row.updatedAt ?? null }
          : null,
      });
    }
    return this._present({ tenantId, appointmentId, businessDate, note: saved, canWrite });
  }

  /** DELETE — remove the CURRENT business date's note. Touches nothing else. */
  async deleteNote({ tenantId, actorUserId, appointmentId, serviceDate, actorRole, actorStaffProfileId, scope }) {
    const { canWrite, timeZone } = await this._authorize({ tenantId, appointmentId, actorRole, actorStaffProfileId, scope });
    if (!canWrite) throw schedulingError('APPOINTMENT_NOTE_FORBIDDEN');
    const businessDate = this._currentDate(serviceDate, timeZone);
    const { current } = await this._loadToday(tenantId, appointmentId, businessDate, timeZone);
    if (!current) throw schedulingError('APPOINTMENT_NOTE_NOT_FOUND');
    await this.deps.notes.softDelete(tenantId, { appointmentId, serviceDate: businessDate, deletedBy: actorUserId });
    return { appointmentId, businessDate, deleted: true };
  }

  /**
   * OVERVIEW — the Company Admin appointment panel: the CURRENT business date's
   * notes. Each row carries the appointment's information (BCBA, client, RBT —
   * normal appointment data, labelled as such) and, separately, the client the
   * BCBA selected on the note, if any. Rows carry no note text; a row is opened
   * through getNote, which applies the same access check to the body.
   *
   * Access: org-wide scope sees every note; a BCBA sees notes on appointments
   * they are the assigned BCBA for; an RBT is refused outright.
   */
  async listNotesOverview({ tenantId, actorRole, actorStaffProfileId, scope }) {
    if (actorRole === 'RBT') throw schedulingError('APPOINTMENT_NOTE_FORBIDDEN');
    const isOrgWide = scope === 'ORGANIZATION';
    if (!isOrgWide && !actorStaffProfileId) throw schedulingError('APPOINTMENT_NOTE_FORBIDDEN');

    const org = await this.deps.organizations.getById(tenantId);
    const timeZone = org?.timezone || 'UTC';
    const businessDate = this._today(timeZone);
    const notes = await this.deps.notes.listForBusinessDate(tenantId, businessDate);

    const cache = new Map();
    const cached = async (key, load) => {
      if (!key) return null;
      if (!cache.has(key)) cache.set(key, await load());
      return cache.get(key);
    };

    const items = [];
    for (const n of notes) {
      if (!this._isCurrentNote(n, timeZone)) continue;
      const appt = await cached(`a:${n.appointmentId}`, () => this.deps.repository.findAppointmentById(tenantId, n.appointmentId));
      if (!appt) continue;
      if (!isOrgWide && appt.bcbaId !== actorStaffProfileId) continue;
      items.push({
        id: n.id,
        appointmentId: n.appointmentId,
        businessDate,
        // The note's AUTHOR — from the persisted note, never the appointment.
        // This is what the "<First> has added notes" entry is built from.
        authorStaffProfileId: n.authorStaffProfileId ?? null,
        // 'BCBA' when the author is the appointment's assigned BCBA (the only
        // role the note write path accepts); null for anything else.
        authorRole: n.authorStaffProfileId && n.authorStaffProfileId === appt.bcbaId ? 'BCBA' : null,
        authorFirstName: await cached(`f:${n.authorStaffProfileId}`, () => this._staffFirstName(tenantId, n.authorStaffProfileId)),
        updatedAt: n.updatedAt ?? null,
        // Appointment information (normal appointment data).
        bcbaName: await cached(`s:${appt.bcbaId}`, () => this._staffName(tenantId, appt.bcbaId)),
        rbtName: await cached(`s:${appt.rbtId}`, () => this._staffName(tenantId, appt.rbtId)),
        appointmentClientName: await cached(`c:${appt.clientId}`, () => this._clientName(tenantId, appt.clientId)),
        status: appt.status ?? null,
        // The note's OWN client — only when the BCBA selected one.
        noteClientId: n.clientId ?? null,
        noteClientName: n.clientId ? await cached(`c:${n.clientId}`, () => this._clientName(tenantId, n.clientId)) : null,
      });
    }
    return { businessDate, items };
  }
}

export default AppointmentNotesService;
