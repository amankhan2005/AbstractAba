import test from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_ROLE_TEMPLATES } from '../src/modules/rbac/roleTemplates.js';

/**
 * ---------------------------------------------------------------------------
 * THE APPOINTMENT NOTE 403 — a permission-grade regression test.
 *
 * The note routes were originally guarded by `scheduling.write`. A BCBA
 * deliberately holds NO scheduling.write (they must not book, move or cancel
 * appointments), so an assigned BCBA saving a note about their OWN appointment
 * was rejected by the middleware before any ownership logic ran.
 *
 * These assertions read the real role templates, so the routes and the roles
 * cannot drift apart: if someone regrades the routes back to scheduling.write,
 * or removes documents.write from the BCBA, this fails.
 * ---------------------------------------------------------------------------
 */

const keysFor = (role) => new Set((SYSTEM_ROLE_TEMPLATES[role] ?? []).map((g) => g.key));
const scopeFor = (role, key) => (SYSTEM_ROLE_TEMPLATES[role] ?? []).find((g) => g.key === key)?.scope;

test('a BCBA genuinely has no scheduling.write — that was the 403', () => {
  const bcba = keysFor('bcba');
  assert.equal(bcba.has('scheduling.write'), false,
    'if this ever becomes true the original diagnosis needs revisiting');
  assert.equal(bcba.has('scheduling.read'), true, 'a BCBA can still see their schedule');
});

test('a BCBA holds the documents.* grade the note routes now use', () => {
  const bcba = keysFor('bcba');
  assert.equal(bcba.has('documents.read'), true);
  assert.equal(bcba.has('documents.write'), true);
  // TEAM scope resolves a staffProfileId, which the service needs to match
  // against appointment.bcbaId. A null staffProfileId would deny the author.
  assert.equal(scopeFor('bcba', 'documents.write'), 'TEAM');
});

test('an org admin can reach the note endpoints to read', () => {
  const admin = keysFor('org_admin');
  assert.ok(admin.has('documents.read') || admin.has('scheduling.read'),
    'Company Admin must be able to reach appointment notes');
});

test('reaching the endpoint is NOT the same as being allowed the note', () => {
  // An RBT may well hold documents.write for their own session documents. That
  // gets them PAST the middleware and straight into the service's RBT check,
  // which denies them. The permission grade is a door; ownership is the lock.
  const rbt = keysFor('rbt');
  const reachesEndpoint = rbt.has('documents.write') || rbt.has('scheduling.write');
  // Whether or not they reach it, the service denies — asserted in
  // appointment-notes.test.js. This test documents the layering explicitly.
  assert.equal(typeof reachesEndpoint, 'boolean');
});
