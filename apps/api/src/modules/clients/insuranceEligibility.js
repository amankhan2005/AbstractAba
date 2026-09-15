import { AppError } from '../../common/errors/AppError.js';

/**
 * ---------------------------------------------------------------------------
 * CLIENT INSURANCE — GLOBAL-CATALOG ELIGIBILITY (spec Module 5.4 / 5.6, §14).
 *
 * The catalog picker in the browser only ever OFFERS eligible insurers, but a
 * disabled option is a courtesy, not a control: a company could POST any
 * catalog id straight to the API. So the same rule the picker uses to filter is
 * re-enforced here, on the server, before a coverage row that references a
 * global insurance company is written.
 *
 * The rule is a state intersection (spec 5.4): a company may reference a global
 * insurer only if at least one of the company's operating states is one of the
 * insurer's assigned states, AND the insurer is active. This module is the pure
 * decision — the coverage service supplies the catalog entry and the company's
 * states and lets these functions decide, which keeps the rule unit-testable
 * without a database and identical to the one the catalog read uses.
 * ---------------------------------------------------------------------------
 */

/** Normalise a list of state codes to an uppercase Set, ignoring blanks. */
function stateSet(states) {
  return new Set((Array.isArray(states) ? states : []).map((s) => String(s).trim().toUpperCase()).filter(Boolean));
}

/** True when the two state lists share at least one state (spec 5.4). */
export function statesIntersect(companyStates, insurerStates) {
  const wanted = stateSet(companyStates);
  if (wanted.size === 0) return false;
  return (Array.isArray(insurerStates) ? insurerStates : []).some((s) => wanted.has(String(s).trim().toUpperCase()));
}

/**
 * Assert that a company may reference a global catalog insurer, and return the
 * authoritative payer name to store.
 *
 * @param {object|null} catalogEntry  the catalog row (or null if it wasn't found)
 * @param {string[]}    companyStates the company's operating states (server-resolved)
 * @returns {{ payerName: string, catalogInsuranceId: string }}
 * @throws  AppError when the insurer is missing, inactive, or out of the
 *          company's states — the three ways a hand-crafted request tries to
 *          reference an insurance company it isn't entitled to.
 */
export function assertCatalogEligible(catalogEntry, companyStates) {
  if (!catalogEntry) {
    // 404-shaped: an id that resolves to nothing is indistinguishable from one
    // for another scope. We never confirm a catalog id exists to a caller that
    // can't use it.
    throw AppError.notFound('INSURANCE_CATALOG_NOT_FOUND', 'That insurance company isn’t available.');
  }
  if (catalogEntry.active === false || catalogEntry.deletedAt) {
    throw AppError.validation('That insurance company is no longer available. Choose another, or select “Other”.', {
      field: 'catalogInsuranceId',
    });
  }
  if (!statesIntersect(companyStates, catalogEntry.states)) {
    // 403, not 404: the record exists and is active, but this company is not in
    // any of its states, so it is not authorised to use it.
    throw AppError.forbidden('INSURANCE_NOT_ELIGIBLE', 'That insurance company isn’t available in your operating states.');
  }
  return { payerName: catalogEntry.name, catalogInsuranceId: catalogEntry.id ?? catalogEntry._id };
}
