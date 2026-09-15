/**
 * Static seed audit. Loads every Mongoose model the seed writes to, reads its
 * real schema paths, and checks each field the seed sets against them. This is
 * the "field-name mismatch on first run" I keep warning about — found without a
 * database by comparing the seed's writes to the schema definitions directly.
 */
process.loadEnvFile?.('.env');
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/aba1on1';

const models = await import('/home/claude/proj/apps/api/src/models/index.js');

// What the seed writes, per model. Kept in step with seed-demo.js by hand;
// the point is to diff these against the SCHEMAS, which are authoritative.
const seedWrites = {
  Organization: ['slug', 'legalName', 'tradingName', 'countryCode', 'stateCode', 'timezone', 'locale', 'primaryContactName', 'primaryContactEmail', 'state', 'activatedAt'],
  User: ['email', 'fullName', 'passwordHash', 'isPlatformOperator', 'permissionsVersion'],
  Membership: ['userId', 'status'],
  MembershipRole: ['membershipId', 'roleId', 'assignedBy'],
  StaffProfile: ['userId', 'firstName', 'lastName', 'status'],
  SupervisionLink: ['supervisorStaffId', 'superviseeStaffId', 'active', 'startDate'],
  Client: ['firstName', 'lastName', 'status', 'dateOfBirth'],
  Guardian: ['clientId', 'firstName', 'lastName', 'relationship', 'email', 'isPrimary'],
  ClientAssignment: ['clientId', 'staffProfileId', 'role', 'isPrimary'],
  InsuranceCoverage: ['clientId', 'payerName', 'planName', 'memberId', 'groupNumber',
    'benefitOrder', 'fundingSource', 'subscriberRelationship', 'subscriberName',
    'effectiveFrom', 'effectiveTo', 'verificationStatus', 'verifiedAt', 'verifiedBy',
    'benefitNotes', 'verificationHistory'],
  Appointment: ['clientId', 'staffProfileId', 'startAt', 'endAt', 'status', 'serviceCode', 'units'],
  Session: ['appointmentId', 'clientId', 'staffProfileId', 'treatmentPlanId', 'startedAt', 'status'],
};

let problems = 0;
for (const [modelName, fields] of Object.entries(seedWrites)) {
  const model = models[modelName];
  if (!model) { console.log(`MISSING MODEL: ${modelName}`); problems++; continue; }
  const paths = new Set(Object.keys(model.schema.paths));
  const missing = fields.filter((f) => !paths.has(f));
  if (missing.length) {
    console.log(`${modelName}: seed writes fields the schema lacks -> ${missing.join(', ')}`);
    console.log(`   schema has: ${[...paths].filter(p => !p.startsWith('_') && p!=='__v' && !p.includes('.')).join(', ')}`);
    problems++;
  } else {
    console.log(`${modelName}: OK (${fields.length} fields all valid)`);
  }
}

// Enum spot-checks the seed depends on.
const checks = [
  ['Organization', 'state', 'ACTIVE'],
  ['Membership', 'status', 'ACTIVE'],
  ['StaffProfile', 'status', 'ACTIVE'],
  ['Client', 'status', 'ACTIVE'],
  ['Client', 'status', 'INTAKE'],
  ['Guardian', 'relationship', 'PARENT'],
  ['ClientAssignment', 'role', 'BCBA'],
  ['ClientAssignment', 'role', 'RBT'],
  ['InsuranceCoverage', 'verificationStatus', 'VERIFIED'],
  ['InsuranceCoverage', 'verificationStatus', 'UNVERIFIED'],
  ['Appointment', 'status', 'SCHEDULED'],
  ['Session', 'status', 'DRAFT'],
];
console.log('\n--- enum value checks ---');
for (const [m, field, val] of checks) {
  const path = models[m]?.schema?.paths?.[field];
  const enumVals = path?.enumValues ?? path?.options?.enum ?? null;
  if (enumVals && enumVals.length && !enumVals.includes(val)) {
    console.log(`${m}.${field}: "${val}" NOT in [${enumVals.join(', ')}]`);
    problems++;
  } else {
    console.log(`${m}.${field} = "${val}": ${enumVals ? 'valid' : 'no enum (any string)'}`);
  }
}

console.log(problems === 0 ? '\nSEED AUDIT: PASS' : `\nSEED AUDIT: ${problems} problem(s) to fix before first run`);
process.exit(problems === 0 ? 0 : 1);
