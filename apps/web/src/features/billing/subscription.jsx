/**
 * Company SaaS subscription helpers (spec §1). The dedicated /subscription page
 * renders the organization's real assigned package from fetchMySubscription;
 * nothing here is hardcoded. Only the live countdown ticks client-side,
 * recomputed from the real renewal timestamp so it can never show a negative
 * or fabricated value.
 */
export const SUBSCRIPTION_STATUS_TONE = { ACTIVE: 'approved', EXPIRING_SOON: 'pending', EXPIRED: 'denied', TRIALING: 'info', PAST_DUE: 'pending', SUSPENDED: 'denied', CANCELED: 'draft' };
export const SUBSCRIPTION_STATUS_LABEL = { ACTIVE: 'Active', EXPIRING_SOON: 'Expiring soon', EXPIRED: 'Expired', TRIALING: 'Trial', PAST_DUE: 'Past due', SUSPENDED: 'Suspended', CANCELED: 'Canceled' };

export function countdownText(renewalDate) {
  if (!renewalDate) return null;
  const ms = new Date(renewalDate).getTime() - Date.now();
  if (ms <= 0) return null; // expired — caller shows the expired state instead
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d >= 1) return `${d} day${d === 1 ? '' : 's'} ${h} hour${h === 1 ? '' : 's'}`;
  if (h >= 1) return `${h} hour${h === 1 ? '' : 's'} ${m} minute${m === 1 ? '' : 's'}`;
  return `${m} minute${m === 1 ? '' : 's'} ${s % 60} second${s % 60 === 1 ? '' : 's'}`;
}

/**
 * Subscription price for DISPLAY: integer minor units → "$299" or "$299.50".
 * The Company Admin Subscription page always shows the dollar sign only — never
 * a currency code or name. The stored amount and currency are not changed.
 */
export function formatSubscriptionPrice(minor) {
  if (minor == null || !Number.isFinite(Number(minor))) return null;
  const cents = Math.round(Number(minor));
  const whole = cents % 100 === 0;
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** Whole days left until the renewal instant (0 once it has passed; null without a date). */
export function daysRemaining(renewalDate, now = Date.now()) {
  if (!renewalDate) return null;
  const ms = new Date(renewalDate).getTime() - now;
  return ms <= 0 ? 0 : Math.floor(ms / 86400000);
}

/** Share of the current billing period already elapsed, 0–100, or null when the period is unknown. */
export function periodProgress(startDate, renewalDate, now = Date.now()) {
  if (!startDate || !renewalDate) return null;
  const start = new Date(startDate).getTime();
  const end = new Date(renewalDate).getTime();
  if (!(end > start)) return null;
  return Math.min(100, Math.max(0, Math.round(((now - start) / (end - start)) * 100)));
}

/** "maxStaff" / "max_staff" → "Max staff". */
export const limitLabel = (key) => {
  const words = String(key).replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
