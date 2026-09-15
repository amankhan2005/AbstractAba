import { AppError } from '../../common/errors/AppError.js';

/** Server-side workflow state machines for timesheets and payroll runs. */
export const TIMESHEET_TRANSITIONS = Object.freeze({
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['APPROVED', 'REJECTED'],
  APPROVED: [],           // immutable once approved
  REJECTED: ['DRAFT'],    // may be reopened for correction
});

export const PAYROLL_RUN_TRANSITIONS = Object.freeze({
  DRAFT: ['APPROVED'],
  APPROVED: ['FINALIZED', 'DRAFT'], // can revert to draft before finalizing
  FINALIZED: [],                    // immutable
});

function assert(map, kind, from, to) {
  const allowed = map[from];
  if (!allowed) throw AppError.conflict('PAYROLL-409', `Unknown ${kind} status: ${from}`);
  if (from === to) return;
  if (!allowed.includes(to)) throw AppError.conflict('PAYROLL-409', `Illegal ${kind} transition ${from} -> ${to}`);
}

export const assertTimesheetTransition = (from, to) => assert(TIMESHEET_TRANSITIONS, 'timesheet', from, to);
export const assertPayrollRunTransition = (from, to) => assert(PAYROLL_RUN_TRANSITIONS, 'payroll run', from, to);
