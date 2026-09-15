import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClientsService } from '../src/modules/clients/clients.service.js';
import { assignCareTeamSchema, careTeamParamsSchema } from '../src/modules/clients/clients.schemas.js';

/**
 * DB-free tests for the persistent care-team assignment. They lock in the
 * guarantees that matter: the ACTIVE gate applies to care-team writes, an
 * assignment is validated against a real, active staff member and a valid role,
 * duplicates are rejected, the client detail response carries the team, and the
 * downstream billing/payroll resolver returns a staff member's roles for a
 * client. The per-appointment assignment is a different code path and untouched.
 */

const ACTIVE_STAFF = { id: 'sp-1', status: 'ACTIVE', firstName: 'Rita', lastName: 'Bee', title: 'RBT', discipline: null };
const client = (over = {}) => ({ id: 'c-1', clientNumber: 'CL-1', firstName: 'Ada', lastName: 'Lovelace', status: 'ACTIVE', approvedWeeklyHours: 30, createdAt: new Date(), version: 1, sensitive: { ssn: null }, ...over });
const fakePhi = { seal: (v) => v, open: (v) => v };

function makeService({ state = 'ACTIVE', repo = {} } = {}) {
  const base = {
    findClientById: async () => client(),
    listGuardians: async () => [],
    listContacts: async () => [],
    findIntake: async () => null,
    listAssignments: async () => [],
    listServiceAuthorizations: async () => [],
    listMedicalEntries: async () => [],
    findStaffProfile: async () => ACTIVE_STAFF,
    addAssignment: async (_t, _c, input) => ({ id: 'a-1', clientId: 'c-1', ...input, staffName: 'Bee, Rita' }),
    findAssignmentById: async () => ({ id: 'a-1', clientId: 'c-1', staffProfileId: 'sp-1', role: 'RBT', status: 'ACTIVE', hourlyPayRate: 30, rateHistory: [{ rate: 30, effectiveDate: '2026-01-01' }] }),
    updateAssignment: async (_t, _id, patch, hist) => ({ id: 'a-1', clientId: 'c-1', role: 'RBT', status: patch.status ?? 'ACTIVE', hourlyPayRate: patch.hourlyPayRate ?? 30, weeklyAssignedHours: patch.weeklyAssignedHours ?? null, rateHistory: hist ? [{ rate: 30, effectiveDate: '2026-01-01' }, hist] : [{ rate: 30, effectiveDate: '2026-01-01' }] }),
    sumActiveAssignedHours: async () => 0,
    listCareTeamRecipients: async () => [
      { assignmentId: 'as-bcba', staffProfileId: 'sp-b', userId: 'u-bcba', role: 'BCBA', staffName: 'Owens, Dana' },
      { assignmentId: 'as-rbt', staffProfileId: 'sp-r', userId: 'u-rbt', role: 'RBT', staffName: 'Lee, Marcus' },
    ],
    removeAssignment: async () => {},
    rolesForStaffOnClient: async () => ['BCBA', 'RBT'],
    ...repo,
  };
  const dispatched = [];
  const svc = new ClientsService({ repository: base, organizations: { getById: async () => ({ state }) }, phi: fakePhi, notifications: { dispatch: async (type, ctx) => { dispatched.push({ type, ctx }); } } });
  svc.__dispatched = dispatched;
  return svc;
}

const okInput = { staffProfileId: '11111111-1111-1111-1111-111111111111', role: 'BCBA' };

test('assignCareTeam creates an assignment and stamps the actor', async () => {
  let received = null;
  const svc = makeService({ repo: { addAssignment: async (_t, _c, input) => { received = input; return { id: 'a-1', ...input }; } } });
  const out = await svc.assignCareTeam({ tenantId: 't-1', clientId: 'c-1', actorUserId: 'u-9', input: okInput });
  assert.equal(out.role, 'BCBA');
  assert.equal(received.staffProfileId, okInput.staffProfileId);
  assert.equal(received.createdBy, 'u-9');
  assert.equal(received.updatedBy, 'u-9');
});

test('assignCareTeam rejects an unknown staff member', async () => {
  const svc = makeService({ repo: { findStaffProfile: async () => null } });
  await assert.rejects(
    () => svc.assignCareTeam({ tenantId: 't-1', clientId: 'c-1', actorUserId: 'u-9', input: okInput }),
    /Staff member not found/,
  );
});

test('assignCareTeam rejects an inactive staff member', async () => {
  const svc = makeService({ repo: { findStaffProfile: async () => ({ ...ACTIVE_STAFF, status: 'INACTIVE' }) } });
  await assert.rejects(
    () => svc.assignCareTeam({ tenantId: 't-1', clientId: 'c-1', actorUserId: 'u-9', input: okInput }),
    /not active/,
  );
});

test('assignCareTeam enforces the ACTIVE organization gate', async () => {
  const svc = makeService({ state: 'PENDING_AGREEMENT' });
  await assert.rejects(
    () => svc.assignCareTeam({ tenantId: 't-1', clientId: 'c-1', actorUserId: 'u-9', input: okInput }),
    /active/i,
  );
});

test('assignCareTeam rejects assignment to a missing client', async () => {
  const svc = makeService({ repo: { findClientById: async () => null } });
  await assert.rejects(
    () => svc.assignCareTeam({ tenantId: 't-1', clientId: 'c-x', actorUserId: 'u-9', input: okInput }),
    /Client not found/,
  );
});

test('assignCareTeam surfaces a duplicate assignment from the repository', async () => {
  const svc = makeService({ repo: { addAssignment: async () => { const e = new Error('That staff member already holds that role for this client.'); throw e; } } });
  await assert.rejects(
    () => svc.assignCareTeam({ tenantId: 't-1', clientId: 'c-1', actorUserId: 'u-9', input: okInput }),
    /already holds that role/,
  );
});

test('listCareTeam requires the client and returns the assignments', async () => {
  const svc = makeService({ repo: { listAssignments: async () => [{ id: 'a-1', role: 'RBT', staffName: 'Bee, Rita' }] } });
  const rows = await svc.listCareTeam({ tenantId: 't-1', clientId: 'c-1' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'RBT');
});

test('removeCareTeam applies the ACTIVE gate and removes', async () => {
  let removed = false;
  const svc = makeService({ repo: { removeAssignment: async () => { removed = true; } } });
  await svc.removeCareTeam({ tenantId: 't-1', clientId: 'c-1', assignmentId: 'a-1', actorUserId: 'u-9' });
  assert.equal(removed, true);
});

test('getClient assembles the care team alongside guardians/contacts/intake', async () => {
  const svc = makeService({ repo: { listAssignments: async () => [{ id: 'a-1', role: 'MANAGER', staffName: 'Bee, Rita' }] } });
  const detail = await svc.getClient({ tenantId: 't-1', clientId: 'c-1' });
  assert.ok(Array.isArray(detail.careTeam));
  assert.equal(detail.careTeam[0].role, 'MANAGER');
});

test('rolesForStaffOnClient exposes the standing roles for downstream billing/payroll', async () => {
  const svc = makeService();
  const roles = await svc.rolesForStaffOnClient({ tenantId: 't-1', clientId: 'c-1', staffProfileId: 'sp-1' });
  assert.deepEqual(roles, ['BCBA', 'RBT']);
});

test('schema accepts a valid assignment and rejects an unknown role', () => {
  assert.equal(assignCareTeamSchema.safeParse(okInput).success, true);
  assert.equal(assignCareTeamSchema.safeParse({ ...okInput, role: 'DIRECTOR' }).success, false);
  assert.equal(assignCareTeamSchema.safeParse({ role: 'BCBA' }).success, false); // missing staffProfileId
  assert.equal(careTeamParamsSchema.safeParse({ clientId: okInput.staffProfileId, assignmentId: okInput.staffProfileId }).success, true);
});

// --- Phase 3 / spec Module 1+4: assignment is MEMBERSHIP only, no pay rate ----

test('assign RBT with weekly hours does NOT put any pay rate on the assignment (pay lives on staff PayRate)', async () => {
  let seen = null;
  const svc = makeService({ repo: { addAssignment: async (_t, _c, input) => { seen = input; return { id: 'a-1', clientId: 'c-1', ...input }; } } });
  // Even if a rate somehow reaches the service, the assignment must not own it:
  // compensation belongs to the staff PayRate model (spec Module 1/4 Part 31).
  const out = await svc.assignCareTeam({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', input: { staffProfileId: 'sp-1', role: 'RBT', weeklyAssignedHours: 20, hourlyPayRate: 32, effectiveStartDate: '2026-01-01' } });
  assert.equal(seen.weeklyAssignedHours, 20);
  assert.equal(seen.hourlyPayRate, null, 'assignment must not store a pay rate');
  assert.deepEqual(seen.rateHistory, [], 'assignment must not seed a rate history');
  assert.equal(out.role, 'RBT');
});

test('wrong-role staff is rejected via canonical roleKeys (rbt cannot take a BCBA seat)', async () => {
  const svc = makeService({ repo: { findStaffProfile: async () => ({ id: 'sp-1', status: 'ACTIVE', firstName: 'R', lastName: 'B', discipline: null, roleKeys: ['rbt'] }) } });
  await assert.rejects(
    () => svc.assignCareTeam({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', input: { staffProfileId: 'sp-1', role: 'BCBA' } }),
    (e) => e.code === 'ASSIGNMENT_ROLE_INELIGIBLE',
  );
});

test('role eligibility falls back to legacy discipline only when roleKeys are absent', async () => {
  const svc = makeService({ repo: { findStaffProfile: async () => ({ id: 'sp-1', status: 'ACTIVE', firstName: 'R', lastName: 'B', discipline: 'RBT' }) } });
  await assert.rejects(
    () => svc.assignCareTeam({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', input: { staffProfileId: 'sp-1', role: 'BCBA' } }),
    (e) => e.code === 'ASSIGNMENT_ROLE_INELIGIBLE',
  );
});

test('roleKeys win over a stale discipline (bcba roleKey is eligible for a BCBA seat even if discipline says RBT)', async () => {
  let created = false;
  const svc = makeService({ repo: {
    findStaffProfile: async () => ({ id: 'sp-1', status: 'ACTIVE', firstName: 'B', lastName: 'C', discipline: 'RBT', roleKeys: ['bcba'] }),
    addAssignment: async (_t, _c, input) => { created = true; return { id: 'a-1', clientId: 'c-1', ...input }; },
  } });
  await svc.assignCareTeam({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', input: { staffProfileId: 'sp-1', role: 'BCBA' } });
  assert.equal(created, true, 'canonical bcba roleKey must be accepted for a BCBA seat');
});

test('inactive staff is rejected', async () => {
  const svc = makeService({ repo: { findStaffProfile: async () => ({ id: 'sp-1', status: 'INACTIVE', firstName: 'X', lastName: 'Y', discipline: 'RBT' }) } });
  await assert.rejects(
    () => svc.assignCareTeam({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', input: { staffProfileId: 'sp-1', role: 'RBT' } }),
    (e) => e.code === 'STAFF_INACTIVE',
  );
});

test('capacity overrun is rejected (already 20 + new 20 > approved 30)', async () => {
  const svc = makeService({ repo: { sumActiveAssignedHours: async () => 20 } });
  await assert.rejects(
    () => svc.assignCareTeam({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', input: { staffProfileId: 'sp-1', role: 'RBT', weeklyAssignedHours: 20 } }),
    (e) => e.code === 'ASSIGNMENT_OVER_CAPACITY',
  );
});

test('the assign schema rejects hourlyPayRate outright (care team cannot carry pay)', async () => {
  // A strict schema is the API-boundary guarantee: no request can re-introduce a
  // pay rate onto a care-team assignment (spec Module 1/4 Parts 2/31).
  const parsed = assignCareTeamSchema.safeParse({ ...okInput, hourlyPayRate: 32 });
  assert.equal(parsed.success, false);
  assert.equal(
    parsed.error.issues.some((i) => i.code === 'unrecognized_keys' && (i.keys ?? []).includes('hourlyPayRate')),
    true,
    'hourlyPayRate must be rejected as an unrecognized key',
  );
});

test('updating an assignment never writes a rate-history entry (pay is not editable here)', async () => {
  let pushed = 'unset';
  const svc = makeService({ repo: { updateAssignment: async (_t, _id, _patch, hist) => { pushed = hist; return { id: 'a-1', clientId: 'c-1', weeklyAssignedHours: 10 }; } } });
  await svc.updateAssignment({ tenantId: 't', clientId: 'c-1', assignmentId: 'a-1', actorUserId: 'u', input: { weeklyAssignedHours: 10 } });
  assert.equal(pushed, null, 'update must pass a null rate-history entry — pay lives on staff PayRate');
});

test('resolveRateOnDate returns the rate effective on the service date', async () => {
  const { ClientsService } = await import('../src/modules/clients/clients.service.js');
  const assignment = { hourlyPayRate: 32, rateHistory: [
    { rate: 30, effectiveDate: '2026-01-01' },
    { rate: 32, effectiveDate: '2026-04-01' },
  ] };
  assert.equal(ClientsService.resolveRateOnDate(assignment, '2026-03-20'), 30, 'Mar 20 uses the Jan-1 rate');
  assert.equal(ClientsService.resolveRateOnDate(assignment, '2026-04-10'), 32, 'Apr 10 uses the Apr-1 rate');
});

test('end assignment sets ENDED and preserves the record', async () => {
  const svc = makeService();
  const out = await svc.endAssignment({ tenantId: 't', clientId: 'c-1', assignmentId: 'a-1', actorUserId: 'u', effectiveEndDate: '2026-05-01' });
  assert.equal(out.status, 'ENDED');
});

// --- Phase 7: care-team messaging (server-resolved recipients) --------------

test('messageCareTeam dispatches to all active care-team user ids via the notification framework', async () => {
  const svc = makeService();
  const out = await svc.messageCareTeam({ tenantId: 't', clientId: 'c-1', actorUserId: 'admin', message: 'Please review the new goals.' });
  assert.equal(out.recipientCount, 2);
  const d = svc.__dispatched;
  assert.equal(d.length, 1);
  assert.equal(d[0].type, 'care_team.message');
  assert.deepEqual([...d[0].ctx.recipientUserIds].sort(), ['u-bcba', 'u-rbt']);
  assert.equal(d[0].ctx.content.inAppBody, 'Please review the new goals.');
  assert.ok(d[0].ctx.content.link.includes('c-1'));
});

test('memberIds only NARROW the server-resolved recipients (cannot widen)', async () => {
  const svc = makeService();
  // ask for only the BCBA, plus a bogus id that is not on the team
  const out = await svc.messageCareTeam({ tenantId: 't', clientId: 'c-1', actorUserId: 'admin', message: 'hi', memberIds: ['as-bcba', 'not-a-member'] });
  assert.equal(out.recipientCount, 1);
  assert.deepEqual(svc.__dispatched[0].ctx.recipientUserIds, ['u-bcba']);
});

test('messaging a child with no active care team is rejected', async () => {
  const svc = makeService({ repo: { listCareTeamRecipients: async () => [] } });
  await assert.rejects(
    () => svc.messageCareTeam({ tenantId: 't', clientId: 'c-1', actorUserId: 'admin', message: 'hi' }),
    (e) => e.code === 'CARE_TEAM_EMPTY',
  );
  assert.equal(svc.__dispatched.length, 0, 'no dispatch when there is nobody to message');
});

test('selecting only non-members is rejected and dispatches nothing', async () => {
  const svc = makeService();
  await assert.rejects(
    () => svc.messageCareTeam({ tenantId: 't', clientId: 'c-1', actorUserId: 'admin', message: 'hi', memberIds: ['ghost-1'] }),
    (e) => e.code === 'CARE_TEAM_NO_RECIPIENTS',
  );
  assert.equal(svc.__dispatched.length, 0);
});

// --- one active BCBA + one active RBT per client (BR-CARE-ONE-PER-ROLE) ------

test('a second active BCBA is rejected while one is already active', async () => {
  const svc = makeService({ repo: {
    findStaffProfile: async () => ({ id: 'sp-2', status: 'ACTIVE', firstName: 'John', lastName: 'D', discipline: 'BCBA' }),
    listAssignments: async () => [{ id: 'a-b', role: 'BCBA', status: 'ACTIVE', staffProfileId: 'sp-b' }],
  } });
  await assert.rejects(
    () => svc.assignCareTeam({ tenantId: 't-1', clientId: 'c-1', actorUserId: 'u', input: { staffProfileId: '11111111-1111-1111-1111-111111111111', role: 'BCBA' } }),
    (e) => e.code === 'CLIENT_ALREADY_HAS_BCBA',
  );
});

test('a second active RBT is rejected while one is already active', async () => {
  const svc = makeService({ repo: {
    findStaffProfile: async () => ({ id: 'sp-2', status: 'ACTIVE', firstName: 'Dave', lastName: 'R', discipline: 'RBT' }),
    listAssignments: async () => [{ id: 'a-r', role: 'RBT', status: 'ACTIVE', staffProfileId: 'sp-r' }],
  } });
  await assert.rejects(
    () => svc.assignCareTeam({ tenantId: 't-1', clientId: 'c-1', actorUserId: 'u', input: { staffProfileId: '22222222-2222-2222-2222-222222222222', role: 'RBT' } }),
    (e) => e.code === 'CLIENT_ALREADY_HAS_RBT',
  );
});

test('a replacement BCBA is allowed once the current one is ended (history preserved via end, not delete)', async () => {
  // The previous BCBA assignment is ENDED, so it no longer counts as active.
  let added = null;
  const svc = makeService({ repo: {
    findStaffProfile: async () => ({ id: 'sp-2', status: 'ACTIVE', firstName: 'John', lastName: 'D', discipline: 'BCBA' }),
    listAssignments: async () => [{ id: 'a-b', role: 'BCBA', status: 'ENDED', staffProfileId: 'sp-old' }],
    addAssignment: async (_t, _c, input) => { added = input; return { id: 'a-new', ...input }; },
  } });
  const out = await svc.assignCareTeam({ tenantId: 't-1', clientId: 'c-1', actorUserId: 'u', input: { staffProfileId: '33333333-3333-3333-3333-333333333333', role: 'BCBA' } });
  assert.equal(out.role, 'BCBA');
  assert.equal(added.status, 'ACTIVE');
});

test('the one-per-role rule does not restrict non-BCBA/RBT roles', async () => {
  const svc = makeService({ repo: {
    findStaffProfile: async () => ({ id: 'sp-3', status: 'ACTIVE', firstName: 'M', lastName: 'G', discipline: null }),
    listAssignments: async () => [{ id: 'a-m', role: 'MANAGER', status: 'ACTIVE', staffProfileId: 'sp-m' }],
    addAssignment: async (_t, _c, input) => ({ id: 'a-2', ...input }),
  } });
  const out = await svc.assignCareTeam({ tenantId: 't-1', clientId: 'c-1', actorUserId: 'u', input: { staffProfileId: '44444444-4444-4444-4444-444444444444', role: 'MANAGER' } });
  assert.equal(out.role, 'MANAGER');
});
