import { describe, it, expect, vi, afterEach } from 'vitest';
import { countdownText } from './BillingPage.jsx';

/**
 * Spec §10/§25 — the company Billing countdown formatter. Time is mocked so the
 * boundaries (days/hours/minutes, expiry) are deterministic. The backend owns
 * the authoritative remaining time; this only formats a future timestamp and
 * returns null once it has passed (the page then shows "Subscription Expired").
 */
const NOW = new Date('2026-09-04T12:00:00Z').getTime();
afterEach(() => vi.useRealTimers());
const at = () => { vi.useFakeTimers(); vi.setSystemTime(NOW); };

describe('countdownText', () => {
  it('shows days + hours when more than a day remains', () => {
    at();
    expect(countdownText(new Date(NOW + 29 * 86400000 + 5 * 3600000))).toBe('29 days 5 hours');
  });
  it('shows hours + minutes under a day', () => {
    at();
    expect(countdownText(new Date(NOW + 12 * 3600000 + 30 * 60000))).toBe('12 hours 30 minutes');
  });
  it('returns null once the renewal date has passed (no negative countdown)', () => {
    at();
    expect(countdownText(new Date(NOW - 1000))).toBeNull();
    expect(countdownText(new Date(NOW))).toBeNull();
  });
  it('returns null when there is no renewal date (empty state)', () => {
    expect(countdownText(null)).toBeNull();
  });
});
