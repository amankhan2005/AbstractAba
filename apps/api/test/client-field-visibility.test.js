import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClientsService } from '../src/modules/clients/clients.service.js';
import {
  resolveViewer, redactAssignment, redactCareTeam, redactGuardians, applyClientDetailVisibility,
} from '../src/modules/clients/clients.visibility.js';

/**
 * REGRESSION — FIELD-LEVEL role-based serialization on the SERVER.
 *
 * Blueprint Parts 8/10/11/27/29: sensitive fields must be stripped in the API
 * response, never fetched to the browser and hidden in React.
 *   - Compensation (hourlyPayRate, rateHistory) → payroll-authorized only.
 *   - Guardian private contact (email/phone/address) → Company/front-desk only.
 *   - RBT (SELF) child view carries NO guardians/contacts at all.
 */

const fakePhi = {
  seal: (v) => (v == null ? v : `SEALED(${v})`),
  open: (v) => (v == null ? v : String(v).replace(/^SEALED\((.*)\)$/, '$1')),
};

const GUARDIAN = {
  id: 'g-1', clientId: 'c-1', firstName: 'Grace', lastName: 'Hopper',
  relationship: 'PARENT', isPrimary: true, phone: '555-0100', email: 'grace@example.com',
  address: '1 Navy Yard', notes: 'prefers evening calls',
};
const ASSIGNMENT = {
  id: 'a-1', clientId: 'c-1', staffProfileId: 'sp-1', role: 'RBT', isPrimary: true,
  weeklyAssignedHours: 20, hourlyPayRate: 42.5, effectiveStartDate: new Date('2026-01-01'),
  effectiveEndDate: null, status: 'ACTIVE',
  rateHistory: [{ rate: 42.5, effectiveDate: new Date('2026-01-01'), actorUserId: 'u-1', at: new Date() }],
  notes: null, staffName: 'Doe, Jane', staffTitle: 'RBT',
};

function makeService() {
  const repo = {
    findClientById: async () => ({ id: 'c-1', clientNumber: 'CL-1', firstName: 'Aman', lastName: 'Khan', status: 'ACTIVE', dateOfBirth: null, primaryGuardianId: null, createdAt: new Date(), version: 1, sensitive: { ssn: null } }),
    listGuardians: async () => [{ ...GUARDIAN }],
    listContacts: async () => [{ id: 'k-1', clientId: 'c-1', name: 'Emergency', contactType: 'EMERGENCY', phone: '555-0199' }],
    findIntake: async () => null,
    listAssignments: async () => [{ ...ASSIGNMENT }],
    listServiceAuthorizations: async () => [],
    listMedicalEntries: async () => [{ id: 'm-1', clientId: 'c-1', type: 'CONDITION', label: 'ADHD', status: 'ACTIVE', provider: 'Dr. Reed', notes: 'ny' }],
  };
  return new ClientsService({ repository: repo, organizations: { getById: async () => ({ state: 'ACTIVE' }) }, phi: fakePhi });
}

// A "viewer" mirrors ClientsController.viewerFrom(req).
const COMPANY = { scope: 'ORGANIZATION', canSeeCompensation: true };
const BCBA = { scope: 'TEAM', canSeeCompensation: false };
const RBT = { scope: 'SELF', canSeeCompensation: false };

// ---- pure helpers ----------------------------------------------------------

test('resolveViewer maps scope + payroll to field rules', () => {
  const org = resolveViewer(COMPANY);
  assert.deepEqual([org.canSeeCompensation, org.canSeeGuardianContact, org.canSeeGuardians], [true, true, true]);
  const team = resolveViewer(BCBA);
  assert.deepEqual([team.canSeeCompensation, team.canSeeGuardianContact, team.canSeeGuardians], [false, false, true]);
  const self = resolveViewer(RBT);
  assert.deepEqual([self.canSeeCompensation, self.canSeeGuardianContact, self.canSeeGuardians], [false, false, false]);
  // no viewer (internal caller) == full visibility, so service unit tests keep working
  const none = resolveViewer(undefined);
  assert.deepEqual([none.canSeeCompensation, none.canSeeGuardianContact, none.canSeeGuardians], [true, true, true]);
});

test('redactAssignment strips compensation only when unauthorized', () => {
  const kept = redactAssignment(ASSIGNMENT, resolveViewer(COMPANY));
  assert.equal(kept.hourlyPayRate, 42.5);
  assert.ok(Array.isArray(kept.rateHistory));
  const stripped = redactAssignment(ASSIGNMENT, resolveViewer(BCBA));
  assert.equal('hourlyPayRate' in stripped, false);
  assert.equal('rateHistory' in stripped, false);
  assert.equal(stripped.staffName, 'Doe, Jane'); // non-comp fields intact
  assert.equal(stripped.weeklyAssignedHours, 20);
});

test('redactGuardians: full for company, contact-stripped for BCBA, empty for RBT', () => {
  assert.equal(redactGuardians([GUARDIAN], resolveViewer(COMPANY))[0].email, 'grace@example.com');
  const bcba = redactGuardians([GUARDIAN], resolveViewer(BCBA))[0];
  assert.equal(bcba.firstName, 'Grace'); // identity kept as clinical context
  assert.equal(bcba.relationship, 'PARENT');
  for (const f of ['email', 'phone', 'address', 'notes']) assert.equal(f in bcba, false, `${f} must be stripped for BCBA`);
  assert.deepEqual(redactGuardians([GUARDIAN], resolveViewer(RBT)), []); // none for RBT
});

test('applyClientDetailVisibility never mutates its input', () => {
  const detail = { guardians: [GUARDIAN], careTeam: [ASSIGNMENT], contacts: [{ id: 'k-1' }] };
  const out = applyClientDetailVisibility(detail, RBT);
  assert.equal(detail.guardians[0].email, 'grace@example.com', 'original untouched');
  assert.deepEqual(out.guardians, []);
});

// ---- service integration ---------------------------------------------------

test('getClient(company viewer) returns compensation + full guardians', async () => {
  const detail = await makeService().getClient({ tenantId: 't', clientId: 'c-1', viewer: COMPANY });
  assert.equal(detail.careTeam[0].hourlyPayRate, 42.5);
  assert.equal(detail.guardians[0].email, 'grace@example.com');
});

test('getClient(BCBA viewer) hides compensation and guardian contact, keeps guardian identity', async () => {
  const detail = await makeService().getClient({ tenantId: 't', clientId: 'c-1', viewer: BCBA });
  assert.equal('hourlyPayRate' in detail.careTeam[0], false);
  assert.equal('rateHistory' in detail.careTeam[0], false);
  assert.equal(detail.guardians[0].firstName, 'Grace');
  assert.equal('email' in detail.guardians[0], false);
  assert.equal('phone' in detail.guardians[0], false);
});

test('getClient(RBT viewer) is minimal: no compensation, no guardians, no contacts', async () => {
  const detail = await makeService().getClient({ tenantId: 't', clientId: 'c-1', viewer: RBT });
  assert.equal('hourlyPayRate' in detail.careTeam[0], false);
  assert.deepEqual(detail.guardians, []);
  assert.deepEqual(detail.contacts, []);
});

test('getClient(no viewer) stays fully visible for internal callers', async () => {
  const detail = await makeService().getClient({ tenantId: 't', clientId: 'c-1' });
  assert.equal(detail.careTeam[0].hourlyPayRate, 42.5);
  assert.equal(detail.guardians[0].email, 'grace@example.com');
});

test('listCareTeam(RBT/BCBA viewer) strips pay rate; company keeps it', async () => {
  const svc = makeService();
  const asRbt = await svc.listCareTeam({ tenantId: 't', clientId: 'c-1', viewer: RBT });
  assert.equal('hourlyPayRate' in asRbt[0], false);
  const asCompany = await svc.listCareTeam({ tenantId: 't', clientId: 'c-1', viewer: COMPANY });
  assert.equal(asCompany[0].hourlyPayRate, 42.5);
});
