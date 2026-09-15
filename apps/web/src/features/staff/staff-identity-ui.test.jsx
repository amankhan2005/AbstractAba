import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Phase 1 §6/§7/§10 UI contract for staff identity. Source-level assertions
 * (same style as ui-contract): Employee ID is read-only and never sent from the
 * client; email is editable and routed through the update; name inputs are
 * First → Middle → Last.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), 'utf8');
const modal = read('StaffEditModal.jsx');
const wizard = read('redesign/AddStaffForm.jsx');

describe('StaffEditModal identity fields', () => {
  it('shows Employee ID as read-only (disabled) and never edits it', () => {
    expect(modal).toMatch(/label="Employee ID"[^]*?disabled readOnly/);
    expect(modal).not.toMatch(/onChange=\{set\('employeeNumber'\)\}/);
    // employeeNumber must not be in the update-body field loop.
    const loop = /for \(const k of \[([^\]]*)\]\)/.exec(modal);
    expect(loop && loop[1]).not.toMatch(/employeeNumber/);
  });
  it('makes email an editable field that is sent only when changed', () => {
    expect(modal).toMatch(/label="Email"[^]*onChange=\{set\('email'\)\}/);
    expect(modal).toMatch(/body\.email = nextEmail/);
  });
  it('collects names in First → Middle → Last order', () => {
    const iFirst = modal.indexOf('label="First name"');
    const iMiddle = modal.indexOf('label="Middle name"');
    const iLast = modal.indexOf('label="Last name"');
    expect(iFirst).toBeGreaterThan(-1);
    expect(iMiddle).toBeGreaterThan(iFirst);
    expect(iLast).toBeGreaterThan(iMiddle);
  });
});

describe('AddStaffForm (create) identity fields', () => {
  it('does not collect or send an Employee ID (server-generated)', async () => {
    expect(wizard).not.toMatch(/set\('employeeNumber'\)|label="Employee ID"/);
    const { buildCreateStaffBody } = await import('./redesign/AddStaffForm.jsx');
    const body = buildCreateStaffBody({ roleKey: 'rbt', firstName: 'A', middleName: '', lastName: 'B', email: 'a@b.co', startDate: '', hourlyPayRate: '', employeeNumber: 'EMP-1' });
    expect(body).not.toHaveProperty('employeeNumber');
  });
  it('has a Middle name input between First and Last', () => {
    const iFirst = wizard.indexOf('label="First name"');
    const iMiddle = wizard.indexOf('label="Middle name"');
    const iLast = wizard.indexOf('label="Last name"');
    expect(iMiddle).toBeGreaterThan(iFirst);
    expect(iLast).toBeGreaterThan(iMiddle);
  });
});
