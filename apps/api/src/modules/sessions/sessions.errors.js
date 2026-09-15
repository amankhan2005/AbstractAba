import { AppError } from '../../common/errors/AppError.js';

const STATUS = {
  SESSION_NOT_FOUND: 404,
  DATA_POINT_NOT_FOUND: 404,
  ORG_NOT_ACTIVE: 409,
  VERSION_CONFLICT: 409,
  SESSION_FROZEN: 409,
  SESSION_EXISTS: 409,
  INVALID_STATUS_TRANSITION: 409,
  SELF_APPROVAL_REFUSED: 409,
  ALREADY_CLOCKED_IN: 409,
  NOT_CLOCKED_IN: 409,
  SIGNATURE_EXISTS: 409,
  AMENDMENT_INVALID: 409,
  REASON_REQUIRED: 422,
  SESSION_INCOMPLETE: 422,
  INVALID_CANCELLATION_REASON: 422,
  INVALID_CLOCK_TIME: 422,
  INCOMPLETE_SESSION: 422,
  NOT_SESSION_OWNER: 403,
  APPOINTMENT_INVALID: 422,
  APPOINTMENT_NOT_TODAY: 409,
  PLAN_INVALID: 422,
  TARGET_INVALID: 422,
  INVALID_MEASUREMENT: 422,
  TENANT_CONTEXT_MISSING: 500,
};
const DEFAULT = {
  SESSION_NOT_FOUND: 'Session not found',
  DATA_POINT_NOT_FOUND: 'Session data point not found',
  ORG_NOT_ACTIVE: 'Sessions can only be captured while the organization is active.',
  VERSION_CONFLICT: 'This record changed since you loaded it. Reload and try again.',
  SESSION_FROZEN: 'A frozen session cannot be modified.',
  SESSION_EXISTS: 'A session already exists for this appointment.',
  INVALID_STATUS_TRANSITION: 'That session status change is not allowed.',
  SELF_APPROVAL_REFUSED: 'A session has to be approved by someone other than the person who delivered it.',
  ALREADY_CLOCKED_IN: 'You are already clocked in to this session.',
  NOT_CLOCKED_IN: 'You need to clock in before you can clock out.',
  SIGNATURE_EXISTS: 'That signature has already been captured for this session.',
  AMENDMENT_INVALID: 'Only an approved session can be amended.',
  REASON_REQUIRED: 'Please give a reason.',
  // Overridden per-call with the specific problems found (blueprint 6.6:
  // "failures are shown inline with what to fix").
  SESSION_INCOMPLETE: 'This session isn\u2019t ready to submit yet.',
  INVALID_CANCELLATION_REASON: 'Please choose a cancellation reason from the list.',
  INVALID_CLOCK_TIME: 'Those times do not look right. Please check and try again.',
  INCOMPLETE_SESSION: 'Some required information is still missing.',
  NOT_SESSION_OWNER: 'You can only record time for your own sessions.',
  APPOINTMENT_INVALID: 'A session must be captured against a valid, non-cancelled appointment.',
  APPOINTMENT_NOT_TODAY: 'This appointment isn\u2019t scheduled for today, so you can\u2019t clock in.',
  PLAN_INVALID: 'A session must reference the active treatment plan for the appointment client.',
  TARGET_INVALID: 'The target does not belong to this session plan or is not active.',
  INVALID_MEASUREMENT: 'The measurement values are invalid for the target measurement type.',
  TENANT_CONTEXT_MISSING: 'Tenant context missing',
};

export function sessionsError(code, { message, context, details } = {}) {
  return new AppError(code, {
    status: STATUS[code] ?? 400,
    message: message ?? DEFAULT[code] ?? code,
    ...(context ? { context } : {}),
    ...(details ? { details } : {}),
  });
}
