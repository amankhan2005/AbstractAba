import { formatDate } from '@/lib/format';

/**
 * Build the appointment-booking payload the REBUILT backend contract requires.
 *
 * POST /v1/scheduling/appointments now accepts the simple, explicit shape:
 *   - clientId
 *   - bcbaId, rbtId            (separate care-team roles — spec §2/§3)
 *   - authorizationIds[]       (one or more ABA/FBA authorizations — spec §4)
 *   - startDate, endDate       (YYYY-MM-DD; DateInput already emits this)
 *   - startTime[, endTime]     (HH:MM; endTime optional — derived from units)
 *   - units                    (positive integer — spec §8)
 *
 * The server composes the start/end instants and does all authoritative
 * validation; this helper only assembles the fields the contract needs and
 * never invents tenant/company identity.
 */
export function buildBookingPayload({ clientId, bcbaId, rbtId, authorizationIds, startDate, endDate, startTime, endTime, units }) {
  const u = Math.max(1, Number(units) || 1);
  return {
    clientId,
    // Exactly one clinician per appointment (spec §4). Only the chosen id is
    // sent; the other key is omitted entirely so the optional-UUID schema is
    // never handed an empty string.
    ...(bcbaId ? { bcbaId } : {}),
    ...(rbtId ? { rbtId } : {}),
    authorizationIds: Array.from(authorizationIds || []),
    startDate,
    endDate: endDate || startDate,
    // Times are optional and omitted entirely when not provided. The creation UI
    // no longer collects a clock time (spec §2): a timeless booking is DATE-ONLY
    // and the server records timeSet:false. Worked time comes from the session.
    ...(startTime ? { startTime } : {}),
    ...(endTime ? { endTime } : {}),
    units: u,
  };
}

/** Fields required before a booking can be submitted (drives inline validation). */
export function missingBookingFields({ clientId, bcbaId, rbtId, authorizationIds, startDate, startTime }) {
  const missing = [];
  if (!clientId) missing.push('child');
  // Exactly one clinician per appointment (spec §4/§17). The UI sends only the
  // selected type's id, so at most one of these is ever set; here we only need
  // to confirm a clinician was chosen at all.
  if (!bcbaId && !rbtId) missing.push('clinician');
  if (!authorizationIds || authorizationIds.length === 0) missing.push('authorization');
  if (!startDate) missing.push('date');
  // startTime is optional (spec §2): the appointment carries a scheduling DATE;
  // actual worked time comes from each clinician's own session, never here.
  return missing;
}

export default buildBookingPayload;

// Units are 15-minute units → hours = units × 0.25. Kept tidy for display.
function unitsToHours(units) {
  if (units == null || !Number.isFinite(Number(units))) return null;
  return Math.round((Number(units) * 0.25) * 100) / 100;
}

/**
 * A concise, safe label for an authorization row. Shows the auth number,
 * service, validity window (MM/DD/YYYY), status, and remaining/total units.
 * Missing pieces are omitted — never "undefined"/"null"/"NaN".
 */
export function authorizationLabel(a = {}) {
  const num = a.authorizationNumber || (a.id ? `#${String(a.id).slice(0, 8)}` : 'Authorization');
  const parts = [num];
  if (a.serviceCode) parts.push(a.serviceCode);
  const start = formatDate(a.startDate);
  const end = formatDate(a.endDate);
  if (start || end) parts.push(`${start || '—'}–${end || '—'}`);
  if (a.remainingUnits != null && a.authorizedUnits != null) parts.push(`${a.remainingUnits}/${a.authorizedUnits}u left`);
  if (a.status) parts.push(a.status);
  return parts.join(' · ');
}

/**
 * Full, labelled breakdown for the details panel shown under the selector once
 * an authorization is chosen. Every value is display-ready (dates MM/DD/YYYY,
 * hours derived from units); absent data reads "Not available".
 */
export function authorizationDetails(a = {}) {
  const na = 'Not available';
  const totalHours = unitsToHours(a.authorizedUnits);
  const remainingHours = unitsToHours(a.remainingUnits);
  return [
    ['Authorization #', a.authorizationNumber || na],
    ['Service / ABA type', a.serviceCode || na],
    ['Start date', formatDate(a.startDate) || na],
    ['End date', formatDate(a.endDate) || na],
    ['Status', a.status || na],
    ['Total units', a.authorizedUnits != null ? String(a.authorizedUnits) : na],
    ['Remaining units', a.remainingUnits != null ? String(a.remainingUnits) : na],
    ['Total hours', totalHours != null ? `${totalHours} hrs` : na],
    ['Remaining hours', remainingHours != null ? `${remainingHours} hrs` : na],
  ];
}
