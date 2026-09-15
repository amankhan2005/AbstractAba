/**
 * Unified bookable-authorization adapter.
 *
 * The Company's APPROVED ABA/FBA ServiceAuthorization is the SAME record
 * Scheduling books against — there is no separate "scheduling authorization"
 * created for a child. To route validation and unit burn-down to the right
 * collection while keeping ONE selector, a ServiceAuthorization is surfaced
 * with its own `_id` behind a `svc:` marker. The marker is transport only:
 * `serviceAuthIdOf(svc:<id>) === <id>` is exactly the ServiceAuthorization._id,
 * so the id Scheduling uses carries the real database identity of the record the
 * child screen created — not a copy.
 */
import { toDateOnly } from '../../utils/format.js';

export const SVC_PREFIX = 'svc:';

/**
 * Whether an ABA/FBA ServiceAuthorization may be used by booking, manual
 * sessions and billing. Adding an authorization makes it usable immediately;
 * no review or approval step is required. A DENIED or archived line is not.
 */
export const isUsableServiceAuthorization = (doc) => Boolean(doc) && !doc.deletedAt && doc.status !== 'DENIED';

export const isServiceAuthId = (id) => typeof id === 'string' && id.startsWith(SVC_PREFIX);

/** The underlying ServiceAuthorization._id carried by a bookable id. */
export const serviceAuthIdOf = (id) => (isServiceAuthId(id) ? id.slice(SVC_PREFIX.length) : id);

/** The bookable id for a ServiceAuthorization row (its real _id, marked). */
export const bookableIdForServiceAuth = (serviceAuthId) => `${SVC_PREFIX}${serviceAuthId}`;

/** Map an ABA/FBA ServiceAuthorization row onto the bookable authorization shape. */
export function serviceAuthToBookable(doc) {
  const authorizedUnits = doc.units ?? 0;
  const usedUnits = doc.usedUnits ?? 0;
  return {
    id: bookableIdForServiceAuth(doc._id),
    clientId: doc.clientId,
    payerName: null,
    authorizationNumber: doc.authorizationNumber ?? null,
    serviceCode: doc.serviceType, // 'ABA' | 'FBA'
    serviceType: doc.serviceType,
    // Date-only calendar window (YYYY-MM-DD) so the scheduling selector and
    // booking modal render MM/DD/YYYY timezone-safe. Booking-window validation is
    // unaffected: authorization dates are stored at UTC midnight, so
    // new Date(toDateOnly(d)) has the identical epoch the raw Date carried.
    startDate: toDateOnly(doc.startDate),
    endDate: toDateOnly(doc.endDate),
    authorizedUnits,
    usedUnits,
    remainingUnits: authorizedUnits - usedUnits,
    // A saved authorization is usable as soon as it is added — the payer
    // workflow (NOT_SENT → SENT → APPROVED) is tracking, not a gate. Only a
    // DENIED line presents as non-ACTIVE, so validateAuthorization() rejects it.
    // Date window and remaining units are still enforced by the shared rules.
    status: isUsableServiceAuthorization(doc) ? 'ACTIVE' : 'DENIED',
    workflowStatus: doc.status ?? null,
    source: 'service',
    createdAt: doc.createdAt,
    version: doc.version ?? 0,
  };
}
