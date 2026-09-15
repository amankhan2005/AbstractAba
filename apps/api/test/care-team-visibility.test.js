import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentCareTeam, currentCareTeamByClient } from '../src/modules/clients/clients.careteam.js';

/**
 * Phase 3 — care-team visibility. The CURRENT care team shown for a child is the
 * single ACTIVE BCBA + single ACTIVE RBT. ENDED assignments are historical, not
 * current. Missing member → null (renders "Not assigned"), never undefined.
 */
const NAME = { 'sp-b': 'Chen, Sarah', 'sp-r': 'Ford, Michael', 'sp-b2': 'Old, Bcba' };
const nameOf = (id) => NAME[id] ?? null;

test('a child shows its current ACTIVE BCBA and RBT', () => {
  const team = currentCareTeam([
    { role: 'BCBA', staffProfileId: 'sp-b', status: 'ACTIVE' },
    { role: 'RBT', staffProfileId: 'sp-r', status: 'ACTIVE' },
  ], nameOf);
  assert.equal(team.bcba.name, 'Chen, Sarah');
  assert.equal(team.rbt.name, 'Ford, Michael');
});

test('BCBA sees the RBT and RBT sees the BCBA on the same child (same summary, both roles present)', () => {
  const team = currentCareTeam([
    { role: 'BCBA', staffProfileId: 'sp-b', status: 'ACTIVE' },
    { role: 'RBT', staffProfileId: 'sp-r', status: 'ACTIVE' },
  ], nameOf);
  assert.ok(team.bcba && team.rbt); // whichever role is viewing, both are visible
});

test('an ENDED assignment is NOT shown as current', () => {
  const team = currentCareTeam([
    { role: 'BCBA', staffProfileId: 'sp-b2', status: 'ENDED' },
    { role: 'BCBA', staffProfileId: 'sp-b', status: 'ACTIVE' },
  ], nameOf);
  assert.equal(team.bcba.staffProfileId, 'sp-b'); // the active one, not the ended one
});

test('missing role → null, never undefined ("Not assigned")', () => {
  const team = currentCareTeam([{ role: 'BCBA', staffProfileId: 'sp-b', status: 'ACTIVE' }], nameOf);
  assert.equal(team.rbt, null);
  assert.notEqual(team.rbt, undefined);
});

test('defensive one-per-role: a second ACTIVE BCBA does not replace the first in the summary', () => {
  const team = currentCareTeam([
    { role: 'BCBA', staffProfileId: 'sp-b', status: 'ACTIVE' },
    { role: 'BCBA', staffProfileId: 'sp-b2', status: 'ACTIVE' },
  ], nameOf);
  assert.equal(team.bcba.staffProfileId, 'sp-b'); // exactly one BCBA surfaced
});

test('MANAGER/THERAPIST roles are not part of the BCBA/RBT summary', () => {
  const team = currentCareTeam([{ role: 'MANAGER', staffProfileId: 'sp-b', status: 'ACTIVE' }], nameOf);
  assert.equal(team.bcba, null);
  assert.equal(team.rbt, null);
});

test('grouping: every requested child gets a team entry, scoped to its own assignments', () => {
  const map = currentCareTeamByClient(['c-1', 'c-2'], [
    { clientId: 'c-1', role: 'BCBA', staffProfileId: 'sp-b', status: 'ACTIVE' },
    { clientId: 'c-1', role: 'RBT', staffProfileId: 'sp-r', status: 'ACTIVE' },
    // c-2 has no assignments
  ], nameOf);
  assert.equal(map.get('c-1').bcba.name, 'Chen, Sarah');
  assert.equal(map.get('c-1').rbt.name, 'Ford, Michael');
  assert.deepEqual(map.get('c-2'), { bcba: null, rbt: null });
});
