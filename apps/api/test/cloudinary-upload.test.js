import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signCloudinaryUpload, isCloudinaryConfigured } from '../src/utils/cloudinary.js';
import { CompanyInvitationService } from '../src/modules/company-invitations/company-invitation.service.js';

test('isCloudinaryConfigured requires all three values', () => {
  assert.equal(isCloudinaryConfigured(null), false);
  assert.equal(isCloudinaryConfigured({ cloudName: 'x' }), false);
  assert.equal(isCloudinaryConfigured({ cloudName: 'x', apiKey: 'y' }), false);
  assert.equal(isCloudinaryConfigured({ cloudName: 'x', apiKey: 'y', apiSecret: 'z' }), true);
});

test('signCloudinaryUpload throws a clear error when not configured (never fakes a signature)', () => {
  assert.throws(() => signCloudinaryUpload({ cloudName: '', apiKey: '', apiSecret: '' }, { folder: 'x' }), /not configured/);
});

test('signCloudinaryUpload produces a signature matching Cloudinary\'s documented algorithm', () => {
  const config = { cloudName: 'demo-cloud', apiKey: 'demo-key', apiSecret: 'demo-secret' };
  const result = signCloudinaryUpload(config, { folder: 'company-onboarding-logos/abc123' });

  assert.equal(result.cloudName, 'demo-cloud');
  assert.equal(result.apiKey, 'demo-key');
  assert.equal(result.folder, 'company-onboarding-logos/abc123');
  assert.equal(typeof result.timestamp, 'number');
  assert.ok(result.timestamp > 0);

  // Independently recompute the expected signature the same way Cloudinary's
  // own server does, and confirm ours matches byte-for-byte — this is the
  // exact contract Cloudinary checks on upload, so any drift here (wrong key
  // order, wrong join character, secret placement) would silently break
  // every real upload without a code-level test ever catching it.
  const expectedParamString = `folder=${result.folder}&timestamp=${result.timestamp}`;
  const expectedSignature = crypto.createHash('sha1').update(`${expectedParamString}${config.apiSecret}`).digest('hex');
  assert.equal(result.signature, expectedSignature);
});

test('signCloudinaryUpload never leaks the api secret in its output', () => {
  const config = { cloudName: 'demo-cloud', apiKey: 'demo-key', apiSecret: 'super-secret-value' };
  const result = signCloudinaryUpload(config, { folder: 'x' });
  assert.ok(!JSON.stringify(result).includes('super-secret-value'));
});

test('CompanyInvitationService.logoUploadSignature is gated by the same valid-token check as preview()/accept()', async () => {
  const svc = new CompanyInvitationService({
    organizationService: {},
    jobQueue: {},
    usersRepository: {},
    cloudinaryConfig: { cloudName: 'demo-cloud', apiKey: 'demo-key', apiSecret: 'demo-secret' },
  });
  svc.resolveActive = async () => { throw new Error('invalid or expired token'); };
  await assert.rejects(() => svc.logoUploadSignature('bad-token'), /invalid or expired/);
});

test('CompanyInvitationService.logoUploadSignature fails loudly (503) when Cloudinary is not configured, never fakes it', async () => {
  const svc = new CompanyInvitationService({
    organizationService: {},
    jobQueue: {},
    usersRepository: {},
    cloudinaryConfig: null,
  });
  await assert.rejects(
    () => svc.logoUploadSignature('any-token'),
    (err) => err.status === 503 && err.code === 'CLOUDINARY-503',
  );
});

test('CompanyInvitationService.logoUploadSignature scopes the upload folder to this invitation only', async () => {
  const svc = new CompanyInvitationService({
    organizationService: {},
    jobQueue: {},
    usersRepository: {},
    cloudinaryConfig: { cloudName: 'demo-cloud', apiKey: 'demo-key', apiSecret: 'demo-secret' },
  });
  svc.resolveActive = async () => ({ email: 'a@b.co' }); // token is valid
  const a = await svc.logoUploadSignature('token-a');
  const b = await svc.logoUploadSignature('token-b');
  assert.notEqual(a.folder, b.folder, 'two different invitations must never share an upload folder');
});
