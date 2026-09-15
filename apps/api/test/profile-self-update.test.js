import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateMeSchema } from '../src/modules/auth/auth.controller.js';

/**
 * Self-profile update contract (spec §14). The endpoint edits only the user's
 * display name; email is immutable. The schema is `.strict()`, so the request
 * body physically cannot carry an email (or any other field) — the boundary
 * itself blocks it, before the handler runs. Identity is taken from the token
 * in the handler, never the body, so there is no userId field to spoof either.
 */

test('accepts a first + last name', () => {
  const r = updateMeSchema.safeParse({ firstName: 'Aman', lastName: 'Verma' });
  assert.equal(r.success, true);
  assert.deepEqual(r.data, { firstName: 'Aman', lastName: 'Verma' });
});

test('rejects an attempt to change email (immutable) — strict schema', () => {
  const r = updateMeSchema.safeParse({ firstName: 'Aman', lastName: 'Verma', email: 'new@example.com' });
  assert.equal(r.success, false);
});

test('rejects a spoofed userId in the body (identity comes from the token)', () => {
  const r = updateMeSchema.safeParse({ firstName: 'A', lastName: 'B', userId: 'someone-else' });
  assert.equal(r.success, false);
});

test('requires non-empty names', () => {
  assert.equal(updateMeSchema.safeParse({ firstName: '', lastName: 'B' }).success, false);
  assert.equal(updateMeSchema.safeParse({ firstName: 'A' }).success, false);
});
