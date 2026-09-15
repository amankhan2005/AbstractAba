import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Claim, ClaimLine, Timesheet, TimeEntry, PayrollRun, PayrollLine,
  EraFile, EraClaimPayment, PaymentAdjustment, ReconciliationRecord,
  SupervisionObservation, SupervisionHourLog,
  AppointmentSeries, OrganizationExport,
} from '../src/models/index.js';
import { withTenant, TenantContextError } from '../src/tenancy/tenantContext.js';

const TENANT_A = '018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b';
const TENANT_B = '018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a99';

/**
 * Phase 3 tenant-owned financial/clinical-billing models must inherit the same
 * RLS-equivalent guarantees proven for Phase 2 models. These run WITHOUT a live
 * database: the tenant plugin's pre-hooks throw before any query executes.
 */

const READ_MODELS = [
  ['claim', Claim], ['claimLine', ClaimLine], ['timesheet', Timesheet],
  ['timeEntry', TimeEntry], ['payrollRun', PayrollRun], ['payrollLine', PayrollLine],
  ['eraFile', EraFile], ['eraClaimPayment', EraClaimPayment],
  ['paymentAdjustment', PaymentAdjustment], ['reconciliationRecord', ReconciliationRecord],
  ['supervisionObservation', SupervisionObservation], ['supervisionHourLog', SupervisionHourLog],
  ['appointmentSeries', AppointmentSeries],
  ['organizationExport', OrganizationExport],
];

for (const [name, Model] of READ_MODELS) {
  test(`FAIL CLOSED: ${name} read with no tenant context is refused`, async () => {
    await assert.rejects(
      () => Model.find({}).exec(),
      (err) => err instanceof TenantContextError,
      `${name} must never be readable without a tenant context`,
    );
  });
}

test('FAIL CLOSED: a claim write with no tenant context is refused', async () => {
  const doc = new Claim({ claimNumber: 'CLM-TEST-1', clientId: 'c1', totalCharge: 0, tenantId: TENANT_A });
  await assert.rejects(() => doc.save(), (err) => err instanceof TenantContextError);
});

test('FAIL CLOSED: a payrollRun write with no tenant context is refused', async () => {
  const doc = new PayrollRun({ payPeriodId: 'pp1', tenantId: TENANT_A });
  await assert.rejects(() => doc.save(), (err) => err instanceof TenantContextError);
});

test('FAIL CLOSED: a reconciliationRecord write with no tenant context is refused', async () => {
  const doc = new ReconciliationRecord({ source: 'CLAIM', claimId: 'c1', tenantId: TENANT_A });
  await assert.rejects(() => doc.save(), (err) => err instanceof TenantContextError);
});

test('WITH CHECK: an eraFile write carrying a foreign tenant is refused', async () => {
  const doc = new EraFile({ fileName: 'r.835', tenantId: TENANT_A });
  doc.isNew = false; // simulate an update path carrying a foreign tenantId
  await assert.rejects(
    () => withTenant(TENANT_B, () => doc.save()),
    (err) => err instanceof TenantContextError,
  );
});

test('FAIL CLOSED: a supervisionObservation write with no tenant context is refused', async () => {
  const doc = new SupervisionObservation({ supervisorStaffId: 'a', superviseeStaffId: 'b', observedAt: new Date(), durationMinutes: 60, tenantId: TENANT_A });
  await assert.rejects(() => doc.save(), (err) => err instanceof TenantContextError);
});

test('FAIL CLOSED: a supervisionHourLog write with no tenant context is refused', async () => {
  const doc = new SupervisionHourLog({ supervisorStaffId: 'a', superviseeStaffId: 'b', date: new Date(), minutes: 60, tenantId: TENANT_A });
  await assert.rejects(() => doc.save(), (err) => err instanceof TenantContextError);
});

test('FAIL CLOSED: an appointmentSeries write with no tenant context is refused', async () => {
  const doc = new AppointmentSeries({
    clientId: 'c', staffProfileId: 's', authorizationId: 'a',
    startMinute: 540, endMinute: 600, frequency: 'DAILY', interval: 1,
    startDate: new Date(), count: 3, tenantId: TENANT_A,
  });
  await assert.rejects(() => doc.save(), (err) => err instanceof TenantContextError);
});

test('FAIL CLOSED: an organizationExport write with no tenant context is refused', async () => {
  const doc = new OrganizationExport({ organizationId: TENANT_A, requestedByUserId: 'u', tenantId: TENANT_A });
  await assert.rejects(() => doc.save(), (err) => err instanceof TenantContextError);
});
