import { describe, it, expect } from 'vitest';
import { statusLabel } from './format.js';

describe('statusLabel', () => {
  it('maps FROZEN to the business term "Approved" (approved/locked record)', () => {
    expect(statusLabel('FROZEN')).toBe('Approved');
  });
  it('maps IN_PROGRESS to "In progress"', () => {
    expect(statusLabel('IN_PROGRESS')).toBe('In progress');
  });
  it('maps DRAFT (a not-yet-started session) to "Scheduled"', () => {
    expect(statusLabel('DRAFT')).toBe('Scheduled');
  });
  it('maps the remaining known statuses', () => {
    expect(statusLabel('SUBMITTED')).toBe('Submitted');
    expect(statusLabel('CANCELLED')).toBe('Cancelled');
    expect(statusLabel('NO_SHOW')).toBe('No show');
    expect(statusLabel('COMPLETED')).toBe('Completed');
  });
  it('sentence-cases an unknown enum instead of leaking the raw token', () => {
    expect(statusLabel('WAITING_FOR_REVIEW')).toBe('Waiting for review');
  });
  it('never returns the raw upper-case token for a known status', () => {
    for (const s of ['FROZEN', 'IN_PROGRESS', 'SUBMITTED', 'DRAFT']) {
      expect(statusLabel(s)).not.toBe(s);
    }
  });
  it('degrades safely for nullish input', () => {
    expect(statusLabel(null)).toBe('—');
    expect(statusLabel(undefined)).toBe('—');
  });
});
