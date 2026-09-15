#!/usr/bin/env node
/**
 * ---------------------------------------------------------------------------
 * DEVELOPMENT DEMO SEED — one clinic, fully wired.
 *
 * Creates a single organization with the relationships the role boundaries are
 * actually made of, so that logging in as each role SHOWS the boundary rather
 * than requiring you to take it on trust:
 *
 *   Demo ABA Clinic
 *   ├── Owner        (company-wide)
 *   ├── BCBA Ben     supervises RBT Ann; caseload = Child 1, Child 2
 *   ├── RBT Ann      assigned to Child 1 only
 *   ├── RBT Raj      assigned to Child 2 only   ← the isolation demo
 *   ├── Child 1 — guardian, VERIFIED insurance, appointment, session
 *   └── Child 2 — guardian, UNVERIFIED insurance  ← the gate demo
 *
 * Two of those are deliberate teaching cases:
 *
 *   RBT Raj exists so you can log in as Ann and confirm Child 2 is invisible.
 *   A seed with one technician cannot demonstrate isolation at all.
 *
 *   Child 2's insurance is UNVERIFIED so the scheduling gate is visible in the
 *   product: booking for Child 2 is refused with a plain-language reason until
 *   someone records a verification. Seeding everything green would hide the
 *   single most important business rule in the platform.
 *
 * SAFETY
 * ------
 * Refuses to run when NODE_ENV=production. These accounts use the REAL
 * authentication path — ordinary users, memberships, hashed passwords, tenant
 * ids. There is no bypass, no magic account, and nothing here is referenced by
 * application code. Deleting this file changes no behaviour.
 *
 * Passwords come from DEMO_SEED_PASSWORD (default below is for local use only).
 *
 *   node scripts/seed-demo.js            # create
 *   node scripts/seed-demo.js --reset    # delete the demo org first, then create
 * ---------------------------------------------------------------------------
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { withPlatform, withTenant } from '../src/tenancy/tenantContext.js';
import { organizationRepository } from '../src/modules/organization/index.js';
import { usersRepository } from '../src/modules/users/index.js';
import { hashPassword } from '../src/utils/password.js';
import {
  Organization, User, Membership, MembershipRole, StaffProfile,
  Client, Guardian, ClientAssignment, SupervisionLink,
  InsuranceCoverage, Appointment, Session,
} from '../src/models/index.js';

const PASSWORD = process.env.DEMO_SEED_PASSWORD ?? 'DemoPassw0rd!2026';
const ORG_SLUG = 'demo-aba-clinic';

const ACCOUNTS = [
  { key: 'owner', email: 'demo-owner@example.com', fullName: 'Dana Owner', role: 'owner' },
  { key: 'admin', email: 'demo-admin@example.com', fullName: 'Alex Admin', role: 'org_admin' },
  { key: 'bcba', email: 'demo-bcba@example.com', fullName: 'Ben Analyst', role: 'bcba' },
  { key: 'rbtAnn', email: 'demo-rbt@example.com', fullName: 'Ann Technician', role: 'rbt' },
  { key: 'rbtRaj', email: 'demo-rbt2@example.com', fullName: 'Raj Technician', role: 'rbt' },
];

async function main() {
  if (env.isProd) {
    console.error('Refusing to seed demo data with NODE_ENV=production.');
    process.exit(1);
  }

  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 5000 });
  console.log(`Connected to ${env.mongoUri.replace(/\/\/[^@]*@/, '//***@')}`);

  const reset = process.argv.includes('--reset');
  const existing = await withPlatform(() => Organization.findOne({ slug: ORG_SLUG }).lean());
  if (existing && !reset) {
    console.log('Demo organization already exists. Re-run with --reset to rebuild.');
    await mongoose.disconnect();
    return;
  }
  if (existing && reset) {
    await purge(existing._id);
    console.log('Removed the previous demo organization.');
  }

  // Create the organization through the REAL repository, with the fields the
  // schema actually requires (legalName/tradingName, not `name`; a contact and
  // timezone). Hand-writing `{ name, state: 'ACTIVE' }` failed schema
  // validation on three required fields and set a `name` path that does not
  // exist — the audit caught it before a first run could.
  const orgDomain = await organizationRepository.create({
    slug: ORG_SLUG,
    legalName: 'Demo ABA Clinic LLC',
    tradingName: 'Demo ABA Clinic',
    countryCode: 'US',
    stateCode: 'CA',
    timezone: 'America/Los_Angeles',
    locale: 'en-US',
    primaryContactName: 'Dana Owner',
    primaryContactEmail: 'demo-owner@example.com',
  });
  const tenantId = orgDomain.id;
  // A freshly-created org is PROVISIONING; the demo needs it live so scheduling
  // and the rest of the app treat it as an operating clinic.
  await withPlatform(() => Organization.updateOne({ _id: tenantId }, { $set: { state: 'ACTIVE', activatedAt: new Date() } }));

  const passwordHash = await hashPassword(PASSWORD);

  // --- accounts, through the REAL provisioning path ------------------------
  // createActiveAccountWithPassword creates the user, seeds the tenant's system
  // Roles, creates an ACTIVE membership, and links the correct MembershipRole
  // by roleId. Hand-writing `MembershipRole { roleKey }` wrote a field the
  // schema lacks (it stores roleId, a reference) — so every seeded login would
  // have carried NO resolvable role and been unable to see anything.
  const users = {};
  for (const acct of ACCOUNTS) {
    await usersRepository.createActiveAccountWithPassword({
      tenantId,
      email: acct.email,
      fullName: acct.fullName,
      passwordHash,
      roleKey: acct.role,
      isOwner: acct.role === 'owner',
    });
    users[acct.key] = await withPlatform(() => User.findOne({ email: acct.email }).lean());
  }

  await withTenant(tenantId, async () => {
    // --- staff profiles: the clinician identity the scope engine resolves --
    const staff = {};
    for (const key of ['bcba', 'rbtAnn', 'rbtRaj']) {
      const acct = ACCOUNTS.find((a) => a.key === key);
      const [firstName, ...rest] = acct.fullName.split(' ');
      staff[key] = await StaffProfile.findOneAndUpdate(
        { userId: users[key]._id },
        {
          userId: users[key]._id,
          firstName,
          lastName: rest.join(' ') || 'Staff',
          status: 'ACTIVE',
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    }

    // --- supervision: Ben supervises Ann, NOT Raj -------------------------
    // The asymmetry is the point: it is what makes Raj's caseload invisible
    // to Ben's TEAM scope.
    await SupervisionLink.findOneAndUpdate(
      { supervisorStaffId: staff.bcba._id, superviseeStaffId: staff.rbtAnn._id },
      {
        supervisorStaffId: staff.bcba._id,
        superviseeStaffId: staff.rbtAnn._id,
        active: true,
        startDate: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    // --- children ---------------------------------------------------------
    const child1 = await upsertClient({ firstName: 'Mia', lastName: 'Demo', status: 'ACTIVE' });
    const child2 = await upsertClient({ firstName: 'Noah', lastName: 'Demo', status: 'INTAKE' });

    for (const [child, guardianName] of [[child1, 'Priya Demo'], [child2, 'Sam Demo']]) {
      const [firstName, ...rest] = guardianName.split(' ');
      await Guardian.findOneAndUpdate(
        { clientId: child._id, firstName },
        {
          clientId: child._id,
          firstName,
          lastName: rest.join(' '),
          relationship: 'PARENT',
          email: `demo-parent-${firstName.toLowerCase()}@example.com`,
          isPrimary: true,
        },
        { upsert: true, setDefaultsOnInsert: true },
      );
    }

    // --- assignments: Ann → Mia, Raj → Noah. Never both. ------------------
    await assign(child1._id, staff.bcba._id, 'BCBA', true);
    await assign(child1._id, staff.rbtAnn._id, 'RBT', false);
    await assign(child2._id, staff.bcba._id, 'BCBA', true);
    await assign(child2._id, staff.rbtRaj._id, 'RBT', false);

    // --- insurance: one verified, one not ---------------------------------
    const now = new Date();
    await InsuranceCoverage.findOneAndUpdate(
      { clientId: child1._id, memberId: 'DEMO-100001' },
      {
        clientId: child1._id,
        payerName: 'Demo Health Plan',
        planName: 'PPO Standard',
        memberId: 'DEMO-100001',
        groupNumber: 'GRP-1',
        benefitOrder: 'PRIMARY',
        fundingSource: 'COMMERCIAL',
        subscriberRelationship: 'PARENT',
        subscriberName: 'Priya Demo',
        effectiveFrom: new Date(now.getFullYear(), 0, 1),
        effectiveTo: new Date(now.getFullYear(), 11, 31),
        verificationStatus: 'VERIFIED',
        verifiedAt: now,
        verifiedBy: users.admin._id,
        benefitNotes: 'Seeded as verified so scheduling can be demonstrated.',
        verificationHistory: [{ status: 'VERIFIED', at: now, by: users.admin._id, note: 'Demo seed.' }],
      },
      { upsert: true, setDefaultsOnInsert: true },
    );

    // Deliberately UNVERIFIED — booking for Noah is refused until someone
    // records a verification. This is the gate, visible in the product.
    await InsuranceCoverage.findOneAndUpdate(
      { clientId: child2._id, memberId: 'DEMO-100002' },
      {
        clientId: child2._id,
        payerName: 'Demo Health Plan',
        memberId: 'DEMO-100002',
        benefitOrder: 'PRIMARY',
        fundingSource: 'COMMERCIAL',
        subscriberRelationship: 'PARENT',
        subscriberName: 'Sam Demo',
        verificationStatus: 'UNVERIFIED',
        verificationHistory: [{ status: 'UNVERIFIED', at: now, by: users.admin._id, note: 'Demo seed.' }],
      },
      { upsert: true, setDefaultsOnInsert: true },
    );

    // --- one appointment and session for Mia, delivered by Ann ------------
    const start = new Date(now.getTime() + 60 * 60 * 1000);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
    const appt = await Appointment.findOneAndUpdate(
      { clientId: child1._id, staffProfileId: staff.rbtAnn._id, startAt: start },
      {
        clientId: child1._id,
        staffProfileId: staff.rbtAnn._id,
        startAt: start,
        endAt: end,
        status: 'SCHEDULED',
        serviceCode: '97153',
        units: 8,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    await Session.findOneAndUpdate(
      { appointmentId: appt._id },
      {
        appointmentId: appt._id,
        clientId: child1._id,
        staffProfileId: staff.rbtAnn._id,
        treatmentPlanId: 'demo-plan',
        startedAt: start,
        status: 'DRAFT',
      },
      { upsert: true, setDefaultsOnInsert: true },
    );

    async function upsertClient(doc) {
      return Client.findOneAndUpdate(
        { firstName: doc.firstName, lastName: doc.lastName },
        { ...doc, dateOfBirth: new Date(2018, 4, 12) },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    }

    async function assign(clientId, staffProfileId, role, isPrimary) {
      return ClientAssignment.findOneAndUpdate(
        { clientId, staffProfileId, role },
        { clientId, staffProfileId, role, isPrimary },
        { upsert: true, setDefaultsOnInsert: true },
      );
    }
  });

  report(tenantId);
  await mongoose.disconnect();
}

async function purge(tenantId) {
  const models = [Membership, MembershipRole, StaffProfile, Client, Guardian,
    ClientAssignment, SupervisionLink, InsuranceCoverage, Appointment, Session];
  await withTenant(tenantId, async () => {
    for (const M of models) await M.deleteMany({});
  });
  await withPlatform(async () => {
    await User.deleteMany({ email: { $in: ACCOUNTS.map((a) => a.email) } });
    await Organization.deleteOne({ _id: tenantId });
  });
}

function report(tenantId) {
  console.log(`\nDemo organization ready (tenant ${tenantId}).\n`);
  console.log('  Sign in at the Web Portal with any of these:\n');
  for (const a of ACCOUNTS) {
    console.log(`    ${a.role.padEnd(10)} ${a.email.padEnd(28)} ${PASSWORD}`);
  }
  console.log(`
  What to look at:

    demo-rbt@example.com     sees Mia only. Noah is invisible — not hidden in
                             the interface, absent from the API response.
    demo-rbt2@example.com    sees Noah only. The mirror image.
    demo-bcba@example.com    sees both children (caseload) and supervises Ann
                             but not Raj.
    demo-owner@example.com   sees the whole clinic.

    Booking a session for Noah is REFUSED — his insurance is unverified.
    Record a verification on his client page and booking then succeeds.

  These are development credentials. Never seed them into production.
`);
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exitCode = 1;
  return mongoose.disconnect();
});
