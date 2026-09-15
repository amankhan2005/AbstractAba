/**
 * Plain-language company status — the Super Admin console must never show a
 * non-technical reader raw lifecycle codes like PROVISIONING or SUSPENDED.
 * This maps the backend organization state to a friendly label, a soft badge
 * tone, and a coarse filter group. Display only: the backend state is never
 * changed here.
 */
function titleCase(s) {
  return String(s ?? '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export function companyStatus(state) {
  switch (state) {
    case 'ACTIVE': return { label: 'Active', tone: 'ok', group: 'active' };
    case 'SUSPENDED': return { label: 'Deactivated', tone: 'off', group: 'deactivated' };
    case 'PROVISIONING':
    case 'PENDING_AGREEMENT': return { label: 'Pending invitation', tone: 'info', group: 'pending' };
    case 'OFFBOARDING': return { label: 'Closing', tone: 'warn', group: 'other' };
    case 'DESTROYED': return { label: 'Closed', tone: 'off', group: 'other' };
    default: return { label: state ? titleCase(state) : 'Unknown', tone: 'info', group: 'other' };
  }
}

/** The user-facing filter chips, in display order. */
export const COMPANY_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'deactivated', label: 'Deactivated' },
  { key: 'pending', label: 'Pending invitation' },
];

export function matchesCompanyFilter(state, filterKey) {
  if (!filterKey || filterKey === 'all') return true;
  return companyStatus(state).group === filterKey;
}
