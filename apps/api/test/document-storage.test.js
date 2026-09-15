import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decodeBase64Payload, assertWithinSizeLimit, assertAllowedMimeType,
  computeChecksum, validateUpload,
} from '../src/modules/documents/document.validation.js';
import { buildStorageKey, parseStorageKey, keyBelongsToTenant } from '../src/modules/documents/storage/storageKey.js';
import { LocalStorageAdapter } from '../src/modules/documents/storage/localStorageAdapter.js';

const ALLOWED = ['application/pdf', 'image/png', 'text/plain'];
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// ---------------- validation engine ----------------
test('decodeBase64Payload decodes and strips data-url prefix', () => {
  assert.equal(decodeBase64Payload(b64('hello')).toString('utf8'), 'hello');
  assert.equal(decodeBase64Payload(`data:text/plain;base64,${b64('hi')}`).toString('utf8'), 'hi');
});

test('decodeBase64Payload rejects empty and malformed input', () => {
  assert.throws(() => decodeBase64Payload(''), /required/);
  assert.throws(() => decodeBase64Payload('!!!not base64!!!'), /valid base64/);
  assert.throws(() => decodeBase64Payload('   '), /valid base64/);
});

test('assertWithinSizeLimit enforces the cap', () => {
  assert.doesNotThrow(() => assertWithinSizeLimit(100, 1000));
  assert.throws(() => assertWithinSizeLimit(2000, 1000), /maximum allowed size/);
  assert.throws(() => assertWithinSizeLimit(0, 1000), /Invalid file size/);
});

test('assertAllowedMimeType enforces the allowlist (case-insensitive, strips params)', () => {
  assert.equal(assertAllowedMimeType('application/pdf', ALLOWED), 'application/pdf');
  assert.equal(assertAllowedMimeType('TEXT/PLAIN; charset=utf-8', ALLOWED), 'text/plain');
  assert.throws(() => assertAllowedMimeType('application/x-msdownload', ALLOWED), /not allowed/);
  assert.throws(() => assertAllowedMimeType('', ALLOWED), /content type is required/);
});

test('computeChecksum is stable SHA-256 hex', () => {
  const c = computeChecksum(Buffer.from('abc'));
  assert.equal(c, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('validateUpload derives trusted descriptor, never trusting the client', () => {
  const { buffer, descriptor } = validateUpload(
    { base64: b64('hello world'), contentType: 'text/plain' },
    { maxBytes: 1000, allowedMimeTypes: ALLOWED },
  );
  assert.equal(buffer.toString('utf8'), 'hello world');
  assert.equal(descriptor.contentType, 'text/plain');
  assert.equal(descriptor.sizeBytes, 11);
  assert.equal(descriptor.checksum, computeChecksum(Buffer.from('hello world')));
});

test('validateUpload rejects disallowed type and oversized content', () => {
  assert.throws(() => validateUpload({ base64: b64('x'), contentType: 'application/evil' }, { maxBytes: 10, allowedMimeTypes: ALLOWED }), /not allowed/);
  const big = b64('x'.repeat(50));
  assert.throws(() => validateUpload({ base64: big, contentType: 'text/plain' }, { maxBytes: 10, allowedMimeTypes: ALLOWED }), /maximum allowed size/);
});

// ---------------- storage keys ----------------
test('buildStorageKey embeds tenant + document and is parseable', () => {
  const key = buildStorageKey({ tenantId: 't1', documentId: 'd1' });
  const parsed = parseStorageKey(key);
  assert.equal(parsed.tenantId, 't1');
  assert.equal(parsed.documentId, 'd1');
  assert.ok(parsed.random.length >= 8);
});

test('keyBelongsToTenant is the IDOR guard', () => {
  const key = buildStorageKey({ tenantId: 'tenant-A', documentId: 'd1' });
  assert.equal(keyBelongsToTenant(key, 'tenant-A'), true);
  assert.equal(keyBelongsToTenant(key, 'tenant-B'), false);
  assert.equal(keyBelongsToTenant('garbage', 'tenant-A'), false);
});

test('buildStorageKey requires tenant and document', () => {
  assert.throws(() => buildStorageKey({ tenantId: '', documentId: 'd1' }), /required/);
});

// ---------------- local adapter round-trip ----------------
test('LocalStorageAdapter put/get/remove round-trips and confines paths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docstore-'));
  const adapter = new LocalStorageAdapter({ baseDir: dir });
  const key = buildStorageKey({ tenantId: 't1', documentId: 'd1' });
  await adapter.put(key, Buffer.from('file bytes'), 'text/plain');
  const got = await adapter.get(key);
  assert.equal(got.buffer.toString('utf8'), 'file bytes');
  assert.equal(got.contentType, 'text/plain');
  await adapter.remove(key);
  await assert.rejects(() => adapter.get(key), /not found/);
});

test('LocalStorageAdapter rejects traversal / invalid keys', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docstore-'));
  const adapter = new LocalStorageAdapter({ baseDir: dir });
  await assert.rejects(() => adapter.get('../../etc/passwd'), /Invalid storage key/);
});
