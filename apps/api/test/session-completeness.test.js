import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submissionProblems } from '../src/modules/sessions/sessions.completeness.js';

/**
 * ---------------------------------------------------------------------------
 * SUBMISSION COMPLETENESS — blueprint §6.6.
 *
 * "Before submission: required data present, note fields complete, times
 * consistent, signatures captured. Failures are shown inline with what to fix."
 *
 * This gate did not exist server-side. Submission was `PATCH { status:
 * 'SUBMITTED' }` and `assertPatchStatus` allowed any DRAFT↔SUBMITTED move, so
 * the UI's own `canSubmit` boolean was the only thing between an incomplete
 * session and a BCBA's review queue — and from there one approval away from
 * being the immutable fact billing and payroll derive from.
 * ---------------------------------------------------------------------------
 */

const complete = (over = {}) => ({
  status: 'IN_PROGRESS',
  clockInAt: new Date('2026-08-20T09:00:00Z'),
  clockOutAt: new Date('2026-08-20T11:00:00Z'),
  sensitive: { narrative: 'sealed(...)' },
  signatures: [{ role: 'TECHNICIAN' }, { role: 'GUARDIAN' }],
  // The real EVV shape, per sessions.signatures.js — the six payer-required
  // elements, with location at BOTH clock events.
  verification: {
    serviceType: '97153',
    recipientClientId: 'c-1',
    providerStaffProfileId: 'rbt-1',
    serviceDate: '2026-08-20',
    clockInLocation: { latitude: 51.5, longitude: -0.1 },
    clockOutLocation: { latitude: 51.5, longitude: -0.1 },
    startTime: new Date('2026-08-20T09:00:00Z'),
    endTime: new Date('2026-08-20T11:00:00Z'),
  },
  ...over,
});

test('a complete session has no problems', () => {
  assert.deepEqual(submissionProblems(complete()), []);
});

test('REGRESSION — a session with no clock-out cannot be submitted', () => {
  const problems = submissionProblems(complete({ clockOutAt: null }));
  assert.ok(problems.some((p) => /clock out/i.test(p)));
});

test('REGRESSION — a session that was never started cannot be submitted', () => {
  const problems = submissionProblems(complete({ clockInAt: null, clockOutAt: null }));
  assert.ok(problems.some((p) => /clock in/i.test(p)));
});

test('REGRESSION — times must be consistent', () => {
  // A negative or zero duration reaches payroll and billing as a real figure
  // if nothing stops it here.
  const backwards = complete({
    clockInAt: new Date('2026-08-20T11:00:00Z'),
    clockOutAt: new Date('2026-08-20T09:00:00Z'),
  });
  assert.ok(submissionProblems(backwards).some((p) => /after the clock-in/i.test(p)));

  const zero = complete({ clockOutAt: new Date('2026-08-20T09:00:00Z') });
  assert.ok(submissionProblems(zero).some((p) => /after the clock-in/i.test(p)));
});

test('REGRESSION — the session note is required', () => {
  const problems = submissionProblems(complete({ sensitive: {} }));
  assert.ok(problems.some((p) => /session note/i.test(p)));
});

test('the note is checked for PRESENCE, never read', () => {
  // The narrative is sealed. This code has no business decrypting a clinical
  // note to count its characters.
  assert.deepEqual(submissionProblems(complete({ sensitive: { narrative: 'sealed(x)' } })), []);
  assert.deepEqual(submissionProblems(complete({ sensitive: {}, narrativePresent: true })), []);
});

test('REGRESSION — both signatures are required', () => {
  const noTech = submissionProblems(complete({ signatures: [{ role: 'GUARDIAN' }] }));
  assert.ok(noTech.some((p) => /your signature/i.test(p)));

  const noGuardian = submissionProblems(complete({ signatures: [{ role: 'TECHNICIAN' }] }));
  assert.ok(noGuardian.some((p) => /guardian/i.test(p)));

  const none = submissionProblems(complete({ signatures: [] }));
  assert.equal(none.filter((p) => /signature/i.test(p)).length, 2);
});

test('a RECORDED REFUSAL counts as a captured signature', () => {
  // §9.4: "refusal is recorded with reason; the session proceeds to review
  // flagged". Requiring a signature the family has declined would strand the
  // record permanently.
  const refused = complete({
    signatures: [{ role: 'TECHNICIAN' }, { role: 'GUARDIAN', refused: true, refusalReason: 'Parent had left' }],
  });
  assert.deepEqual(submissionProblems(refused), []);
});

test('REGRESSION — an incomplete verified visit record blocks submission', () => {
  const problems = submissionProblems(complete({ verification: {} }));
  assert.ok(problems.some((p) => /visit details/i.test(p)));
});

test('EVERY problem is reported at once, not just the first', () => {
  // §6.6 requires failures be "shown inline with what to fix". One at a time
  // means submit, fix, resubmit, discover the next — at the end of a home
  // visit with a family waiting.
  const empty = {
    status: 'IN_PROGRESS', clockInAt: null, clockOutAt: null,
    sensitive: {}, signatures: [], verification: {},
  };
  const problems = submissionProblems(empty);
  assert.ok(problems.length >= 4, `expected several problems, got ${problems.length}`);
  assert.ok(problems.some((p) => /clock in/i.test(p)));
  assert.ok(problems.some((p) => /session note/i.test(p)));
  assert.ok(problems.some((p) => /signature/i.test(p)));
});

test('every problem is an instruction, not a spec phrase', () => {
  const empty = {
    status: 'IN_PROGRESS', clockInAt: null, clockOutAt: null,
    sensitive: {}, signatures: [], verification: {},
  };
  for (const problem of submissionProblems(empty)) {
    // A user gets told what to DO, and never sees a field or model name.
    assert.match(problem, /\.$/, `"${problem}" should read as a sentence`);
    assert.doesNotMatch(problem, /clockInAt|clockOutAt|narrative|verification|EVV|null|undefined/);
  }
});
