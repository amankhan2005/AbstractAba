import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_TRANSITIONS,
  MUTABLE_STATES,
  IMMUTABLE_STATES,
  CANCELLATION_REASONS,
  PAYROLL_ELIGIBLE_STATES,
  canTransition,
  assertTransition,
  assertMutable,
  assertReason,
  assertCancellationReason,
  assertMayApprove,
  contributesToPayroll,
  humanState,
} from '../src/modules/sessions/sessions.lifecycle.js';
import { SESSION_STATUS } from '../src/models/enums.js';

/**
 * ---------------------------------------------------------------------------
 * SESSION LIFECYCLE — blueprint Figure 6.2, read from the rendered figure.
 *
 *   Scheduled ─▶ In progress ─▶ Captured ─▶ Submitted ─▶ Approved ─▶ Amended
 *                     │                          │
 *                     └──▶ Cancelled             └──▶ Returned ──┐
 *                                     ▲                          │
 *                                     └──────────────────────────┘
 *
 * The state NAMES are the blueprint's, not invented: Scheduled, In progress,
 * Captured, Submitted, Approved, Amended, Cancelled, Returned. The
 * implementation maps Scheduled/Captured onto DRAFT (both are "the mutable
 * working record", differing only in what the capture screen shows) and uses
 * FROZEN for Approved, which is the vocabulary the rest of the codebase and
 * the claim validator already speak.
 *
 * "Approval is the boundary between a mutable working record and the immutable
 * fact that billing and payroll derive from." — Figure 6.2 caption.
 * ---------------------------------------------------------------------------
 */

// --- the map itself ---------------------------------------------------------

test('every state in the enum appears in the transition map', () => {
  for (const state of SESSION_STATUS) {
    assert.ok(SESSION_TRANSITIONS[state] !== undefined, `${state} has no declared transitions`);
  }
});

test('every transition target is itself a known state', () => {
  for (const [from, targets] of Object.entries(SESSION_TRANSITIONS)) {
    for (const to of targets) {
      assert.ok(SESSION_STATUS.includes(to), `${from} → ${to} names an unknown state`);
    }
  }
});

test('the documented happy path is legal end to end', () => {
  assert.ok(canTransition('DRAFT', 'IN_PROGRESS'));   // clock in
  assert.ok(canTransition('IN_PROGRESS', 'SUBMITTED')); // capture → submit
  assert.ok(canTransition('SUBMITTED', 'FROZEN'));    // BCBA approves — the hinge
  assert.ok(canTransition('FROZEN', 'AMENDED'));      // post-approval correction
});

test('the documented branches are legal', () => {
  assert.ok(canTransition('DRAFT', 'CANCELLED'));
  assert.ok(canTransition('IN_PROGRESS', 'CANCELLED'));
  assert.ok(canTransition('SUBMITTED', 'RETURNED'));
  // Returned rejoins the working record so the technician can fix and resubmit.
  assert.ok(canTransition('RETURNED', 'SUBMITTED'));
});

// --- what the backend must refuse ------------------------------------------

test('REGRESSION — a session cannot skip review and be approved directly', () => {
  // The whole point of the hinge: nothing becomes an immutable billable fact
  // without passing through a BCBA's review queue.
  assert.equal(canTransition('DRAFT', 'FROZEN'), false);
  assert.equal(canTransition('IN_PROGRESS', 'FROZEN'), false);
  assert.equal(canTransition('RETURNED', 'FROZEN'), false);
  assert.throws(() => assertTransition('DRAFT', 'FROZEN'), /cannot become/i);
});

test('REGRESSION — an approved session can never be reopened for editing', () => {
  // "after approval the record is frozen; corrections are new, attributed
  // amendments". Any path back to a mutable state would let the source of
  // every downstream figure change under billing and payroll.
  for (const target of ['DRAFT', 'IN_PROGRESS', 'SUBMITTED', 'RETURNED', 'CANCELLED']) {
    assert.equal(canTransition('FROZEN', target), false, `FROZEN → ${target} must be refused`);
  }
  assert.deepEqual(SESSION_TRANSITIONS.FROZEN, ['AMENDED']);
});

test('AMENDED and CANCELLED are terminal', () => {
  assert.deepEqual(SESSION_TRANSITIONS.AMENDED, []);
  assert.deepEqual(SESSION_TRANSITIONS.CANCELLED, []);
});

test('a cancelled session cannot be resurrected into a billable one', () => {
  for (const target of SESSION_STATUS) {
    assert.equal(canTransition('CANCELLED', target), false);
  }
});

test('an unknown state is refused rather than treated as permissive', () => {
  assert.throws(() => assertTransition('NOT_A_STATE', 'FROZEN'), /Unknown session state/i);
});

// --- mutability -------------------------------------------------------------

test('only the working states are mutable; the rest are facts', () => {
  assert.deepEqual([...MUTABLE_STATES].sort(), ['DRAFT', 'IN_PROGRESS', 'RETURNED']);
  for (const state of IMMUTABLE_STATES) {
    assert.throws(() => assertMutable(state), /.+/, `${state} must refuse mutation`);
  }
  for (const state of MUTABLE_STATES) {
    assert.doesNotThrow(() => assertMutable(state));
  }
});

test('every state is either mutable or immutable — none is unclassified', () => {
  for (const state of SESSION_STATUS) {
    const known = MUTABLE_STATES.includes(state) || IMMUTABLE_STATES.includes(state)
      || state === 'SUBMITTED';
    assert.ok(known, `${state} is neither mutable nor immutable`);
  }
  // SUBMITTED is deliberately neither: it is awaiting review, so the
  // technician may no longer edit it and the reviewer has not yet frozen it.
  assert.throws(() => assertMutable('SUBMITTED'));
});

// --- reasons ----------------------------------------------------------------

test('return, cancellation and amendment each require a stated reason', () => {
  for (const state of ['RETURNED', 'CANCELLED', 'AMENDED']) {
    assert.throws(() => assertReason(state, ''), /.+/);
    assert.throws(() => assertReason(state, '   '), /.+/);
    assert.throws(() => assertReason(state, undefined), /.+/);
    assert.doesNotThrow(() => assertReason(state, 'a real reason'));
  }
});

test('a return with no comment is refused, in plain language', () => {
  // §9.4: "return with a comment that reaches the technician immediately".
  // A return with no comment tells the technician nothing.
  try {
    assertReason('RETURNED', '');
    assert.fail('expected a refusal');
  } catch (err) {
    assert.match(err.message ?? '', /what needs fixing/i);
    assert.doesNotMatch(err.message ?? '', /tenantId|422|Mongo|null/);
  }
});

test('ordinary transitions need no reason', () => {
  assert.doesNotThrow(() => assertReason('SUBMITTED', undefined));
  assert.doesNotThrow(() => assertReason('FROZEN', undefined));
});

test('cancellation uses the blueprint taxonomy, not free text', () => {
  // §6.4: the reasons drive different billing, payroll and outcome
  // consequences, which free text cannot do.
  for (const code of CANCELLATION_REASONS) {
    assert.doesNotThrow(() => assertCancellationReason(code));
  }
  assert.throws(() => assertCancellationReason('BECAUSE_I_SAID_SO'), /choose a cancellation reason/i);
  assert.throws(() => assertCancellationReason(undefined), /.+/);
});

// --- separation of duties ---------------------------------------------------

test('REGRESSION — nobody approves a session they delivered themselves', () => {
  // §4.5: an RBT "cannot approve their own sessions". BR-CN-2 extends it to
  // the analyst where separation of duties is enabled. The check is on the
  // DELIVERING staff member, so a multi-role owner-and-BCBA who ran the
  // session is caught too — exactly the §4.12 case.
  assert.throws(
    () => assertMayApprove({ deliveredByStaffId: 'staff-1', actorStaffId: 'staff-1' }),
    /approved by someone other than/i,
  );
});

test('a different clinician may approve', () => {
  assert.doesNotThrow(() => assertMayApprove({ deliveredByStaffId: 'staff-1', actorStaffId: 'bcba-2' }));
});

test('a tenant may disable separation of duties, as the blueprint permits', () => {
  // §4.12: "Small clinics will legitimately override these — the platform's
  // obligation is to make the risk visible and the override auditable, not to
  // prevent it."
  assert.doesNotThrow(() => assertMayApprove({
    deliveredByStaffId: 'staff-1', actorStaffId: 'staff-1', separationOfDuties: false,
  }));
});

// --- payroll derivation -----------------------------------------------------

test('BR-PR-1 — only approved sessions contribute payable hours', () => {
  assert.deepEqual(PAYROLL_ELIGIBLE_STATES, ['FROZEN']);
  assert.equal(contributesToPayroll('FROZEN'), true);
});

test('REGRESSION — drafts, submitted, returned and cancelled sessions pay nothing', () => {
  // Paying from an unapproved session is paying for work no clinician has
  // confirmed happened as recorded.
  for (const state of ['DRAFT', 'IN_PROGRESS', 'SUBMITTED', 'RETURNED', 'CANCELLED']) {
    assert.equal(contributesToPayroll(state), false, `${state} must not be payable`);
  }
});

test('REGRESSION — an AMENDED session pays nothing, or the hours are paid twice', () => {
  // An amended session has been superseded by a new attributed record which is
  // itself payable. Counting both double-pays the period.
  assert.equal(contributesToPayroll('AMENDED'), false);
});

test('an unknown status is not payable', () => {
  assert.equal(contributesToPayroll('SOMETHING_NEW'), false);
  assert.equal(contributesToPayroll(undefined), false);
});

// --- user-facing language ---------------------------------------------------

test('no enum name is ever surfaced to a user', () => {
  for (const state of SESSION_STATUS) {
    const label = humanState(state);
    assert.doesNotMatch(label, /_/, `${state} renders with an underscore`);
    assert.equal(label, label.toLowerCase(), `${state} renders in enum case`);
  }
  assert.equal(humanState('FROZEN'), 'approved');
  assert.equal(humanState('IN_PROGRESS'), 'running');
  assert.equal(humanState('NOT_A_STATE'), 'in an unknown state');
});

test('a refused transition explains itself in plain language', () => {
  try {
    assertTransition('FROZEN', 'DRAFT');
    assert.fail('expected a refusal');
  } catch (err) {
    assert.match(err.message, /approved/i);
    assert.doesNotMatch(err.message, /FROZEN|DRAFT|tenantId|Mongo/);
  }
});
