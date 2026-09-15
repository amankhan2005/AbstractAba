import { describe, it, expect, afterEach, vi } from 'vitest';
import { formatTime, formatDateTime, formatDate, setDefaultTimeZone } from './format.js';

/**
 * Clock times must render in the ORGANIZATION timezone even where a screen calls
 * formatTime(v) / formatDateTime(v) without a zone (BCBA/RBT session cards,
 * lifecycle panel, scheduling). A manual session saved 10:15 AM → 11:45 AM in
 * New York must never read 7:45 PM (IST browser) or any other shifted time.
 */
const CLOCK_IN = '2026-09-14T14:15:00.000Z'; // 10:15 AM America/New_York
const CLOCK_OUT = '2026-09-14T15:45:00.000Z'; // 11:45 AM America/New_York

afterEach(() => setDefaultTimeZone(null));

describe('organization default timezone for clock times', () => {
  it('zone-less calls use the organization timezone', () => {
    setDefaultTimeZone('America/New_York');
    expect(formatTime(CLOCK_IN)).toBe('10:15 AM');
    expect(formatTime(CLOCK_OUT)).toBe('11:45 AM');
    expect(formatDateTime(CLOCK_IN)).toBe('09/14/2026 10:15 AM');
  });

  it('the date part follows the same zone (late-evening instant stays on its business date)', () => {
    setDefaultTimeZone('America/New_York');
    expect(formatDateTime('2026-09-15T03:30:00.000Z')).toBe('09/14/2026 11:30 PM');
  });

  it('an explicit zone always wins', () => {
    setDefaultTimeZone('America/New_York');
    expect(formatTime(CLOCK_IN, 'America/Los_Angeles')).toBe('7:15 AM');
    expect(formatDateTime(CLOCK_IN, 'UTC')).toBe('09/14/2026 2:15 PM');
  });

  it('calendar dates (YYYY-MM-DD) are never shifted, and formatDate is unchanged', () => {
    setDefaultTimeZone('Pacific/Kiritimati');
    expect(formatDate('2026-09-14')).toBe('09/14/2026');
  });

  it('no organization (operator / signed out) keeps the plain local render; invalid input is ignored', () => {
    setDefaultTimeZone(null);
    expect(formatTime(new Date(2026, 8, 14, 10, 15))).toBe('10:15 AM');
    setDefaultTimeZone('');
    expect(formatTime(new Date(2026, 8, 14, 10, 15))).toBe('10:15 AM');
  });
});

describe('auth store keeps the default in step with the principal', () => {
  it('sets the zone on sign-in and clears it on sign-out', async () => {
    vi.resetModules();
    vi.doMock('@/api/client', () => ({
      fetchMe: vi.fn(), setAccessToken: vi.fn(), signIn: vi.fn(), signOut: vi.fn(), clearSessionHint: vi.fn(),
      restoreSession: vi.fn(), hasRestorableSession: vi.fn(() => false), markSessionEstablished: vi.fn(),
    }));
    const { useAuthStore } = await import('@/auth/store');
    const fmt = await import('@/lib/format');
    useAuthStore.setState({ status: 'authenticated', principal: { organizationTimezone: 'America/New_York' } });
    expect(fmt.formatTime(CLOCK_IN)).toBe('10:15 AM');
    useAuthStore.setState({ status: 'authenticated', principal: { organizationTimezone: 'America/Los_Angeles' } });
    expect(fmt.formatTime(CLOCK_IN)).toBe('7:15 AM');
    useAuthStore.setState({ status: 'unauthenticated', principal: null });
    expect(fmt.formatTime(CLOCK_IN, 'UTC')).toBe('2:15 PM');
    fmt.setDefaultTimeZone(null);
    vi.doUnmock('@/api/client');
  });
});
