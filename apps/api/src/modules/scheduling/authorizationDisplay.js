import { schedulingRepository } from './scheduling.repository.js';

/**
 * ---------------------------------------------------------------------------
 * Authorization DISPLAY resolver — the ONE place that turns an authorization id
 * (a legacy Authorization _id OR the unified `svc:<ServiceAuthorization._id>`
 * transport marker) into a normalized, user-facing object.
 *
 * It reuses schedulingRepository.findAuthorizationById — the single resolver
 * that already knows both collections — so no module re-implements
 * authorization lookup. The raw id is preserved as `id` (the internal option
 * value); a human `label` and the real business fields (payer, number, service,
 * units, dates) are added for display. This is the shared fix for a raw
 * `svc:<id>` ever leaking into the UI, used by both the BCBA session workflow
 * and the session-detail read.
 * ---------------------------------------------------------------------------
 */

/** Normalize one resolved authorization record (or a miss) into a display object. */
export function normalizeAuthorization(id, a) {
  if (!a) {
    // Unresolvable id — never surface the raw `svc:` marker as the label.
    return { id, label: 'Authorization', payerName: null, authorizationNumber: null, serviceCode: null, remainingUnits: null, status: null };
  }
  const service = a.serviceCode || a.serviceType || 'Service';
  const label = [service, a.payerName || null, a.authorizationNumber || null].filter(Boolean).join(' — ');
  return {
    id, // keep the internal id (may be `svc:<id>`) as the option value
    label: label || 'Authorization',
    payerName: a.payerName ?? null,
    authorizationNumber: a.authorizationNumber ?? null,
    serviceCode: service,
    serviceType: a.serviceType ?? null,
    authorizedUnits: a.authorizedUnits ?? null,
    remainingUnits: a.remainingUnits ?? null,
    startDate: a.startDate ?? null,
    endDate: a.endDate ?? null,
    status: a.status ?? null,
  };
}

/** Resolve many authorization ids to normalized display objects (order preserved). */
export async function resolveAuthorizations(tenantId, ids) {
  const out = [];
  for (const id of ids ?? []) {
    let a = null;
    try { a = await schedulingRepository.findAuthorizationById(tenantId, id); } catch { a = null; }
    out.push(normalizeAuthorization(id, a));
  }
  return out;
}
