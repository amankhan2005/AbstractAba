import { describe, it, expect } from 'vitest';
import { formatPersonName, formatFullName, formatFirstName, formatDate, formatDateTime, todayLocalISO } from './format.js';

describe('formatPersonName', () => {
  it('title-cases each component regardless of input case', () => {
    expect(formatPersonName('aman khan')).toBe('Aman Khan');
    expect(formatPersonName('AMAN KHAN')).toBe('Aman Khan');
    expect(formatPersonName('aMAN kHaN')).toBe('Aman Khan');
  });
  it('collapses extra whitespace', () => {
    expect(formatPersonName('  aman   khan ')).toBe('Aman Khan');
  });
  it('handles hyphens and apostrophes per sub-component', () => {
    expect(formatPersonName('mary-jane')).toBe('Mary-Jane');
    expect(formatPersonName("o'brien")).toBe("O'Brien");
  });
  it('returns empty string for nullish/empty', () => {
    expect(formatPersonName(null)).toBe('');
    expect(formatPersonName(undefined)).toBe('');
    expect(formatPersonName('')).toBe('');
  });
});

describe('formatFullName', () => {
  it('joins and formats parts, skipping blanks', () => {
    expect(formatFullName({ firstName: 'aman', lastName: 'khan' })).toBe('Aman Khan');
    expect(formatFullName({ firstName: 'AMAN', middleName: '', lastName: 'KHAN' })).toBe('Aman Khan');
  });
});

describe('formatDate', () => {
  it('formats as MM/DD/YYYY', () => {
    expect(formatDate(new Date(2026, 7, 27))).toBe('08/27/2026');
    expect(formatDate(new Date(2026, 8, 8))).toBe('09/08/2026');
  });
  it('never yields undefined/NaN/Invalid Date', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
    expect(formatDate('not-a-date')).toBe('');
    expect(formatDate(NaN)).toBe('');
  });
});

describe('formatDateTime', () => {
  it('is empty for bad input', () => {
    expect(formatDateTime(null)).toBe('');
    expect(formatDateTime('nope')).toBe('');
  });
  it('starts with the MM/DD/YYYY date', () => {
    expect(formatDateTime(new Date(2026, 7, 27, 9, 5)).startsWith('08/27/2026')).toBe(true);
  });
});

describe('formatDate — DOB timezone safety', () => {
  it('never shifts a date-only string by timezone', () => {
    expect(formatDate('2005-08-27')).toBe('08/27/2005');
    expect(formatDate('2026-01-05')).toBe('01/05/2026');
    expect(formatDate('2026-12-31')).toBe('12/31/2026');
  });
  it('still formats full timestamps and Date objects', () => {
    expect(formatDate(new Date(2026, 7, 27))).toBe('08/27/2026');
  });
  it('safe on bad input', () => {
    expect(formatDate('nope')).toBe('');
    expect(formatDate(null)).toBe('');
  });
});

describe('todayLocalISO — dynamic default for date inputs', () => {
  it('returns today as YYYY-MM-DD from LOCAL calendar parts (not UTC, not hardcoded)', () => {
    const d = new Date();
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(todayLocalISO()).toBe(expected);
  });
  it('round-trips through formatDate to a MM/DD/YYYY string for today', () => {
    const d = new Date();
    const expected = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
    expect(formatDate(todayLocalISO())).toBe(expected);
  });
});

import { formatTime, formatDuration, formatMoney } from './format.js';

describe('formatTime — USA time', () => {
  it('renders h:mm AM/PM with no leading zero and no seconds', () => {
    expect(formatTime(new Date(2026, 8, 9, 17, 30))).toBe('5:30 PM');
    expect(formatTime(new Date(2026, 8, 9, 9, 5))).toBe('9:05 AM');
    expect(formatTime(new Date(2026, 8, 9, 0, 0))).toBe('12:00 AM');
  });
  it('honors an organization timezone (UTC instant → New York clock)', () => {
    // 2026-09-09T21:30:00Z is 5:30 PM in America/New_York (EDT, -4).
    expect(formatTime('2026-09-09T21:30:00Z', 'America/New_York')).toBe('5:30 PM');
  });
  it('is empty for nullish/invalid', () => {
    expect(formatTime(null)).toBe('');
    expect(formatTime('nope')).toBe('');
  });
});

describe('formatDuration — display "Xh YYm" (not decimal hours)', () => {
  it('formats minutes as Xh YYm', () => {
    expect(formatDuration(183)).toBe('3h 03m');
    expect(formatDuration(75)).toBe('1h 15m');
    expect(formatDuration(45)).toBe('45m');
    expect(formatDuration(150)).toBe('2h 30m');
    expect(formatDuration(0)).toBe('0m');
  });
  it('is empty for nullish/invalid', () => {
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(-5)).toBe('');
  });
});

describe('formatMoney — USD from cents, $ only', () => {
  it('formats integer cents as $X.XX', () => {
    expect(formatMoney(3000)).toBe('$30.00');
    expect(formatMoney(150)).toBe('$1.50');
    expect(formatMoney(56100)).toBe('$561.00');
  });
  it('never shows a literal USD', () => {
    expect(formatMoney(3000)).not.toMatch(/USD/);
  });
  it('is empty for nullish/invalid', () => {
    expect(formatMoney(null)).toBe('');
    expect(formatMoney('x')).toBe('');
  });
});

describe('sessionStatusText (manual sessions)', () => {
  it('a MANUAL completed session reads "Completed", never the review-flow "Approved"', async () => {
    const { sessionStatusText } = await import('./format.js');
    expect(sessionStatusText({ source: 'MANUAL', status: 'FROZEN' })).toBe('Completed');
    expect(sessionStatusText({ source: null, status: 'FROZEN' })).toBe('Approved');
    expect(sessionStatusText({ status: 'IN_PROGRESS' })).toBe('In progress');
  });
});

describe('formatFirstName (canonical first-name display)', () => {
  it('takes the first word of the persisted first name and capitalizes it', () => {
    expect(formatFirstName('test1 john')).toBe('Test1');
    expect(formatFirstName('test1')).toBe('Test1');
    expect(formatFirstName('  ANA  ')).toBe('Ana');
    expect(formatFirstName("mary-jane o'neil")).toBe('Mary-Jane');
  });
  it('is empty for missing input (never "undefined")', () => {
    expect(formatFirstName(null)).toBe('');
    expect(formatFirstName('   ')).toBe('');
  });
});
