import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';

/**
 * An APPOINTMENT NOTE: planning/context a BCBA writes from the Schedule against
 * ONE scheduled appointment on ONE business date.
 *
 * WHY THIS IS ITS OWN COLLECTION, AND NOT A FIELD ON THE APPOINTMENT
 * -----------------------------------------------------------------
 * A multi-day appointment (09/12 → 09/14) is a SINGLE Appointment document
 * covering three business dates. A note stored on the appointment would
 * therefore be one global note, and the 09/13 note would silently overwrite the
 * 09/12 one. The business requirement is date-specific, so the note is keyed on
 * (appointment, serviceDate) — which the existing appointment architecture
 * already expresses as the date range, so no duplicate appointment records are
 * invented to carry notes.
 *
 * `serviceDate` is the ORGANIZATION-timezone civil date as a 'YYYY-MM-DD'
 * string, not an instant. A note belongs to a day on the clinic's calendar, and
 * storing a string removes any possibility of the UTC drift that the business
 * date work exists to prevent — there is no instant here to re-interpret.
 *
 * SEPARATE FROM EVERY OTHER NOTE IN THE PRODUCT. An Appointment Note is not a
 * Session Memo (written during a session), not Session Documentation (BCBA
 * clinical record), and not an Authorization Memo (billing workflow). Nothing
 * copies between them.
 *
 * The body is stored SEALED, like every other clinician-authored free text in
 * the platform, and opened only for an authorised reader.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    appointmentId: { type: String, required: true, index: true },
    /** Organization-timezone civil date, 'YYYY-MM-DD'. */
    serviceDate: { type: String, required: true },
    /** The authoring clinician's StaffProfile id. */
    authorStaffProfileId: { type: String, required: true },
    /**
     * OPTIONAL client the BCBA marked this note as relating to. Not part of the
     * note's identity — the unique key stays (tenant, appointment, serviceDate)
     * — so selecting or clearing a client never creates a second note or moves
     * a note to another date. Null when no client was selected.
     */
    clientId: { type: String, default: null },
    /** Sealed note text. */
    body: { type: String, default: null },
    /**
     * Earlier content preserved when a note row is taken over by the CURRENT
     * business date's note — i.e. a note that had been filed for this date on a
     * DIFFERENT day by the retired per-date picker. Nothing historical is
     * silently discarded; it is simply no longer the current note.
     */
    supersededVersions: {
      type: [{
        _id: false,
        body: { type: String, default: null },
        clientId: { type: String, default: null },
        authorStaffProfileId: { type: String, default: null },
        updatedAt: { type: Date, default: null },
        supersededAt: { type: Date, default: null },
      }],
      default: [],
    },
  },
  { timestamps: true, versionKey: false, collection: 'appointmentNote' },
);

schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });

// ONE note per appointment per business date: a save is an upsert, so repeated
// saves update in place instead of accumulating duplicate notes.
schema.index({ tenantId: 1, appointmentId: 1, serviceDate: 1 }, { unique: true });
schema.index({ tenantId: 1, appointmentId: 1 });
// Company Admin overview: notes within a business-date range.
schema.index({ tenantId: 1, serviceDate: 1 });

export const AppointmentNote = mongoose.models.AppointmentNote
  || mongoose.model('AppointmentNote', schema);

export default AppointmentNote;
