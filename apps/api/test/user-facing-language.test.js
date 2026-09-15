import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * ---------------------------------------------------------------------------
 * USER-FACING LANGUAGE.
 *
 * Found by running the actual server and reading what it returns, not by
 * reading the code: `GET /api/v1/auth/me` with no credentials answered
 *
 *     401  AUTH-401  "Missing bearer token"
 *
 * and every guarded route in the application answered the same way, because
 * they all pass through one `authenticate` middleware. That string is an
 * accurate description of the HTTP problem and a useless one to a clinician:
 * it names a mechanism they have never heard of and tells them nothing to do
 * about it. It is also the exact phrase the blueprint calls out as
 * unacceptable to surface.
 *
 * The CODE is unchanged — AUTH-401 still appears in logs, and the web client's
 * refresh interceptor keys off the status rather than the prose.
 *
 * This test reads the source because the leak is in string literals, and a
 * request-level test would only catch the handful of routes it happened to
 * call. The vocabulary below is the blueprint's own list of things a user must
 * never be shown.
 * ---------------------------------------------------------------------------
 */

/** Phrases that are implementation vocabulary, never user vocabulary. */
const FORBIDDEN = [
  /\bbearer token\b/i,
  /\btenantId\b/,
  /\bMongoDB\b/i,
  /\bmongoose\b/i,
  /\bObjectId\b/,
  /\bunprocessable entity\b/i,
  /\bmembership validation failed\b/i,
];

/**
 * Files whose strings are not user-facing: internal invariants that indicate a
 * programming error rather than something a user did, and which should keep
 * naming the mechanism precisely so the log is useful.
 */
const NOT_USER_FACING = [
  join('tenancy', 'tenantContext.js'),
  join('tenancy', 'tenantPlugin.js'),
  join('config', 'db.js'),
  join('config', 'env.js'),
  // Guard clauses raised while BUILDING a storage key. These fire only on a
  // programming error, never in response to anything a user did, and should
  // keep naming the missing argument precisely so the log is actionable.
  join('bulk', 'exportKey.js'),
  join('documents', 'storage', 'storageKey.js'),
];

function sourceFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith('.js')) acc.push(full);
  }
  return acc;
}

/** String literals passed as a message to an AppError factory. */
function messageLiterals(source) {
  const found = [];
  const pattern = /AppError\.(?:unauthorized|forbidden|notFound|validation|conflict)\(\s*(?:'[^']*'\s*,\s*)?'([^']{4,})'/g;
  let match;
  while ((match = pattern.exec(source)) !== null) found.push(match[1]);
  return found;
}

test('REGRESSION — no AppError message shown to a user names an internal mechanism', () => {
  const offenders = [];
  for (const file of sourceFiles(srcDir)) {
    if (NOT_USER_FACING.some((suffix) => file.endsWith(suffix))) continue;
    for (const message of messageLiterals(readFileSync(file, 'utf8'))) {
      const bad = FORBIDDEN.find((rx) => rx.test(message));
      if (bad) offenders.push(`${file.replace(srcDir, 'src')}: "${message}"`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `These messages reach users and name internal machinery:\n  ${offenders.join('\n  ')}`,
  );
});

test('REGRESSION — the authenticate middleware speaks plainly', () => {
  // Every guarded route in the application funnels through this one file, so a
  // leak here is a leak everywhere. This was the actual defect.
  const source = readFileSync(join(srcDir, 'middleware', 'authenticate.js'), 'utf8');
  const messages = messageLiterals(source);

  assert.ok(messages.length > 0, 'expected authenticate to raise user-facing errors');
  for (const message of messages) {
    assert.doesNotMatch(message, /bearer/i, `"${message}" names a mechanism no clinician knows`);
    assert.doesNotMatch(message, /\btoken\b/i, `"${message}" names a mechanism no clinician knows`);
  }

  // The code is retained for logs and for the client's refresh interceptor.
  assert.match(source, /AUTH-401/, 'the machine-readable code must survive the rewording');
});

test('every authentication refusal tells the user what to do next', () => {
  // Not all of them are session expiry — "your access changed" and "account is
  // no longer active" are distinct situations and should stay distinct. What
  // they must share is a next step, rather than only naming the problem.
  const source = readFileSync(join(srcDir, 'middleware', 'authenticate.js'), 'utf8');
  const messages = messageLiterals(source);
  assert.ok(messages.length >= 3);

  for (const message of messages) {
    const actionable = /sign in again/i.test(message)
      || /contact|administrator|no longer active/i.test(message);
    assert.ok(actionable, `"${message}" says what is wrong but not what happens next`);
  }
});

/**
 * ---------------------------------------------------------------------------
 * RESPONSE ENVELOPE — "Query data cannot be undefined".
 *
 * The web client has ~139 functions shaped `return (await client.get(...)).data.data`.
 * When a handler passes nothing to sendSuccess, `{ data: undefined }`
 * serialises to `{}`, the client reads `undefined`, and React Query REJECTS an
 * undefined result rather than storing it — the screen breaks instead of
 * rendering empty. The reported `tenant-audit` failure is this shape.
 *
 * Normalising in the responder fixes every call site at once, which is why the
 * fix is here and not in 139 places.
 * ---------------------------------------------------------------------------
 */
const { sendSuccess, sendCreated, sendPaginated } = await import('../src/common/http/responder.js');

function fakeRes() {
  const captured = {};
  const res = {
    status(code) { captured.status = code; return res; },
    json(body) { captured.body = body; return res; },
    set() { return res; },
    end() { captured.ended = true; return res; },
  };
  return { res, captured };
}

test('REGRESSION — sendSuccess never emits an envelope without a data key', () => {
  for (const value of [undefined, null]) {
    const { res, captured } = fakeRes();
    sendSuccess(res, value);
    assert.ok('data' in captured.body, 'the data key must always be present');
    assert.equal(captured.body.data, null, 'absent data is null, never undefined');
  }
});

test('sendSuccess passes real payloads through untouched', () => {
  const { res, captured } = fakeRes();
  const payload = { id: 'c-1', firstName: 'Mia' };
  sendSuccess(res, payload);
  assert.deepEqual(captured.body.data, payload);

  // Falsy-but-real values must survive: `?? null` and not `|| null`.
  for (const value of [0, '', false]) {
    const f = fakeRes();
    sendSuccess(f.res, value);
    assert.equal(f.captured.body.data, value, `${JSON.stringify(value)} must not be coerced to null`);
  }
});

test('a collection endpoint returns an empty array, never null', () => {
  // "No results" is an empty list. A client mapping over the response must not
  // have to check first.
  const { res, captured } = fakeRes();
  sendPaginated(res, undefined, undefined);
  assert.deepEqual(captured.body.data, []);
  assert.equal(captured.body.meta, null);
});

test('sendCreated is normalised too', () => {
  const { res, captured } = fakeRes();
  sendCreated(res, undefined);
  assert.ok('data' in captured.body);
  assert.equal(captured.body.data, null);
  assert.equal(captured.status, 201);
});
