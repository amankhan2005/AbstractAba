import { missingEvvElements } from './sessions.signatures.js';

/**
 * ---------------------------------------------------------------------------
 * SUBMISSION COMPLETENESS — blueprint §6.6.
 *
 * "Completeness check. Before submission: required data present, note fields
 * complete, times consistent, signatures captured. Failures are shown inline
 * with what to fix."
 *
 * Two things that sentence demands, and which a boolean `isComplete` cannot
 * give:
 *
 *   EVERY problem at once. Returning only the first means the technician
 *   submits, fixes it, resubmits, and discovers the next — a loop that is
 *   miserable at the end of a home visit with a family waiting.
 *
 *   WHAT TO FIX, in their words. "note fields complete" is a spec phrase;
 *   "Write the session note before submitting" is an instruction. Every string
 *   below is the second kind.
 *
 * This runs on the SERVER because the UI's own `canSubmit` was previously the
 * only thing standing between an incomplete session and a BCBA's review queue.
 * ---------------------------------------------------------------------------
 */

/**
 * Everything that must be true before a session may be submitted.
 * @returns {string[]} plain-language problems; empty means ready.
 */
export function submissionProblems(session) {
  const problems = [];

  // --- times ---------------------------------------------------------------
  if (!session.clockInAt) {
    problems.push('Clock in before submitting this session.');
  }
  if (session.clockInAt && !session.clockOutAt) {
    problems.push('Clock out before submitting this session.');
  }
  if (session.clockInAt && session.clockOutAt) {
    const start = new Date(session.clockInAt).getTime();
    const end = new Date(session.clockOutAt).getTime();
    if (end <= start) {
      // "times consistent" (§6.6). A negative or zero duration reaches payroll
      // and billing as a real figure if nobody stops it here.
      problems.push('The clock-out time must be after the clock-in time.');
    }
  }

  // --- the note ------------------------------------------------------------
  // The narrative is sealed, so its presence is checked rather than its text —
  // this code has no business reading the clinical note.
  const hasNarrative = Boolean(session.sensitive?.narrative)
    || Boolean(session.narrative)
    || Boolean(session.narrativePresent);
  if (!hasNarrative) {
    problems.push('Write the session note before submitting.');
  }

  // --- signatures ----------------------------------------------------------
  // A refusal counts as captured: §9.4 records that "refusal is recorded with
  // reason; the session proceeds to review flagged". Requiring a signature the
  // family has declined would strand the record permanently.
  const signatures = session.signatures ?? [];
  const has = (role) => signatures.some((s) => s.role === role);
  if (!has('TECHNICIAN')) {
    problems.push('Add your signature before submitting.');
  }
  if (!has('GUARDIAN')) {
    problems.push('Capture the guardian’s signature, or record that they declined.');
  }

  // --- verified visit record ----------------------------------------------
  const missingEvv = missingEvvElements(session.verification ?? {});
  if (missingEvv.length > 0) {
    // The six elements are a payer requirement, not a preference: a visit
    // missing them is a claim that will be denied after the work is done.
    problems.push('Some visit details are missing. Check your clock-in and clock-out were recorded with location.');
  }

  return problems;
}
