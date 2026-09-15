import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Membership, Client, StaffProfile, Appointment, TreatmentPlan, Session, ClinicalDocument } from '../src/models/index.js';
import { withTenant, withPlatform, TenantContextError } from '../src/tenancy/tenantContext.js';

const TENANT_A = '018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b';
const TENANT_B = '018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a99';

/**
 * These tests prove the RLS-equivalent properties WITHOUT a live database: the
 * tenant plugin's pre-hooks run and throw BEFORE any connection is used, so the
 * safety behaviour is observable in isolation.
 */

test('FAIL CLOSED: a tenant-scoped read with no context is refused', async () => {
  await assert.rejects(
    () => Membership.find({}).exec(),
    (err) => err instanceof TenantContextError,
    'a query outside any context must throw, never silently return rows',
  );
});

test('FAIL CLOSED: a tenant-scoped write with no context is refused', async () => {
  const doc = new Membership({ userId: TENANT_A, tenantId: TENANT_A });
  await assert.rejects(() => doc.save(), (err) => err instanceof TenantContextError);
});

test('WITH CHECK: a write carrying a different tenant than the context is refused', async () => {
  const doc = new Membership({ userId: 'u1', tenantId: TENANT_A });
  doc.isNew = false; // simulate an update path carrying a foreign tenantId
  await assert.rejects(
    () => withTenant(TENANT_B, () => doc.save()),
    (err) => err instanceof TenantContextError,
    'a write carrying a different tenant than the context must be refused',
  );
});

test('platform scope does NOT throw the context error (deliberate cross-tenant path)', async () => {
  // Under withPlatform the plugin allows the query through; without a DB it will
  // fail later on connection, but crucially NOT with a TenantContextError.
  await assert.rejects(
    () => withPlatform(() => Membership.find({}).maxTimeMS(50).exec()),
    (err) => !(err instanceof TenantContextError),
    'platform scope must bypass the tenant filter, not fail closed',
  );
});

test('invalid tenant identifier is rejected before any query', async () => {
  await assert.rejects(
    async () => withTenant('not-a-uuid', async () => 'never'),
    (err) => err instanceof TenantContextError,
  );
});

// --- clients (Phase 2): the first PHI collection inherits the same guarantees ---

test('FAIL CLOSED: a client read with no tenant context is refused', async () => {
  await assert.rejects(
    () => Client.find({}).exec(),
    (err) => err instanceof TenantContextError,
    'client PHI must never be readable without a tenant context',
  );
});

test('FAIL CLOSED: a client write with no tenant context is refused', async () => {
  const doc = new Client({ clientNumber: 'CL-TEST0001', firstName: 'A', lastName: 'B', tenantId: TENANT_A });
  await assert.rejects(() => doc.save(), (err) => err instanceof TenantContextError);
});

test('WITH CHECK: a client write carrying a foreign tenant is refused', async () => {
  const doc = new Client({ clientNumber: 'CL-TEST0002', firstName: 'A', lastName: 'B', tenantId: TENANT_A });
  doc.isNew = false; // simulate an update path carrying a foreign tenantId
  await assert.rejects(
    () => withTenant(TENANT_B, () => doc.save()),
    (err) => err instanceof TenantContextError,
  );
});

// --- staff (Phase 2): staff collections inherit the same guarantees --------

test('FAIL CLOSED: a staff read with no tenant context is refused', async () => {
  await assert.rejects(
    () => StaffProfile.find({}).exec(),
    (err) => err instanceof TenantContextError,
  );
});

test('FAIL CLOSED: a staff write with no tenant context is refused', async () => {
  const doc = new StaffProfile({ userId: 'u-1', firstName: 'A', lastName: 'B', tenantId: TENANT_A });
  await assert.rejects(() => doc.save(), (err) => err instanceof TenantContextError);
});

// --- scheduling (Phase 2): appointment collection inherits isolation -------

test('FAIL CLOSED: an appointment read with no tenant context is refused', async () => {
  await assert.rejects(
    () => Appointment.find({}).exec(),
    (err) => err instanceof TenantContextError,
  );
});

test('FAIL CLOSED: an appointment write with no tenant context is refused', async () => {
  const doc = new Appointment({ clientId: 'c-1', staffProfileId: 's-1', authorizationId: 'a-1', startAt: new Date(), endAt: new Date(Date.now() + 3600000), units: 4, tenantId: TENANT_A });
  await assert.rejects(() => doc.save(), (err) => err instanceof TenantContextError);
});

// --- clinical plans (Phase 2): plan tree inherits isolation ----------------

test('FAIL CLOSED: a treatment-plan read with no tenant context is refused', async () => {
  await assert.rejects(
    () => TreatmentPlan.find({}).exec(),
    (err) => err instanceof TenantContextError,
  );
});

test('FAIL CLOSED: a treatment-plan write with no tenant context is refused', async () => {
  const doc = new TreatmentPlan({ clientId: 'c-1', title: 'P', responsibleBcbaStaffId: 's-1', tenantId: TENANT_A });
  await assert.rejects(() => doc.save(), (err) => err instanceof TenantContextError);
});

// --- sessions (Phase 2): the capture record inherits the same guarantees ---

test('FAIL CLOSED: a session read with no tenant context is refused', async () => {
  await assert.rejects(
    () => Session.find({}).exec(),
    (err) => err instanceof TenantContextError,
  );
});

test('FAIL CLOSED: a session write with no tenant context is refused', async () => {
  const doc = new Session({ appointmentId: 'ap-1', clientId: 'c-1', staffProfileId: 's-1', treatmentPlanId: 'p-1', startedAt: new Date(), tenantId: TENANT_A });
  await assert.rejects(() => doc.save(), (err) => err instanceof TenantContextError);
});

// --- clinical documents (Phase 2): the document record inherits the same guarantees ---

test('FAIL CLOSED: a clinical-document read with no tenant context is refused', async () => {
  await assert.rejects(
    () => ClinicalDocument.find({}).exec(),
    (err) => err instanceof TenantContextError,
  );
});

test('FAIL CLOSED: a clinical-document write with no tenant context is refused', async () => {
  const doc = new ClinicalDocument({ clientId: 'c-1', title: 'Intake', tenantId: TENANT_A });
  await assert.rejects(() => doc.save(), (err) => err instanceof TenantContextError);
});
