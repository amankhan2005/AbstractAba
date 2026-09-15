import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * SAVED EMAIL TEMPLATES (/v1/email-templates) — against a REAL MongoDB.
 *
 * Full CRUD with persistence and reuse through the EXISTING parent-email
 * preview/send path (same allowlist renderer, server-resolved recipient).
 */
const CANDIDATES = [process.env.MONGOMS_SYSTEM_BINARY, '/opt/homebrew/bin/mongod', '/usr/local/bin/mongod', '/usr/bin/mongod'].filter(Boolean);
const MONGOD = CANDIDATES.find((p) => existsSync(p)) ?? null;
const skip = MONGOD ? false : 'no local mongod binary (set MONGOMS_SYSTEM_BINARY)';

let server; let mongoose; let M; let withTenant; let emailTemplatesService; let clientsService; let ClientsService; let clientsRepository; let emailTemplatesRepository;
let schemas; let createEmailTemplatesRouter; let AUDIT_CATALOGUE; let SYSTEM_ROLE_TEMPLATES;
const W = {};

before(async () => {
  if (skip) return;
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  server = await MongoMemoryServer.create({ binary: { systemBinary: MONGOD } });
  mongoose = (await import('mongoose')).default;
  await mongoose.connect(server.getUri());
  M = await import('../src/models/index.js');
  ({ withTenant } = await import('../src/tenancy/tenantContext.js'));
  ({ emailTemplatesService, clientsService, ClientsService, clientsRepository } = await import('../src/modules/clients/index.js'));
  ({ emailTemplatesRepository } = await import('../src/modules/clients/email-templates.repository.js'));
  schemas = await import('../src/modules/clients/clients.schemas.js');
  ({ createEmailTemplatesRouter } = await import('../src/modules/clients/email-templates.routes.js'));
  ({ AUDIT_CATALOGUE } = await import('../src/middleware/auditRecorder.js'));
  ({ SYSTEM_ROLE_TEMPLATES } = await import('../src/modules/rbac/roleTemplates.js'));
  await Promise.all(Object.values(M).filter((m) => m?.syncIndexes).map((m) => m.syncIndexes()));
  const org = (slug, tradingName) => M.Organization.create({ slug, legalName: slug, tradingName, state: 'ACTIVE', countryCode: 'US', timezone: 'America/New_York', primaryContactName: 'O', primaryContactEmail: `${slug}@example.com` });
  W.T = (await org('tpl-acme', 'Acme ABA'))._id;
  W.T2 = (await org('tpl-other', 'Other ABA'))._id;
  await withTenant(W.T, async () => {
    const c = await M.Client.create({ clientNumber: 'C-1', firstName: 'mia', lastName: 'K', status: 'ACTIVE' });
    await M.Guardian.create({ clientId: c._id, firstName: 'sarah', lastName: 'K', phone: '5551234567', email: 'sarah@example.com', relationship: 'PARENT', isPrimary: true });
    W.client = c._id;
  });
});
after(async () => { if (skip) return; await mongoose?.disconnect(); await server?.stop(); });

const actor = randomUUID();
const input = (over = {}) => schemas.createEmailTemplateSchema.parse({ name: 'Session reminder', subject: 'Reminder for {{childFirstName}}', body: 'Hello {{parentFirstName}},\n\nSee you soon.\n\n{{companyName}}', ...over });

test('create persists a tenant-owned template; list returns it newest first with real timestamps', { skip }, async () => {
  const tpl = await emailTemplatesService.create({ tenantId: W.T, actorUserId: actor, input: input() });
  W.tpl = tpl;
  assert.equal(tpl.name, 'Session reminder');
  assert.ok(tpl.createdAt instanceof Date && tpl.updatedAt instanceof Date);
  const stored = await withTenant(W.T, async () => await M.EmailTemplate.findById(tpl.id).lean());
  assert.equal(stored.tenantId, W.T);
  assert.equal(stored.createdBy, actor);
  await emailTemplatesService.create({ tenantId: W.T, actorUserId: actor, input: input({ name: 'Intake follow-up' }) });
  const { items, supportedVariables } = await emailTemplatesService.list({ tenantId: W.T });
  assert.deepEqual(items.map((t) => t.name), ['Intake follow-up', 'Session reminder']);
  assert.ok(supportedVariables.includes('childFirstName'));
});

test('get returns the saved content; edits persist and bump the version; a stale version is refused', { skip }, async () => {
  const got = await emailTemplatesService.get({ tenantId: W.T, templateId: W.tpl.id });
  assert.equal(got.body, W.tpl.body);
  const updated = await emailTemplatesService.update({ tenantId: W.T, actorUserId: actor, templateId: W.tpl.id, expectedVersion: got.version, input: { subject: 'Upcoming session for {{childFirstName}}', body: 'Hi {{parentFirstName}}, updated.' } });
  assert.equal(updated.version, got.version + 1);
  assert.equal((await emailTemplatesService.get({ tenantId: W.T, templateId: W.tpl.id })).subject, 'Upcoming session for {{childFirstName}}');
  await assert.rejects(
    emailTemplatesService.update({ tenantId: W.T, actorUserId: actor, templateId: W.tpl.id, expectedVersion: got.version, input: { name: 'Stale' } }),
    (e) => e.code === 'VERSION_CONFLICT' && e.status === 409,
  );
  W.tpl = updated;
});

test('validation: unsupported variables are refused on create and update with the offending names', { skip }, async () => {
  await assert.rejects(
    emailTemplatesService.create({ tenantId: W.T, actorUserId: actor, input: input({ name: 'Bad', body: 'Hi {{parentEmail}} and {{ssn}}' }) }),
    (e) => e.code === 'EMAIL_UNSUPPORTED_VARIABLE' && e.status === 422 && /\{\{parentEmail\}\}, \{\{ssn\}\}/.test(e.message),
  );
  await assert.rejects(
    emailTemplatesService.update({ tenantId: W.T, actorUserId: actor, templateId: W.tpl.id, expectedVersion: W.tpl.version, input: { subject: '{{tenantId}}' } }),
    (e) => e.code === 'EMAIL_UNSUPPORTED_VARIABLE',
  );
  for (const bad of [{}, { name: '', subject: 's', body: 'b' }, { name: 'n', subject: 's', body: 'b', tenantId: W.T2 }, { name: 'n', subject: 'x'.repeat(301), body: 'b' }]) {
    assert.equal(schemas.createEmailTemplateSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test('duplicate names (case-insensitive) are refused within a tenant; allowed across tenants and after delete', { skip }, async () => {
  await assert.rejects(
    emailTemplatesService.create({ tenantId: W.T, actorUserId: actor, input: input({ name: 'SESSION REMINDER' }) }),
    (e) => e.code === 'EMAIL_TEMPLATE_NAME_EXISTS' && e.status === 409,
  );
  const other = await emailTemplatesService.create({ tenantId: W.T2, actorUserId: actor, input: input() });
  assert.ok(other.id);
  W.otherTpl = other;
});

test('saved templates are reused through the existing preview/send path (server-resolved recipient and renderer)', { skip }, async () => {
  const sent = [];
  const svc = new ClientsService({ ...clientsService.deps, email: { send: async (m) => { sent.push(m); return { ok: true, messageId: 'm-1' }; } } });
  const preview = await svc.previewParentEmail({ tenantId: W.T, clientId: W.client, templateId: W.tpl.id });
  assert.equal(preview.templateName, 'Session reminder');
  assert.equal(preview.subject, 'Upcoming session for Mia');
  assert.match(preview.bodyText, /^Hi Sarah, updated\./);
  assert.equal(preview.recipient.email, 'sarah@example.com');
  const result = await svc.sendParentEmail({ tenantId: W.T, clientId: W.client, actorUserId: actor, templateId: W.tpl.id });
  assert.equal(result.status, 'SENT');
  assert.equal(sent[0].recipientEmail, 'sarah@example.com');
  assert.equal(sent[0].view.subject, 'Upcoming session for Mia');
  // Built-in catalog templates keep working.
  assert.equal((await svc.previewParentEmail({ tenantId: W.T, clientId: W.client, templateId: 'intake_sent' })).templateId, 'intake_sent');
  // Another company's saved template cannot be used.
  await assert.rejects(svc.previewParentEmail({ tenantId: W.T, clientId: W.client, templateId: W.otherTpl.id }), (e) => e.code === 'EMAIL_TEMPLATE_NOT_FOUND');
});

test('tenant isolation: another tenant cannot read, update or delete this template', { skip }, async () => {
  const theirs = await emailTemplatesService.list({ tenantId: W.T2 });
  assert.deepEqual(theirs.items.map((t) => t.id), [W.otherTpl.id]);
  const notFound = (e) => e.code === 'EMAIL_TEMPLATE_NOT_FOUND' && e.status === 404;
  await assert.rejects(emailTemplatesService.get({ tenantId: W.T2, templateId: W.tpl.id }), notFound);
  await assert.rejects(emailTemplatesService.update({ tenantId: W.T2, actorUserId: actor, templateId: W.tpl.id, expectedVersion: W.tpl.version, input: { name: 'Hijack' } }), notFound);
  await assert.rejects(emailTemplatesService.remove({ tenantId: W.T2, actorUserId: actor, templateId: W.tpl.id }), notFound);
  assert.equal((await emailTemplatesService.get({ tenantId: W.T, templateId: W.tpl.id })).name, 'Session reminder');
});

test('delete soft-deletes: gone from list/get/send, history kept, the name can be reused', { skip }, async () => {
  await emailTemplatesService.remove({ tenantId: W.T, actorUserId: actor, templateId: W.tpl.id });
  const { items } = await emailTemplatesService.list({ tenantId: W.T });
  assert.ok(!items.some((t) => t.id === W.tpl.id));
  await assert.rejects(emailTemplatesService.get({ tenantId: W.T, templateId: W.tpl.id }), (e) => e.code === 'EMAIL_TEMPLATE_NOT_FOUND');
  await assert.rejects(clientsService.previewParentEmail({ tenantId: W.T, clientId: W.client, templateId: W.tpl.id }), (e) => e.code === 'EMAIL_TEMPLATE_NOT_FOUND');
  const stored = await withTenant(W.T, async () => await M.EmailTemplate.findById(W.tpl.id).lean());
  assert.ok(stored.deletedAt && stored.deletedBy === actor);
  const again = await emailTemplatesService.create({ tenantId: W.T, actorUserId: actor, input: input() });
  assert.notEqual(again.id, W.tpl.id);
  await assert.rejects(emailTemplatesService.remove({ tenantId: W.T, actorUserId: actor, templateId: W.tpl.id }), (e) => e.code === 'EMAIL_TEMPLATE_NOT_FOUND');
});

test('RBAC + audit: reads need clients.update, writes need organization.update (Owner/Company Admin only); writes are audited', { skip }, () => {
  const router = createEmailTemplatesRouter({});
  const routes = router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
  assert.deepEqual(routes.sort(), ['DELETE /:templateId', 'GET /', 'GET /:templateId', 'PATCH /:templateId', 'POST /'].sort());
  const holds = (role, key) => SYSTEM_ROLE_TEMPLATES[role].some((g) => g.key === key);
  assert.ok(holds('org_admin', 'organization.update') && holds('owner', 'organization.update'));
  for (const role of ['bcba', 'rbt', 'receptionist', 'scheduler', 'billing_staff', 'payroll_staff']) {
    assert.equal(holds(role, 'organization.update'), false, `${role} cannot manage templates`);
  }
  for (const role of ['bcba', 'rbt']) assert.equal(holds(role, 'clients.update'), false, `${role} cannot read templates`);
  for (const [method, pattern] of [['POST', '/api/v1/email-templates'], ['PATCH', '/api/v1/email-templates/:templateId'], ['DELETE', '/api/v1/email-templates/:templateId']]) {
    assert.ok(AUDIT_CATALOGUE.some((e) => e.method === method && e.pattern === pattern), `${method} ${pattern}`);
  }
});
