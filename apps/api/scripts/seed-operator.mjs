/**
 * Seed a platform operator so you can sign into the console. Real script (not a
 * stub): connects, upserts the user, sets a password. Usage:
 *   node scripts/seed-operator.mjs operator@example.com 'StrongPass!23' 'Ops Name'
 */
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { User } from '../src/models/index.js';
import { withPlatform } from '../src/tenancy/tenantContext.js';
import { hashPassword } from '../src/utils/password.js';
import { newId } from '../src/utils/id.js';

const [email, password, fullName = 'Platform Operator'] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: node scripts/seed-operator.mjs <email> <password> [fullName]');
  process.exit(1);
}

await connectDatabase();
await withPlatform(async () => {
  const { mongoose } = await import('../src/config/db.js');
  const dbName = mongoose.connection?.db?.databaseName ?? '(default)';
  console.log(`Connected to database: ${dbName}`);
  const passwordHash = await hashPassword(password);
  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    existing.isPlatformOperator = true;
    existing.passwordHash = passwordHash;
    existing.status = 'ACTIVE';
    await existing.save();
    console.log(`Updated existing user ${email} as platform operator.`);
  } else {
    await User.create({
      _id: newId(),
      email: email.toLowerCase(),
      fullName,
      status: 'ACTIVE',
      isPlatformOperator: true,
      passwordHash,
      emailVerifiedAt: new Date(),
    });
    console.log(`Created platform operator ${email}.`);
  }
});
await disconnectDatabase();
