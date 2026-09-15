import { AppError } from '../../common/errors/AppError.js';

/**
 * Error catalogue for the BCBA session workflow. Codes are stable (logs, the
 * web client); the default messages are plain language a clinician can act on
 * (blueprint: "never surface an enum to a user").
 */
const STATUS = {
  ORG_NOT_ACTIVE: 409,
  APPOINTMENT_NOT_FOUND: 404,
  NOT_YOUR_APPOINTMENT: 403,
  APPOINTMENT_NOT_STARTABLE: 409,
  APPOINTMENT_NOT_TODAY: 409,
  DOCUMENTATION_NOT_PERMITTED: 403,
  NOT_ASSIGNED_TO_CHILD: 403,
  NO_ACTIVE_PLAN: 409,
  SESSION_NOT_FOUND: 404,
  SESSION_NOT_RUNNING: 409,
  SESSION_ALREADY_COMPLETED: 409,
  NOT_STOPPED_YET: 409,
  INVALID_AUTHORIZATION: 422,
  MISSING_STAFF_PROFILE: 403,
  INVALID_TIME: 422,
  WEEKLY_TARGET_REACHED: 409,
  INVALID_TIME_INCREMENT: 422,
  INVALID_DATE: 422,
  AUTHORIZATION_REQUIRED: 422,
  AUTHORIZATION_NOT_FOR_CLIENT: 422,
  AUTHORIZATION_NOT_USABLE: 422,
  AUTHORIZATION_NOT_VALID_FOR_DATE: 422,
  SESSION_CONFLICT: 409,
};

const DEFAULT = {
  ORG_NOT_ACTIVE: 'Sessions can only be run while the organization is active.',
  APPOINTMENT_NOT_FOUND: 'We couldn\u2019t find that appointment.',
  NOT_YOUR_APPOINTMENT: 'This appointment isn\u2019t assigned to you.',
  APPOINTMENT_NOT_STARTABLE: 'This appointment can\u2019t be started.',
  APPOINTMENT_NOT_TODAY: 'This appointment isn\u2019t scheduled for today, so a new session can\u2019t be started.',
  DOCUMENTATION_NOT_PERMITTED: 'Use the session memo to record this session.',
  NOT_ASSIGNED_TO_CHILD: 'You\u2019re not assigned to this child, so you can\u2019t record a session for them.',
  NO_ACTIVE_PLAN: 'This child doesn\u2019t have an active treatment plan yet. Create one before starting a session.',
  SESSION_NOT_FOUND: 'We couldn\u2019t find that session.',
  SESSION_NOT_RUNNING: 'This session isn\u2019t running.',
  SESSION_ALREADY_COMPLETED: 'This session has already been completed.',
  NOT_STOPPED_YET: 'Stop the session before completing it.',
  INVALID_AUTHORIZATION: 'Choose an authorization that belongs to this appointment.',
  MISSING_STAFF_PROFILE: 'Your account isn\u2019t linked to a clinician profile, so you can\u2019t run sessions.',
  INVALID_TIME: 'The session times are invalid.',
  WEEKLY_TARGET_REACHED: 'You\u2019ve completed your weekly hours requirement. No additional sessions can be started this week.',
  INVALID_TIME_INCREMENT: 'Session times must be in 15-minute increments.',
  INVALID_DATE: 'Enter a valid session date.',
  AUTHORIZATION_REQUIRED: 'Select an authorization for this client.',
  AUTHORIZATION_NOT_FOR_CLIENT: 'Select an authorization for this client.',
  AUTHORIZATION_NOT_USABLE: 'The selected authorization is not approved for use.',
  AUTHORIZATION_NOT_VALID_FOR_DATE: 'The selected authorization is not valid for this session date.',
  SESSION_CONFLICT: 'This session conflicts with an existing session.',
};

export function bcbaSessionError(code, { message, details } = {}) {
  const status = STATUS[code] ?? 400;
  const msg = message ?? DEFAULT[code] ?? 'Request failed.';
  return new AppError(code, { status, message: msg, details });
}
