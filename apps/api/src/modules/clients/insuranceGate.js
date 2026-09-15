import { InsuranceCoverage } from '../../models/index.js';
import { COVERAGE_SATISFIED } from '../../models/enums.js';
import { AppError } from '../../common/errors/AppError.js';

/**
 * ---------------------------------------------------------------------------
 * INSURANCE VERIFICATION GATE — blueprint §6.2.
 *
 * "Nothing further can proceed until insurance is verified, and the pipeline
 * says so."
 *
 * That sentence is the whole requirement, and it has two halves that are easy
 * to get half-right. The gate must BLOCK the dependent action, and it must
 * EXPLAIN itself — a refusal a receptionist cannot act on just moves the work
 * to a phone call. So every function here returns a reason, and the reason is
 * written in the words a front-desk user would use.
 *
 * WHAT THE GATE COVERS, and what it deliberately does not:
 *
 *   Scheduling an authorized service   → GATED. This is the "dependent action"
 *                                        §6.2 names, and the point past which
 *                                        the clinic is delivering care it may
 *                                        not be paid for.
 *   Creating the client                → NOT gated. §6.2's own example creates
 *                                        the lead in ninety seconds from a
 *                                        phone call, before any payer detail
 *                                        exists. Gating intake would break the
 *                                        documented intake flow.
 *   Intake, assessment, guardian setup → NOT gated. These are how the coverage
 *                                        details get collected in the first
 *                                        place; gating them is circular.
 *   PRIVATE_PAY funding                → NOT gated. There is no payer to
 *                                        verify against. Requiring a payer
 *                                        verification for a family paying
 *                                        directly would block care for a
 *                                        reason that does not apply to them.
 *
 * The gate is enforced in the SERVICE, not the interface. A disabled button is
 * a courtesy; this is the rule.
 * ---------------------------------------------------------------------------
 */

/** Funding sources that need no payer verification (no payer to verify with). */
const SELF_FUNDED = ['PRIVATE_PAY'];

/**
 * Is a coverage record currently effective on a given date?
 * Verified-but-lapsed coverage must not satisfy the gate: the verification was
 * true when it was made and is not true now, which is exactly what effective
 * dating exists to express.
 */
export function coverageEffectiveOn(coverage, when = new Date()) {
  const at = when instanceof Date ? when : new Date(when);
  if (coverage.effectiveFrom && at < new Date(coverage.effectiveFrom)) return false;
  if (coverage.effectiveTo && at > new Date(coverage.effectiveTo)) return false;
  return true;
}

/**
 * Has this coverage record's re-verification fallen due?
 * §6.9 lists "re-verification prompts" as part of the verification record.
 */
export function reverificationOverdue(coverage, when = new Date()) {
  if (!coverage.reverificationDueAt) return false;
  const at = when instanceof Date ? when : new Date(when);
  return at > new Date(coverage.reverificationDueAt);
}

/**
 * Evaluates every coverage record for a client and returns a single, explained
 * eligibility answer.
 *
 * @returns {{ satisfied: boolean, status: string, reason: string|null, coverageId: string|null }}
 *   `status` is a UI-facing summary, `reason` is the plain-language sentence to
 *   show. `satisfied: true` is the ONLY value that opens the gate.
 */
export function evaluateCoverage(coverages, { when = new Date() } = {}) {
  const live = (coverages ?? []).filter((c) => !c.deletedAt);

  if (live.length === 0) {
    return {
      satisfied: false,
      status: 'NO_COVERAGE',
      reason: 'Add the family\u2019s insurance details before scheduling services.',
      coverageId: null,
    };
  }

  // Self-funded care needs no payer verification.
  const selfFunded = live.find((c) => SELF_FUNDED.includes(c.fundingSource));
  if (selfFunded) {
    return { satisfied: true, status: 'PRIVATE_PAY', reason: null, coverageId: selfFunded._id ?? null };
  }

  // The gate is satisfied by ANY coverage that is verified and in force —
  // typically the primary, but a secondary alone is still real coverage.
  const usable = live.find(
    (c) => c.verificationStatus === COVERAGE_SATISFIED
      && coverageEffectiveOn(c, when)
      && !reverificationOverdue(c, when),
  );
  if (usable) {
    return { satisfied: true, status: 'VERIFIED', reason: null, coverageId: usable._id ?? null };
  }

  // Not satisfied. Report the most actionable failure rather than the first,
  // so the queue tells the user what to actually do next.
  const byPriority = ['NEEDS_CORRECTION', 'PENDING', 'FAILED', 'EXPIRED', 'UNVERIFIED'];
  const worst = byPriority
    .map((status) => live.find((c) => c.verificationStatus === status))
    .find(Boolean) ?? live[0];

  const expired = live.find((c) => c.verificationStatus === COVERAGE_SATISFIED
    && (!coverageEffectiveOn(c, when) || reverificationOverdue(c, when)));
  if (expired) {
    return {
      satisfied: false,
      status: 'EXPIRED',
      reason: 'This family\u2019s insurance needs to be checked again before more sessions are scheduled.',
      coverageId: expired._id ?? null,
    };
  }

  return {
    satisfied: false,
    status: worst.verificationStatus,
    reason: {
      UNVERIFIED: 'Insurance verification is required before scheduling services.',
      PENDING: 'Insurance verification is still in progress.',
      NEEDS_CORRECTION: 'The insurance details need attention before services can be scheduled.',
      FAILED: 'The insurer could not confirm active coverage for this child.',
      EXPIRED: 'This family\u2019s insurance needs to be checked again before more sessions are scheduled.',
    }[worst.verificationStatus] ?? 'Insurance verification is required before scheduling services.',
    coverageId: worst._id ?? null,
  };
}

/**
 * Loads a client's coverage and evaluates the gate. Must run inside tenant
 * context — the coverage model carries the tenant plugin, so a client in
 * another organization resolves to no coverage rather than to someone else's.
 */
export async function coverageStatusFor(clientId, { when = new Date() } = {}) {
  const coverages = await InsuranceCoverage.find({ clientId, deletedAt: null }).lean();
  return evaluateCoverage(coverages, { when });
}

/**
 * Throws unless the client's coverage opens the gate.
 *
 * 422, not 403: the caller is permitted to schedule, and the request is
 * well-formed — it is the business precondition that is unmet. Blueprint §11.6
 * reserves 403 for authorization. Sending 403 here would tell a receptionist
 * she lacks permission when what she actually needs is to phone the insurer.
 */
export async function assertCoverageVerified(clientId, { when = new Date() } = {}) {
  const result = await coverageStatusFor(clientId, { when });
  if (!result.satisfied) {
    throw AppError.validation(result.reason, {
      gate: 'INSURANCE_VERIFICATION',
      status: result.status,
    });
  }
  return result;
}
