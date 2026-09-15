/**
 * DEVELOPMENT-ONLY seed: one demo company (ACTIVE) with an owner, a BCBA, and
 * an RBT account, so the full tenant login/dashboard/RBAC path can be tested
 * locally without running the real Super Admin → Resend invitation →
 * onboarding → agreement → activation flow every time.
 *
 * This is NOT a production backdoor:
 *   - it only ever touches records whose slug/email match the constants below
 *     (all under the `demo-aba` / `*.demo@example.test` namespace), so it can
 *     never collide with or silently modify a real customer's data
 *   - it does not touch, shortcut, or bypass the real invitation/onboarding
 *     code path — CompanyInvitationService, ResendEmailTransport, and the
 *     onboarding/agreement/activation state machine are all completely
 *     untouched by this script and remain the only way a REAL company gets
 *     created
 *   - passwords are dev-only values, never printed as anything but plaintext
 *     in this script's own console output (never logged anywhere else), and
 *     are meant to be changed immediately if this is ever run against
 *     anything other than a local/dev database
 *
 * Idempotent: re-running it finds the existing demo org/users by their fixed
 * slug/email and updates them in place (fresh password hash, correct role,
 * correct membership) instead of creating duplicates. Uses the same
 * repository methods (usersRepository.createActiveAccountWithPassword) the
 * real invitation-accept path uses, so there is exactly one way an
 * account+membership gets created in this codebase, not two.
 *
 * Usage:
 *   cd apps/api
 *   npm run seed:demo
 *   # or with custom passwords:
 *   DEMO_OWNER_PASSWORD='...' DEMO_BCBA_PASSWORD='...' DEMO_RBT_PASSWORD='...' npm run seed:demo
 */
import { connectDatabase, disconnectDatabase, mongoose } from '../src/config/db.js';
import '../src/models/index.js'; // register all schemas
import { Organization } from '../src/models/index.js';
import { withPlatform } from '../src/tenancy/tenantContext.js';
import { hashPassword } from '../src/utils/password.js';
import { newId } from '../src/utils/id.js';
import { usersRepository } from '../src/modules/users/index.js';

const DEMO_SLUG = 'demo-aba';
const DEMO_ACCOUNTS = [
  {
    key: 'owner',
    email: process.env.DEMO_OWNER_EMAIL ?? 'demo.owner@example.test',
    password: process.env.DEMO_OWNER_PASSWORD ?? 'DemoOwner!2025',
    fullName: 'Demo Owner',
    roleKey: 'owner',
    isOwner: true,
  },
  {
    key: 'bcba',
    email: process.env.DEMO_BCBA_EMAIL ?? 'demo.bcba@example.test',
    password: process.env.DEMO_BCBA_PASSWORD ?? 'DemoBcba!2025',
    fullName: 'Demo BCBA',
    roleKey: 'bcba',
    isOwner: false,
  },
  {
    key: 'rbt',
    email: process.env.DEMO_RBT_EMAIL ?? 'demo.rbt@example.test',
    password: process.env.DEMO_RBT_PASSWORD ?? 'DemoRbt!2025',
    fullName: 'Demo RBT',
    roleKey: 'rbt',
    isOwner: false,
  },
];

await connectDatabase();
const dbName = mongoose.connection?.db?.databaseName ?? '(default)';
console.log(`Connected to database: ${dbName}`);

// --- 1. the organization -----------------------------------------------
// Created directly ACTIVE. This intentionally bypasses the operator-driven
// provision -> agreement -> activate workflow (that gate exists to keep real
// clinical data behind an executed BAA — it has nothing to enforce for a
// local demo record that will only ever hold seeded, non-real data). The
// real onboarding module and its state machine are not modified or reused
// incorrectly here; this is a separate, explicit, clearly-labeled shortcut
// for exactly one fixed slug.
const org = await withPlatform(async () => {
  const existing = await Organization.findOne({ slug: DEMO_SLUG });
  if (existing) {
    existing.state = 'ACTIVE';
    existing.activatedAt = existing.activatedAt ?? new Date();
    existing.agreementId = existing.agreementId ?? 'seed:demo-agreement';
    await existing.save();
    console.log(`Updated existing demo organization "${DEMO_SLUG}" (${existing._id}).`);
    return existing;
  }
  const created = await Organization.create({
    _id: newId(),
    slug: DEMO_SLUG,
    legalName: 'Demo ABA Clinic, LLC',
    tradingName: 'Demo ABA Clinic',
    state: 'ACTIVE',
    countryCode: 'US',
    stateCode: 'CA',
    timezone: 'America/Los_Angeles',
    locale: 'en-US',
    primaryContactName: 'Demo Owner',
    primaryContactEmail: DEMO_ACCOUNTS[0].email,
    agreementId: 'seed:demo-agreement',
    activatedAt: new Date(),
  });
  console.log(`Created demo organization "${DEMO_SLUG}" (${created._id}).`);
  return created;
});

// --- 2. owner / BCBA / RBT accounts -------------------------------------
// Same repository method the real invitation-accept path uses
// (createActiveAccountWithPassword — createOwnerAccount is this pinned to
// the owner role). Re-running finds each account by email and updates its
// password hash + role in place rather than creating a duplicate user or
// a second membership for the same person in the same tenant (the unique
// {tenantId, userId} index on Membership would reject a duplicate anyway).
for (const account of DEMO_ACCOUNTS) {
  const passwordHash = await hashPassword(account.password);
  await usersRepository.createActiveAccountWithPassword({
    userId: newId(),
    membershipId: newId(),
    tenantId: org._id,
    email: account.email.toLowerCase(),
    fullName: account.fullName,
    passwordHash,
    roleKey: account.roleKey,
    isOwner: account.isOwner,
  });
  console.log(`Seeded ${account.key} account: ${account.email}`);
}

await disconnectDatabase();

console.log('\n--- DEMO COMPANY SEED COMPLETE (development only) ---');
console.log(`Organization : ${DEMO_SLUG} (${org._id}), state ACTIVE`);
for (const account of DEMO_ACCOUNTS) {
  console.log(`${account.key.padEnd(6)}: ${account.email} / ${account.password}`);
}
console.log('These are development-only credentials. Do not use this script or these');
console.log('values against a production database.');
