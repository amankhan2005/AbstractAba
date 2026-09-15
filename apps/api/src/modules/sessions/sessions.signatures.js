import { createHash } from 'node:crypto';
import { sessionsError } from './sessions.errors.js';

/**
 * ---------------------------------------------------------------------------
 * SIGNATURES AND THE VERIFICATION RECORD.
 *
 * §6.6 Signatures: "Guardian and technician signature captured on the device at
 * the point of service and bound cryptographically to the session record."
 *
 * §6.6 Verification record: "Service type, recipient, provider, date, location
 * and start and end times captured live and immutably — the six elements
 * electronic visit verification requires."
 *
 * WHAT "BOUND CRYPTOGRAPHICALLY" HAS TO MEAN HERE. A signature row with a name
 * and a timestamp proves nothing: any later edit to the session leaves it
 * looking equally valid, so "signed sessions cannot be silently modified" would
 * be a claim rather than a property. The binding is therefore a hash over the
 * session's identity AND the material facts a signer was attesting to — the
 * client, the provider, and the start and end times. Change any of them and
 * every signature over the old values stops verifying, which is exactly the
 * detection the blueprint is asking for.
 *
 * This is tamper EVIDENCE, not tamper proofing. A hash computed by the
 * application can be recomputed by the application; what it defends against is
 * silent modification through the ordinary write paths and in the stored data,
 * which is the realistic threat for a clinical record. Non-repudiation against
 * the application itself would need a key the application does not hold, and
 * the blueprint does not ask for that.
 * ---------------------------------------------------------------------------
 */

/**
 * The canonical material a signature attests to. Field ORDER is fixed and
 * values are normalised, because a hash over an object whose key order can vary
 * is a hash that fails at random.
 */
function bindingMaterial(session, signature) {
  return [
    session._id ?? session.id,
    session.tenantId,
    session.clientId,
    session.staffProfileId,
    session.appointmentId,
    session.startedAt ? new Date(session.startedAt).toISOString() : '',
    session.endedAt ? new Date(session.endedAt).toISOString() : '',
    signature.role,
    signature.signerName ?? '',
    signature.signerUserId ?? '',
    signature.signerGuardianId ?? '',
    signature.signedAt ? new Date(signature.signedAt).toISOString() : '',
    signature.refused ? 'REFUSED' : 'SIGNED',
  ].join('\u001f'); // unit separator — cannot occur in any of the values above
}

/** Computes the binding hash for a signature over a session. */
export function computeBindingHash(session, signature) {
  return createHash('sha256').update(bindingMaterial(session, signature)).digest('hex');
}

/**
 * Does every signature on this session still verify against its content?
 * Returns the list of signatures that no longer bind — empty means intact.
 */
export function verifySignatures(session) {
  return (session.signatures ?? []).filter(
    (sig) => sig.bindingHash !== computeBindingHash(session, sig),
  );
}

/** Throws when the session's content has drifted from what was signed. */
export function assertSignaturesIntact(session) {
  const broken = verifySignatures(session);
  if (broken.length > 0) {
    throw sessionsError('SESSION_FROZEN', {
      message: 'This session has been signed and its details can no longer be changed.',
    });
  }
}

/**
 * SIGNER AUTHORITY (§4.5, §6.6).
 *
 * The technician signature is the delivering technician's own act — nobody may
 * sign in their place, which is the whole evidentiary point of a technician
 * signature. The guardian signature is CAPTURED BY the technician on the device
 * at the point of service, so the acting user is the technician while the
 * signer is the guardian; the two identities are recorded separately and must
 * not be conflated.
 */
export function assertMaySign({ role, actorStaffProfileId, deliveredByStaffId }) {
  if (actorStaffProfileId !== deliveredByStaffId) {
    throw sessionsError('NOT_SESSION_OWNER', {
      message: 'Only the person who delivered this session can capture its signatures.',
    });
  }
  if (role !== 'GUARDIAN' && role !== 'TECHNICIAN') {
    throw sessionsError('INCOMPLETE_SESSION', { message: 'Unknown signature type.' });
  }
}

/** One signature per role per session — a second is a conflict, not an overwrite. */
export function assertSignatureAbsent(session, role) {
  if ((session.signatures ?? []).some((s) => s.role === role)) {
    throw sessionsError('SIGNATURE_EXISTS');
  }
}

// --- Verification record ----------------------------------------------------

/** The six EVV elements, named as §6.6 names them. */
export const EVV_ELEMENTS = Object.freeze([
  'serviceType',
  'recipient',
  'provider',
  'date',
  'location',
  'times',
]);

/**
 * Which of the six elements are present. Returned as a list of what is MISSING
 * so the exception queue can name the blocker (§6.7 "Each item names its
 * blocker and its owner") rather than reporting a bare boolean.
 */
export function missingEvvElements(verification = {}) {
  const missing = [];
  if (!verification.serviceType) missing.push('serviceType');
  if (!verification.recipientClientId) missing.push('recipient');
  if (!verification.providerStaffProfileId) missing.push('provider');
  if (!verification.serviceDate) missing.push('date');

  const inLoc = verification.clockInLocation ?? {};
  const outLoc = verification.clockOutLocation ?? {};
  const hasIn = inLoc.latitude !== null && inLoc.latitude !== undefined;
  const hasOut = outLoc.latitude !== null && outLoc.latitude !== undefined;
  // Location at BOTH clock events — one point does not verify a visit.
  if (!hasIn || !hasOut) missing.push('location');

  if (!verification.startTime || !verification.endTime) missing.push('times');
  return missing;
}

export function isEvvComplete(verification) {
  return missingEvvElements(verification).length === 0;
}

/**
 * Coarsens a location to roughly a city block before it is stored.
 *
 * §6.6 design ruling: location is captured "at coarse precision, disclosed to
 * staff, consented to, and stored minimally". Three decimal places is about
 * 110 m — enough to evidence that the technician was at the home, not enough to
 * place them within it. Storing the raw fix and coarsening on read would defeat
 * the purpose, so the coarsening happens before persistence.
 */
export function coarsenLocation(location) {
  if (!location || location.latitude === undefined || location.latitude === null) return null;
  const round = (n) => Math.round(Number(n) * 1000) / 1000;
  return {
    latitude: round(location.latitude),
    longitude: round(location.longitude),
    accuracyMetres: location.accuracyMetres ?? null,
    capturedAt: location.capturedAt ? new Date(location.capturedAt) : new Date(),
  };
}
