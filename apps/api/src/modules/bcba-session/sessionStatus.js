import { hasRunningInterval } from './bcbaSession.time.js';

/**
 * The clinician-facing state of ONE appointment's work, derived from the
 * appointment and its session (never stored):
 *   SCHEDULED | IN_PROGRESS | STOPPED | COMPLETED | CANCELLED
 * Shared by the BCBA/RBT session panel and the Company dashboard so both
 * describe the same appointment the same way.
 */
export function deriveSessionStatus(appt, session) {
  if (appt?.status === 'CANCELLED') return 'CANCELLED';
  // A COMPLETED appointment (e.g. a manual session's) is finished work, never a
  // slot to start again — its session is already frozen.
  if (appt?.status === 'COMPLETED' && (!session || session.status === 'FROZEN' || session.status === 'AMENDED')) return 'COMPLETED';
  if (!session) return 'SCHEDULED';
  if (session.status === 'FROZEN' || session.status === 'AMENDED') return 'COMPLETED';
  if (session.status === 'CANCELLED') return 'CANCELLED';
  if (session.status === 'IN_PROGRESS') {
    // Running is decided by the open interval; endedAt is the fallback for
    // sessions recorded before intervals existed.
    const running = (session.intervals ?? []).length
      ? hasRunningInterval(session.intervals)
      : !session.endedAt;
    return running ? 'IN_PROGRESS' : 'STOPPED';
  }
  if (session.status === 'DRAFT') return 'SCHEDULED';
  return session.status;
}
