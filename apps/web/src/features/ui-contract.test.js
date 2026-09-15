import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), 'utf8');

/**
 * These pin the wiring of features that are hard to exercise via pure units but
 * must not silently regress: they assert the corrected data paths exist in
 * source (same approach as toast-wiring.test.js).
 */

describe('approved weekly hours — editable and persisted', () => {
  const code = read('clients/redesign/ClientDetailRedesign.jsx');
  it('renders an editable approved-hours row (Add/Edit) not a static label', () => {
    expect(code).toMatch(/ApprovedHoursRow/);
    expect(code).not.toMatch(/label="Approved weekly hours" value=\{c\.approvedWeeklyHours/);
  });
  it('persists via updateClient with 0–168 validation and invalidates the query', () => {
    expect(code).toMatch(/updateClient\(clientId, \{ approvedWeeklyHours/);
    expect(code).toMatch(/n < 0 \|\| n > 168/);
    expect(code).toMatch(/invalidateQueries\(\{ queryKey: \['client', clientId\] \}\)/);
  });
});

describe('insurance billing — company-wide, date-range driven (no child selector)', () => {
  const code = read('claims/redesign/ClaimsRedesign.jsx');
  it('is "Insurance Billing" and loads the whole company by a From Date / To Date range', () => {
    expect(code).toMatch(/previewCompanyBilling/);
    expect(code).toMatch(/rx-st__title">Insurance Billing</);
    expect(code).toMatch(/<Field label="From Date"/);
    expect(code).toMatch(/<Field label="To Date"/);
    expect(code).toMatch(/<DateInput\b/);
  });
  it('shows the persisted Generated Bill with Download Excel / Download PDF', () => {
    expect(code).toMatch(/getGeneratedBill/);
    expect(code).toMatch(/Generated Bill</);
    expect(code).toMatch(/Download Excel</);
    expect(code).toMatch(/Download PDF</);
  });
  it('has NO child/client selector in the main workflow (spec §3)', () => {
    expect(code).not.toMatch(/label="Child"/);
    expect(code).not.toMatch(/<Select\b/);
    expect(code).not.toMatch(/listClients/);
  });
  it('bills BCBA and RBT separately and offers generation plus XLSX and PDF export', () => {
    expect(code).toMatch(/<RoleCharge role="BCBA"/);
    expect(code).toMatch(/<RoleCharge role="RBT"/);
    expect(code).toMatch(/generateCompanyBilling/);
    expect(code).toMatch(/downloadCompanyBillingXlsx/);
    expect(code).toMatch(/downloadCompanyBillingPdf/);
  });
  it('uses professional session terminology, never Clock In/Out, and no review or authorization-rate wording', () => {
    expect(code).toMatch(/Session start/);
    expect(code).toMatch(/Session end/);
    expect(code).not.toMatch(/Clock(ed)? ?In|Clock(ed)? ?Out/);
    expect(code).not.toMatch(/Needs review|require review|unit price|Insurance rate/i);
  });
});

describe('staff edit modal — premium modal, reset link, no password', () => {
  const code = read('staff/StaffEditModal.jsx');
  it('is a Modal with sections and a role badge', () => {
    expect(code).toMatch(/<Modal/);
    expect(code).toMatch(/rx-formsection/);
    expect(code).toMatch(/<Badge/);
  });
  it('offers an admin reset LINK and never shows a password', () => {
    expect(code).toMatch(/adminResetMemberPassword/);
    expect(code).toMatch(/Reset password/);
    expect(code).not.toMatch(/type=["']password["']/);
    expect(code).not.toMatch(/staff\.password/);
  });
  it('saves through the existing updateStaff endpoint with version', () => {
    expect(code).toMatch(/updateStaff\(staffId, body, staff\.version\)/);
  });
  it('is opened from the staff profile page', () => {
    const detail = read('staff/redesign/StaffProfileRedesign.jsx');
    expect(detail).toMatch(/StaffEditModal/);
    expect(detail).toMatch(/setEditing\(true\)/);
  });
});

describe('password management is surfaced for every role', () => {
  it('the shared shell links to Account & security', () => {
    const shell = read('../shells/ShellFrame.jsx');
    expect(shell).toMatch(/to="\/account"/);
    expect(shell).toMatch(/Account &amp; security/);
  });
});

describe('scheduling authorization selector', () => {
  const code = read('scheduling/redesign/SchedulingRedesign.jsx');
  it('offers ONE clinician per appointment via a type toggle + a single role-labelled select (spec §4/§17)', () => {
    // One appointment = one clinician: a BCBA/RBT TYPE toggle drives a single
    // select whose options come from the child's active care team for that role.
    expect(code).toMatch(/clinicianRole/);
    expect(code).toMatch(/setClinicianRole/);
    expect(code).toMatch(/aria-label="Clinician type"/);
    expect(code).toMatch(/label=\{roleWord\}/);
    expect(code).toMatch(/roleOpts\('BCBA'\)/);
    expect(code).toMatch(/roleOpts\('RBT'\)/);
    // The old two-select (BCBA + RBT on one appointment) layout is gone.
    expect(code).not.toMatch(/label="BCBA"/);
    expect(code).not.toMatch(/label="RBT"/);
  });
  it('loads the selected child\'s authorizations in every state (approval enforced at booking)', () => {
    // BUG #1 fix — no status filter here, so a just-created NOT_SENT/SENT
    // authorization is visible instead of a false "No Authorization". Only
    // APPROVED/ACTIVE ones are selectable; the backend re-enforces approval.
    expect(code).toMatch(/queryKey: \['authorizations', clientId\]/);
    expect(code).toMatch(/listAuthorizations\(\{ clientId, limit: 100 \}\)/);
    expect(code).not.toMatch(/listAuthorizations\(\{ clientId, status: 'ACTIVE'/);
    expect(code).toMatch(/enabled: Boolean\(clientId\)/);
  });
  it('allows selecting MULTIPLE authorizations via checkboxes', () => {
    expect(code).toMatch(/type="checkbox"/);
    expect(code).toMatch(/toggleAuth\(a\.id\)/);
    expect(code).toMatch(/authorizationIds\.includes\(a\.id\)/);
  });
  it('clears the chosen clinician and authorizations when the child changes', () => {
    expect(code).toMatch(/setClinicianId\(''\)/);
    expect(code).toMatch(/setAuthorizationIds\(\[\]\)/);
    expect(code).toMatch(/\}, \[clientId\]\)/);
  });
  it('shows a rich authorization label and requires a selection', () => {
    expect(code).toMatch(/authorizationLabel\(a\)/);
    expect(code).toMatch(/Please select at least one authorization\./);
  });
  it('sends the new booking contract in the payload (bcbaId, rbtId, authorizationIds)', () => {
    expect(code).toMatch(/buildBookingPayload\(\{ clientId, bcbaId, rbtId, authorizationIds/);
  });
  it('confirms success with "Appointment created successfully."', () => {
    expect(code).toMatch(/Appointment created successfully\./);
  });
});

describe('role panels are backend-branded (name + role label)', () => {
  for (const [file, label] of [['../shells/BcbaShell.jsx', 'BCBA Panel'], ['../shells/RbtShell.jsx', 'RBT Panel']]) {
    it(`${file} derives brand from fetchBranding and shows "${label}"`, () => {
      const code = read(file);
      expect(code).toMatch(/fetchBranding/);
      expect(code).toMatch(new RegExp(label));
      // never trusts a frontend-supplied tenant/org id for branding
      expect(code).not.toMatch(/organizationId:|tenantId:/);
    });
  }
});
