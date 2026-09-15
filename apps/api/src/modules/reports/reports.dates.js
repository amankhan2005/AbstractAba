import { AppError } from '../../common/errors/AppError.js';

/**
 * Pure server-side date-range resolution for financial reports. Named presets
 * resolve against a supplied "now" (UTC) so results are deterministic and
 * testable. Custom ranges are validated (start < end, bounded span).
 */
const MAX_RANGE_DAYS = 366 * 2; // two years

export function resolveDateRange({ preset, start, end }, now = new Date()) {
  if (preset === 'custom' || (!preset && (start || end))) {
    const s = new Date(start); const e = new Date(end);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) throw AppError.validation('Invalid custom date range.');
    if (e <= s) throw AppError.validation('end date must be after start date.');
    if ((e - s) / 86400000 > MAX_RANGE_DAYS) throw AppError.validation('Date range too large.');
    return { from: s, to: e };
  }
  const y = now.getUTCFullYear(); const m = now.getUTCMonth(); const d = now.getUTCDate();
  const startOfDay = new Date(Date.UTC(y, m, d));
  switch (preset ?? 'this_month') {
    case 'today':
      return { from: startOfDay, to: new Date(startOfDay.getTime() + 86400000) };
    case 'this_week': {
      const dow = new Date(Date.UTC(y, m, d)).getUTCDay(); // 0=Sun
      const from = new Date(startOfDay.getTime() - dow * 86400000);
      return { from, to: new Date(from.getTime() + 7 * 86400000) };
    }
    case 'this_month':
      return { from: new Date(Date.UTC(y, m, 1)), to: new Date(Date.UTC(y, m + 1, 1)) };
    case 'last_month':
      return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) };
    case 'this_quarter': {
      const q = Math.floor(m / 3);
      return { from: new Date(Date.UTC(y, q * 3, 1)), to: new Date(Date.UTC(y, q * 3 + 3, 1)) };
    }
    default:
      throw AppError.validation(`Unknown date preset: ${preset}`);
  }
}

/**
 * Aging buckets for outstanding items. Pure. Each item has { amount, date }
 * (amount in minor units, date = invoice/claim reference date). Buckets are
 * 0-30, 31-60, 61-90, 90+ days relative to `now`.
 */
export function ageBuckets(items, now = new Date()) {
  const buckets = { current: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0 };
  for (const it of items) {
    const days = Math.floor((now - new Date(it.date)) / 86400000);
    const amt = it.amount || 0;
    if (days <= 30) buckets.current += amt;
    else if (days <= 60) buckets.d31_60 += amt;
    else if (days <= 90) buckets.d61_90 += amt;
    else buckets.d90_plus += amt;
    buckets.total += amt;
  }
  return buckets;
}
