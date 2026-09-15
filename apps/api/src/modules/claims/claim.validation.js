import { AppError } from '../../common/errors/AppError.js';

/**
 * Pure claim validation engine — no DB access. Given a candidate session with
 * its resolved authorization and the set of already-claimed session ids, it
 * returns { eligible, reasons[] }. Callers (the service) do the DB lookups and
 * pass plain objects in, keeping this independently unit-testable.
 *
 * Money in integer minor units. Units are validated against remaining
 * authorized units (authorizedUnits - usedUnits).
 */
export function validateSessionForClaim({ session, authorization, client, alreadyClaimedSessionIds = [], units, charge }) {
  const reasons = [];

  if (!session) return { eligible: false, reasons: ['SESSION_MISSING'] };
  if (session.status !== 'FROZEN') reasons.push('SESSION_NOT_FROZEN');
  if (alreadyClaimedSessionIds.includes(session._id)) reasons.push('SESSION_ALREADY_CLAIMED');
  if (!session.staffProfileId) reasons.push('MISSING_PROVIDER');
  if (!client) reasons.push('MISSING_CLIENT');

  if (!authorization) {
    reasons.push('AUTHORIZATION_MISSING');
  } else {
    if (!authorization.serviceCode) reasons.push('MISSING_SERVICE_CODE');
    const svcDate = session.startedAt ? new Date(session.startedAt) : null;
    if (!svcDate) reasons.push('MISSING_SERVICE_DATE');
    else {
      if (authorization.startDate && svcDate < new Date(authorization.startDate)) reasons.push('SERVICE_DATE_BEFORE_AUTH');
      if (authorization.endDate && svcDate > new Date(authorization.endDate)) reasons.push('SERVICE_DATE_AFTER_AUTH');
    }
    const remaining = (authorization.authorizedUnits ?? 0) - (authorization.usedUnits ?? 0);
    if (Number.isFinite(units) && units > remaining) reasons.push('UNITS_EXCEED_AUTHORIZED');
  }

  if (!Number.isInteger(units) || units <= 0) reasons.push('INVALID_UNITS');
  if (!Number.isInteger(charge) || charge < 0) reasons.push('INVALID_CHARGE');

  return { eligible: reasons.length === 0, reasons };
}

/** Sum claim line charges into a total (minor units). Rejects invalid values. */
export function sumClaimCharges(lines) {
  let total = 0;
  for (const l of lines) {
    if (!Number.isInteger(l.charge) || l.charge < 0) throw AppError.validation('line charge must be a non-negative integer (minor units).');
    total += l.charge;
  }
  return total;
}

export function sumClaimUnits(lines) {
  let total = 0;
  for (const l of lines) {
    if (!Number.isInteger(l.units) || l.units < 0) throw AppError.validation('line units must be a non-negative integer.');
    total += l.units;
  }
  return total;
}
