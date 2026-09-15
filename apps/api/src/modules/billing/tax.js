/**
 * Tax abstraction. Phase 3.1 ships a safe zero-rate default. A real tax
 * provider (e.g. a tax-calculation service) plugs in here by replacing computeTax with
 * a provider-backed implementation; callers depend only on this signature.
 */
export function computeTax(/* { organizationId, subtotal, currency, address } */) {
  return 0; // no tax configured -> safe default
}
