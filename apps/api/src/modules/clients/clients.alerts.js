/**
 * Operational alerts engine (Phase 6). PURE and side-effect-free: it takes an
 * already-assembled snapshot of a child's real state (intake, authorizations,
 * care team, capacity) and returns the alerts that state implies. No hardcoded
 * counts, no fabricated conditions — every alert is derived from a real field.
 * The service assembles the snapshot from existing records and calls this; the
 * same function backs any screen that needs the child's attention items, so the
 * business rules live in exactly one place.
 *
 * Each alert: { code, severity ('CRITICAL'|'WARNING'|'INFO'), message, action }.
 * `action` names the Child Detail tab the UI should deep-link to — never a dead
 * card.
 */

/** Days before an authorization's end date at which it counts as expiring soon. */
export const AUTH_EXPIRY_WARNING_DAYS = 30;

/**
 * A VALID parent (spec Module 2 Part 9) is a guardian with a name AND a mobile
 * number AND an email. The one rule behind activation, the insurance and
 * authorization prerequisites and the "Parent/guardian details" completion item.
 */
export function isValidParent(g) {
  if (!g) return false;
  const has = (v) => typeof v === 'string' && v.trim().length > 0;
  return has(g.firstName) && has(g.lastName) && has(g.phone) && has(g.email);
}

/**
 * The same valid-parent rule expressed as a Guardian query (non-deleted,
 * non-blank first name, last name, phone and email), for server-side counting
 * and filtering. Must stay equivalent to isValidParent (see its tests).
 */
export const VALID_PARENT_GUARDIAN_QUERY = Object.freeze({
  deletedAt: null,
  firstName: { $regex: /\S/ },
  lastName: { $regex: /\S/ },
  phone: { $regex: /\S/ },
  email: { $regex: /\S/ },
});

/** Client ACCOUNT status — separate from the referral/intake stage (Client.status). */
export const CLIENT_ACCOUNT_STATUS = ['ACTIVE', 'HOLD', 'DISCHARGED'];

/**
 * ACCOUNT status of a client, derived from real records (never stored):
 *   DISCHARGED  the client was discharged (Client.status DISCHARGED)
 *   HOLD        an admin placed the client on hold (Client.status ON_HOLD), or
 *               there is no valid parent/guardian — the prerequisite the server
 *               enforces for activation, insurance and authorizations
 *   ACTIVE      otherwise
 * The referral stage (REFERRED / INTAKE) is never an account status.
 */
export function deriveAccountStatus({ status, hasValidParent }) {
  if (status === 'DISCHARGED') return 'DISCHARGED';
  if (status === 'ON_HOLD' || !hasValidParent) return 'HOLD';
  return 'ACTIVE';
}

/**
 * Expiry state of one authorization at `now`: 'EXPIRED' once its end date has
 * passed, 'EXPIRING' within AUTH_EXPIRY_WARNING_DAYS, otherwise null. A DENIED
 * (unusable) authorization or one without an end date never expires here.
 */
export function authorizationExpiry(auth, now = new Date()) {
  if (!auth || auth.status === 'DENIED' || !auth.endDate) return { state: null, daysLeft: null };
  const end = new Date(auth.endDate);
  if (Number.isNaN(end.getTime())) return { state: null, daysLeft: null };
  const daysLeft = Math.ceil((end.getTime() - new Date(now).getTime()) / 86400000);
  if (daysLeft < 0) return { state: 'EXPIRED', daysLeft };
  if (daysLeft <= AUTH_EXPIRY_WARNING_DAYS) return { state: 'EXPIRING', daysLeft };
  return { state: null, daysLeft };
}

/** The alert codes that mean a client's REQUIRED onboarding is incomplete. */
export const CLIENT_COMPLETION_CODES = ['PARENT_DETAILS_REQUIRED', 'INTAKE_INCOMPLETE'];

/**
 * Required-onboarding items still open for a client — the SAME rules the client
 * workflow enforces:
 *   INTAKE_INCOMPLETE         the intake pipeline (Client detail → Overview) is
 *                             not COMPLETE;
 *   PARENT_DETAILS_REQUIRED   no valid parent/guardian (gates activation,
 *                             insurance and authorizations). Evaluated only when
 *                             `guardians` is supplied.
 */
export function clientCompletionAlerts({ intakeWorkflowStatus = 'NOT_SENT', guardians } = {}) {
  const alerts = [];
  if (Array.isArray(guardians) && !guardians.some(isValidParent)) {
    alerts.push({
      code: 'PARENT_DETAILS_REQUIRED',
      severity: 'WARNING',
      message: guardians.length === 0 ? 'Parent/guardian details missing' : 'Parent/guardian details incomplete',
      action: 'guardian',
    });
  }
  if ((intakeWorkflowStatus ?? 'NOT_SENT') !== 'COMPLETE') {
    alerts.push({
      code: 'INTAKE_INCOMPLETE',
      severity: intakeWorkflowStatus === 'MISSING_DOCUMENTS' ? 'CRITICAL' : 'WARNING',
      message: intakeWorkflowStatus === 'MISSING_DOCUMENTS'
        ? 'Intake is missing documents.'
        : 'Intake is not yet complete.',
      action: 'overview',
    });
  }
  return alerts;
}

/**
 * @param {object} state
 * @param {string} state.intakeWorkflowStatus
 * @param {number|null} state.approvedWeeklyHours
 * @param {number} state.assignedWeeklyHours   sum of ACTIVE assignment hours
 * @param {Array}  state.careTeam              [{ role, status }]
 * @param {Array}  state.serviceAuthorizations [{ serviceType, status, endDate }]
 * @param {Array}  [state.guardians]          when supplied, the parent rule is checked
 * @param {Date}   [state.now]                 injectable clock for tests
 */
/** The most recently added authorization of a type (a child may hold several). */
export function latestAuthorization(serviceAuthorizations = [], type) {
  const ofType = serviceAuthorizations.filter((a) => a.serviceType === type && !a.deletedAt);
  if (ofType.length === 0) return null;
  const time = (a) => (a.createdAt ? new Date(a.createdAt).getTime() : NaN);
  if (ofType.every((a) => Number.isFinite(time(a)))) return ofType.reduce((best, a) => (time(a) > time(best) ? a : best));
  return ofType[ofType.length - 1];
}

export function computeChildAlerts(state = {}) {
  const alerts = [];
  const now = state.now ? new Date(state.now) : new Date();
  const {
    intakeWorkflowStatus = 'NOT_SENT',
    approvedWeeklyHours = null,
    assignedWeeklyHours = 0,
    careTeam = [],
    serviceAuthorizations = [],
  } = state;

  // Required onboarding (intake pipeline, valid parent)
  alerts.push(...clientCompletionAlerts({ intakeWorkflowStatus, guardians: state.guardians }));

  // FBA / ABA authorization state
  for (const type of ['FBA', 'ABA']) {
    const auth = latestAuthorization(serviceAuthorizations, type);
    // Saving and the payer workflow are separate: an ADDED authorization is saved
    // (and usable) whatever its status, so "none on file" and "saved, not yet sent"
    // are different alerts — a saved record must never read as missing.
    if (!auth) {
      alerts.push({ code: `${type}_MISSING`, severity: 'WARNING', message: `No ${type} authorization on file.`, action: 'authorizations' });
    } else if (auth.status === 'NOT_SENT') {
      alerts.push({ code: `${type}_PENDING`, severity: 'INFO', message: `${type} authorization is saved and has not been sent to the payer yet.`, action: 'authorizations' });
    } else if (auth.status === 'SENT') {
      alerts.push({ code: `${type}_AWAITING`, severity: 'INFO', message: `${type} authorization is awaiting a decision.`, action: 'authorizations' });
    } else if (auth.status === 'DENIED') {
      alerts.push({ code: `${type}_DENIED`, severity: 'CRITICAL', message: `${type} authorization was denied.`, action: 'authorizations' });
    }
    // Expiry applies to every usable authorization (anything not DENIED): an
    // authorization is usable as soon as it is added, approved or not.
    const { state: expiry, daysLeft } = authorizationExpiry(auth, now);
    if (expiry === 'EXPIRED') {
      alerts.push({ code: `${type}_EXPIRED`, severity: 'CRITICAL', message: `${type} authorization has expired.`, action: 'authorizations' });
    } else if (expiry === 'EXPIRING') {
      alerts.push({ code: `${type}_EXPIRING`, severity: 'WARNING', message: `${type} authorization expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`, action: 'authorizations' });
    }
  }

  // Care-team coverage
  const activeTeam = careTeam.filter((m) => (m.status ?? 'ACTIVE') === 'ACTIVE');
  if (activeTeam.length === 0) {
    alerts.push({ code: 'ASSIGNMENT_MISSING', severity: 'WARNING', message: 'No active care-team members are assigned.', action: 'careteam' });
  } else {
    if (!activeTeam.some((m) => m.role === 'BCBA')) {
      alerts.push({ code: 'BCBA_MISSING', severity: 'WARNING', message: 'No BCBA is assigned to this child.', action: 'careteam' });
    }
    if (!activeTeam.some((m) => m.role === 'RBT')) {
      alerts.push({ code: 'RBT_MISSING', severity: 'INFO', message: 'No RBT is assigned to this child.', action: 'careteam' });
    }
  }

  // Weekly capacity nearing / at limit
  if (approvedWeeklyHours != null && approvedWeeklyHours > 0) {
    const ratio = assignedWeeklyHours / approvedWeeklyHours;
    if (assignedWeeklyHours > approvedWeeklyHours) {
      alerts.push({ code: 'CAPACITY_EXCEEDED', severity: 'CRITICAL', message: `Assigned hours (${assignedWeeklyHours}) exceed approved (${approvedWeeklyHours}).`, action: 'careteam' });
    } else if (ratio >= 0.9) {
      alerts.push({ code: 'CAPACITY_NEARING', severity: 'INFO', message: `Assigned hours are near the approved weekly limit (${assignedWeeklyHours}/${approvedWeeklyHours}).`, action: 'careteam' });
    }
  }

  return alerts;
}

/** Highest severity present, for a compact badge. */
export function alertsSummary(alerts = []) {
  const order = { CRITICAL: 3, WARNING: 2, INFO: 1 };
  let top = null;
  for (const a of alerts) if (!top || order[a.severity] > order[top]) top = a.severity;
  return { total: alerts.length, severity: top };
}
