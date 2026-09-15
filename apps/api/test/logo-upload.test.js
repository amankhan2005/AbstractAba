import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateLogo,
  uploadLogo,
  cloudinaryConfigured,
  LOGO_MAX_BYTES,
  LOGO_FORMATS,
} from '../src/modules/theming/logo-upload.service.js';

/**
 * ---------------------------------------------------------------------------
 * COMPANY LOGO UPLOAD — contract.
 *
 * Cloudinary is not reachable from this environment, so these exercise
 * everything up to and including the request that WOULD be sent: validation,
 * signing, tenant foldering, and every failure path. `fetchImpl` is injected so
 * the transport is observable without a network.
 *
 * The bytes are validated by magic number rather than by declared content
 * type, because the resulting URL is served to every user of the tenant and a
 * client can label anything `image/png`.
 * ---------------------------------------------------------------------------
 */

const png = (extra = 0) => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(extra),
]);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const webp = () => Buffer.concat([
  Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii'), Buffer.alloc(32),
]);

// --- validation -------------------------------------------------------------

test('accepts the three raster formats a logo can safely be', () => {
  assert.equal(validateLogo(png(64)).mime, 'image/png');
  assert.equal(validateLogo(jpeg()).mime, 'image/jpeg');
  assert.equal(validateLogo(webp()).mime, 'image/webp');
  assert.deepEqual(LOGO_FORMATS, ['image/png', 'image/jpeg', 'image/webp']);
});

test('REGRESSION — SVG is refused even though it is an image', () => {
  // An SVG is an executable document. This file is served to every user of the
  // tenant, so accepting one would be stored XSS with a friendly file
  // extension. The message says so, because the refusal is surprising.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.throws(() => validateLogo(svg), /PNG, JPG or WebP/i);
  assert.throws(() => validateLogo(svg), /SVG/i);
});

test('REGRESSION — the DECLARED type is irrelevant; the bytes decide', () => {
  // A client can call anything image/png. Only the magic number is trusted.
  const html = Buffer.from('<!doctype html><script>alert(1)</script>');
  assert.throws(() => validateLogo(html), /PNG, JPG or WebP/i);

  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]);
  assert.throws(() => validateLogo(zip), /PNG, JPG or WebP/i);
});

test('an oversized image is refused with a size a user can act on', () => {
  assert.throws(() => validateLogo(png(LOGO_MAX_BYTES + 1)), /under 2 MB/i);
});

test('an empty or missing file is refused before anything else happens', () => {
  assert.throws(() => validateLogo(Buffer.alloc(0)), /choose an image/i);
  assert.throws(() => validateLogo(null), /choose an image/i);
});

// --- the request that would be sent -----------------------------------------

function fakeCloudinary(over = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: over.ok ?? true,
      json: async () => over.body ?? {
        secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/logo.png',
        public_id: 'aba1on1/tenants/org-1/logo',
      },
    };
  };
  return { impl, calls };
}

const withCredentials = async (fn) => {
  const { env } = await import('../src/config/env.js');
  const original = env.cloudinary;
  env.cloudinary = { cloudName: 'demo', apiKey: 'key', apiSecret: 'secret' };
  try { return await fn(); } finally { env.cloudinary = original; }
};

test('the asset is foldered per tenant, so one company cannot address another\u2019s', async () => {
  await withCredentials(async () => {
    const { impl, calls } = fakeCloudinary();
    await uploadLogo({ tenantId: 'org-1', buffer: png(64), fetchImpl: impl });

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /api\.cloudinary\.com\/v1_1\/demo\/image\/upload/);
    const form = calls[0].init.body;
    assert.equal(form.get('public_id'), 'aba1on1/tenants/org-1/logo');
    // Deterministic id + overwrite: a replacement replaces, rather than
    // accumulating orphaned files nobody ever deletes.
    assert.equal(form.get('overwrite'), 'true');
    assert.equal(form.get('invalidate'), 'true');
  });
});

test('REGRESSION — the API secret is signed with, never transmitted', async () => {
  await withCredentials(async () => {
    const { impl, calls } = fakeCloudinary();
    await uploadLogo({ tenantId: 'org-1', buffer: png(64), fetchImpl: impl });
    const form = calls[0].init.body;
    assert.equal(form.get('api_secret'), null, 'the secret must never be sent');
    assert.ok(form.get('signature'), 'a signature must be present');
    assert.equal(form.get('api_key'), 'key');
  });
});

test('the signature is deterministic for the same parameters', async () => {
  await withCredentials(async () => {
    const a = fakeCloudinary();
    const b = fakeCloudinary();
    await uploadLogo({ tenantId: 'org-1', buffer: png(64), fetchImpl: a.impl });
    await uploadLogo({ tenantId: 'org-1', buffer: png(64), fetchImpl: b.impl });
    const ts = a.calls[0].init.body.get('timestamp');
    if (ts === b.calls[0].init.body.get('timestamp')) {
      assert.equal(
        a.calls[0].init.body.get('signature'),
        b.calls[0].init.body.get('signature'),
      );
    }
  });
});

test('invalid bytes never reach the network', async () => {
  await withCredentials(async () => {
    const { impl, calls } = fakeCloudinary();
    await assert.rejects(
      () => uploadLogo({ tenantId: 'org-1', buffer: Buffer.from('<svg/>'), fetchImpl: impl }),
      /PNG, JPG or WebP/i,
    );
    assert.equal(calls.length, 0, 'validation runs before the upload');
  });
});

// --- failure paths ----------------------------------------------------------

test('REGRESSION — an unconfigured server says so instead of faking success', async () => {
  // A branding screen that reports success and then shows no logo is worse
  // than one that admits uploads are not set up.
  const { env } = await import('../src/config/env.js');
  const original = env.cloudinary;
  env.cloudinary = { cloudName: '', apiKey: '', apiSecret: '' };
  try {
    assert.equal(cloudinaryConfigured(), false);
    await assert.rejects(
      () => uploadLogo({ tenantId: 'org-1', buffer: png(64) }),
      /aren\u2019t set up/i,
    );
  } finally {
    env.cloudinary = original;
  }
});

test('an upstream rejection surfaces as plain language, not a status code', async () => {
  await withCredentials(async () => {
    const { impl } = fakeCloudinary({ ok: false });
    await assert.rejects(
      () => uploadLogo({ tenantId: 'org-1', buffer: png(64), fetchImpl: impl }),
      (err) => {
        assert.match(err.message, /couldn\u2019t save that image/i);
        assert.doesNotMatch(err.message, /4\d\d|5\d\d|cloudinary|api_key/i);
        return true;
      },
    );
  });
});

test('a network failure is never reported as a successful upload', async () => {
  await withCredentials(async () => {
    const impl = async () => { throw new Error('ECONNREFUSED'); };
    await assert.rejects(
      () => uploadLogo({ tenantId: 'org-1', buffer: png(64), fetchImpl: impl }),
      /couldn\u2019t reach the image service/i,
    );
  });
});

test('a response without a URL is a failure, not a silent success', async () => {
  await withCredentials(async () => {
    const { impl } = fakeCloudinary({ body: { message: 'ok but empty' } });
    await assert.rejects(
      () => uploadLogo({ tenantId: 'org-1', buffer: png(64), fetchImpl: impl }),
      /couldn\u2019t save that image/i,
    );
  });
});
