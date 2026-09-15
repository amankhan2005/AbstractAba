import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealPhi, openPhi } from '../src/utils/phi.js';

test('sealPhi/openPhi round-trips a PHI value', () => {
  const plaintext = '123-45-6789';
  const sealed = sealPhi(plaintext);
  assert.notEqual(sealed, plaintext, 'sealed form must not equal plaintext');
  assert.equal(typeof sealed, 'string');
  assert.equal(openPhi(sealed), plaintext);
});

test('sealPhi is non-deterministic (fresh IV per call)', () => {
  const a = sealPhi('member-001');
  const b = sealPhi('member-001');
  assert.notEqual(a, b, 'two seals of the same value must differ');
  assert.equal(openPhi(a), 'member-001');
  assert.equal(openPhi(b), 'member-001');
});

test('openPhi rejects a tampered sealed value', () => {
  const sealed = sealPhi('sensitive');
  const [iv, ct, tag] = sealed.split('.');
  const flipped = ct[0] === 'A' ? 'B' : 'A';
  const tampered = `${iv}.${flipped}${ct.slice(1)}.${tag}`;
  assert.throws(() => openPhi(tampered), 'GCM auth tag must reject tampering');
});

test('sealPhi/openPhi pass null and undefined through unchanged', () => {
  assert.equal(sealPhi(null), null);
  assert.equal(sealPhi(undefined), undefined);
  assert.equal(openPhi(null), null);
  assert.equal(openPhi(undefined), undefined);
});
