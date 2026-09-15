/**
 * Plain-language labels + badge tones for every backend code the console
 * displays (invoice / payment / subscription / invitation / member / audit /
 * health). Display only — the codes themselves are never changed or sent back.
 * Tones: ok (green) · warn (amber) · off (red) · info (blue) · neutral (grey).
 */

/** "PAST_DUE" → "Past due", "billing.invoice_generated" → "Invoice generated". */
export function humanizeCode(code) {
  if (code == null || code === '') return '';
  const s = String(code).replace(/[._-]+/g, ' ').trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function lookup(map, code) {
  return map[code] ?? { label: humanizeCode(code) || 'Unknown', tone: 'neutral' };
}

const INVOICE = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  OPEN: { label: 'Open', tone: 'info' },
  PAID: { label: 'Paid', tone: 'ok' },
  VOID: { label: 'Void', tone: 'neutral' },
  UNCOLLECTIBLE: { label: 'Uncollectible', tone: 'off' },
  PAST_DUE: { label: 'Past due', tone: 'warn' },
};
export const invoiceStatus = (code) => lookup(INVOICE, code);

const PAYMENT = {
  SUCCEEDED: { label: 'Received', tone: 'ok' },
  PENDING: { label: 'Pending', tone: 'info' },
  FAILED: { label: 'Failed', tone: 'off' },
  REFUNDED: { label: 'Refunded', tone: 'neutral' },
};
export const paymentStatus = (code) => lookup(PAYMENT, code);

const METHOD = { BANK_TRANSFER: 'Bank transfer', CHECK: 'Check', CASH: 'Cash', OTHER: 'Other', CARD: 'Card' };
export const paymentMethodLabel = (code) => METHOD[code] ?? humanizeCode(code);

const SUBSCRIPTION = {
  ACTIVE: { label: 'Active', tone: 'ok' },
  TRIALING: { label: 'Trial', tone: 'info' },
  EXPIRING_SOON: { label: 'Expiring soon', tone: 'warn' },
  PAST_DUE: { label: 'Past due', tone: 'warn' },
  EXPIRED: { label: 'Expired', tone: 'off' },
  SUSPENDED: { label: 'Suspended', tone: 'off' },
  CANCELED: { label: 'Canceled', tone: 'neutral' },
};
export const subscriptionStatus = (code) => lookup(SUBSCRIPTION, code);

const INVITATION = {
  PENDING: { label: 'Pending', tone: 'info' },
  ACCEPTED: { label: 'Accepted', tone: 'ok' },
  EXPIRED: { label: 'Expired', tone: 'warn' },
  REVOKED: { label: 'Revoked', tone: 'neutral' },
};
export const invitationStatus = (code) => lookup(INVITATION, code);

const MEMBER = {
  ACTIVE: { label: 'Active', tone: 'ok' },
  INVITED: { label: 'Invited', tone: 'info' },
  PENDING: { label: 'Pending', tone: 'info' },
  SUSPENDED: { label: 'Suspended', tone: 'off' },
  DISABLED: { label: 'Disabled', tone: 'off' },
  REMOVED: { label: 'Removed', tone: 'neutral' },
  LOCKED: { label: 'Locked', tone: 'warn' },
};
export const memberStatus = (code) => lookup(MEMBER, code);

/** Role names come from the server (`roles[].name`); fall back to a humanized key. */
export function memberRoles(member) {
  const roles = Array.isArray(member?.roles) ? member.roles : [];
  const names = roles.map((r) => (typeof r === 'string' ? humanizeCode(r) : (r?.name || humanizeCode(r?.key)))).filter(Boolean);
  if (names.length) return names;
  if (Array.isArray(member?.roleKeys)) return member.roleKeys.map(humanizeCode);
  return [];
}

/** "billing.payment_recorded" → { area: "Billing", action: "Payment recorded" }. */
export function auditAction(code) {
  const raw = String(code ?? '');
  const dot = raw.indexOf('.');
  if (dot === -1) return { area: '', action: humanizeCode(raw) || 'Event' };
  return { area: humanizeCode(raw.slice(0, dot)), action: humanizeCode(raw.slice(dot + 1)) };
}

export function auditOutcome(outcome) {
  if (outcome === 'success') return { label: 'Success', tone: 'ok' };
  if (outcome === 'failure' || outcome === 'denied') return { label: humanizeCode(outcome), tone: 'off' };
  return { label: humanizeCode(outcome) || 'Unknown', tone: 'neutral' };
}

export function healthStatus(status) {
  if (status === 'up' || status === 'ok') return { label: 'Operational', tone: 'ok' };
  if (status === 'degraded') return { label: 'Degraded', tone: 'warn' };
  if (status === 'down') return { label: 'Down', tone: 'off' };
  return { label: humanizeCode(status) || 'Unknown', tone: 'neutral' };
}

/** Uptime seconds → "3d 4h", "2h 5m", "45s". */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
