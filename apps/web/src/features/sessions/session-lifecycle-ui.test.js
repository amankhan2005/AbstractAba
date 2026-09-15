import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'SessionLifecyclePanel.jsx'), 'utf8');
const clientSource = readFileSync(join(here, '..', '..', 'api', 'client.js'), 'utf8');

/**
 * SESSION LIFECYCLE UI — blueprint Figure 6.2.
 *
 * The property under test is that the UI does NOT own a state machine. The
 * backend already has one (`sessions.lifecycle.js`, proven by
 * `session-lifecycle-boundaries.test.js`), and a second copy in React would
 * drift from it — which shows up as an enabled button whose action always
 * fails, or worse, a disabled button hiding a transition the user is entitled
 * to make.
 *
 * These are static assertions about the component's shape rather than render
 * tests, because the risk being guarded against is structural: someone adding
 * a client-side `setStatus` or a local transition table.
 */

describe('the UI defers to the backend state machine', () => {
  it('never sets a session status directly — not even to submit', () => {
    // Previously the submit action sent `PATCH { status: 'SUBMITTED' }`, and
    // the API permitted any DRAFT<->SUBMITTED move: the completeness check
    // (6.6) was enforced only by this component's own `canSubmit` boolean, so
    // any other client could put an incomplete session into a BCBA's review
    // queue. Submission now has its own endpoint that runs the check
    // server-side, and the UI sends NO status at all.
    const statusAssignments = source.match(/status:\s*'[A-Z_]+'/g) ?? [];
    expect(statusAssignments).toEqual([]);
  });

  it('submits through the dedicated endpoint', () => {
    expect(source).toMatch(/submitSession\(session\.id\)/);
    expect(source).not.toMatch(/updateSession\(/);
  });

  it('declares no transition table of its own', () => {
    expect(source).not.toMatch(/TRANSITIONS\s*=/);
    expect(source).not.toMatch(/canTransition/);
  });

  it('derives its state view from the status the server returned', () => {
    expect(source).toMatch(/session\?\.status \?\? 'DRAFT'/);
  });

  it('calls one dedicated endpoint per transition', () => {
    for (const fn of ['clockInSession', 'clockOutSession', 'returnSession',
      'cancelSession', 'amendSession', 'freezeSession', 'captureSessionSignature']) {
      expect(source).toContain(fn);
      expect(clientSource).toContain(`export async function ${fn}`);
    }
  });

  it('exposes no generic setStatus helper on the API client', () => {
    // A generic status setter would invite the UI to think it owns the machine.
    expect(clientSource).not.toMatch(/export async function setSessionStatus/);
  });
});

describe('actions are gated by the current state', () => {
  it('clock in is offered only before the session has started', () => {
    expect(source).toMatch(/canClockIn = canWrite && status === 'DRAFT' && !session\.clockInAt/);
  });

  it('clock out is offered only while the session is running', () => {
    expect(source).toMatch(/canClockOut = canWrite && status === 'IN_PROGRESS' && !session\.clockOutAt/);
  });

  it('REGRESSION — submit requires a clock-out first', () => {
    // Payroll derives payable minutes from the verified clock. A session
    // submitted without one produces an approved record with no verified
    // duration behind it.
    expect(source).toMatch(/canSubmit =.*Boolean\(session\.clockOutAt\)/);
  });

  it('REGRESSION — approval is offered only to a reviewer, only when submitted', () => {
    // 4.5: an RBT "cannot approve their own sessions". `canReview` is the
    // sessions.freeze permission, and the server enforces separation of duties
    // regardless of what renders here.
    expect(source).toMatch(/canApprove = canReview && status === 'SUBMITTED'/);
    expect(source).not.toMatch(/canApprove = canWrite/);
  });

  it('sending a session back is a reviewer action, not a technician one', () => {
    expect(source).toMatch(/canSendBack = canReview && status === 'SUBMITTED'/);
  });

  it('REGRESSION — an approved session offers no edit path, only amendment', () => {
    // "after approval the record is frozen; corrections are new, attributed
    // amendments."
    expect(source).toMatch(/canAmend = canReview && status === 'FROZEN'/);
    expect(source).toMatch(/canCancel = canWrite && \['DRAFT', 'IN_PROGRESS', 'RETURNED'\]/);
    expect(source).not.toMatch(/canSubmit.*'FROZEN'/);
  });

  it('cancellation is impossible once a session is approved or already cancelled', () => {
    const match = source.match(/canCancel = canWrite && \[([^\]]+)\]/);
    expect(match).toBeTruthy();
    expect(match[1]).not.toContain('FROZEN');
    expect(match[1]).not.toContain('CANCELLED');
    expect(match[1]).not.toContain('SUBMITTED');
  });
});

describe('reasons are mandatory where the backend requires them', () => {
  it('a return or an amendment cannot be confirmed with an empty reason', () => {
    // The API refuses these; blocking in the dialog means the user finds out
    // before they commit rather than after a failed request.
    expect(source).toMatch(/disabled=\{busy \|\| value\.trim\(\) === ''\}/);
  });

  it('cancellation uses the blueprint taxonomy, not free text', () => {
    for (const code of ['CLIENT_CANCEL', 'PROVIDER_CANCEL', 'NO_SHOW', 'ILLNESS', 'WEATHER', 'HOLIDAY', 'AGENCY']) {
      expect(source).toContain(code);
    }
  });
});

describe('user-facing language', () => {
  it('no enum name is rendered to a user', () => {
    // The old card printed `{session.status}` straight to the page.
    expect(source).not.toMatch(/\{session\.status\}/);
    for (const [enumName, label] of [
      ['FROZEN', 'Approved'], ['IN_PROGRESS', 'In progress'],
      ['RETURNED', 'Sent back for changes'], ['DRAFT', 'Ready to start'],
    ]) {
      expect(source).toMatch(new RegExp(`${enumName}: \\{ label: '${label}`));
    }
  });

  it('an approved session explains that corrections become amendments', () => {
    expect(source).toMatch(/corrections|amendment/i);
  });

  it('uses no browser dialogs', () => {
    // Match real CALLS — `window.confirm(...)` or a bare `confirm(...)` in
    // statement position — rather than any occurrence of the word, so a
    // comment or a component named ConfirmDialog does not trip the check.
    expect(source).not.toMatch(/(?:window\s*\.\s*)?(?:^|[;{}=>(]\s*)(?:alert|confirm|prompt)\s*\(/m);
  });

  it('surfaces the server’s plain-language refusal rather than a status code', () => {
    expect(source).toMatch(/error\?\.message/);
    expect(source).toMatch(/We couldn’t do that just now/);
  });

  it('lists EVERY completeness problem the server returned, not just the first', () => {
    // 6.6: "Failures are shown inline with what to fix." One at a time means
    // submit, fix, resubmit, discover the next — at the end of a home visit
    // with a family waiting.
    expect(source).toMatch(/details\?\.problems/);
    expect(source).toMatch(/blockers\.map/);
  });
});

describe('EVV location capture', () => {
  it('captures location at the clock events, never continuously', () => {
    // 6.6: "Time and location are captured at that moment as part of the
    // verified visit record — captured at the event, not tracked continuously."
    expect(source).toContain('capturePlace');
    expect(source).not.toMatch(/watchPosition/);
  });

  it('requests coarse precision only', () => {
    expect(source).toMatch(/enableHighAccuracy: false/);
    expect(source).toMatch(/Math\.round\(value \* 1000\) \/ 1000/);
  });

  it('REGRESSION — a denied or failed location never blocks the session', () => {
    // 9.4's worked example is a technician in a family home with no signal.
    // BR-BL-5 holds the claim, not the care.
    expect(source).toMatch(/catch \{\s*\/\/ Denied, unavailable, or timed out/);
    expect(source).toMatch(/if \(!navigator\?\.geolocation\) return \{\};/);
  });
});
