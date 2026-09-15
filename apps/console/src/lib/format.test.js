import { describe, it, expect } from 'vitest';
import { formatPersonName, formatFullName, formatDate, formatDateTime } from './format.js';

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
