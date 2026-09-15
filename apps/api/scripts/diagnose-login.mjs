/**
 * Read-only login diagnostic. Uses the project's OWN utilities (no bypass, no
 * mock, no writes). Reports why sign-in would succeed or fail for a given
 * operator, and which database the API is actually reading — so a seed/API
 * database mismatch is immediately visible.
 *
 * Never prints the password, passwordHash, MongoDB URI, or any secret.
 *
 * Usage (loads apps/api/.env exactly like the server does):
 *   cd apps/api
 *   node --env-file=.env scripts/diagnose-login.mjs testadmin@aba1on1.com 'TestAdmin@12345'
 */
import { connectDatabase, disconnectDatabase, mongoose } from '../src/config/db.js';
import { User, MfaFactor } from '../src/models/index.js';
import { withPlatform } from '../src/tenancy/tenantContext.js';
import { verifyPassword } from '../src/utils/password.js';

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error("Usage: node --env-file=.env scripts/diagnose-login.mjs <email> <password>");
  process.exit(1);
}

await connectDatabase();
await withPlatform(async () => {
  const dbName = mongoose.connection?.db?.databaseName ?? '(default)';
  console.log('database name        :', dbName);

  const lower = email.toLowerCase();
  const user = await User.findOne({ email: lower });
  console.log('lookup email         :', lower);
  console.log('user found           :', !!user);

  if (!user) {
    const operators = await User.countDocuments({ isPlatformOperator: true });
    console.log('platform operators   :', operators);
    console.log('\nVERDICT: no user with that email in THIS database.');
    console.log('If your seed reported success, the seed and the API are using DIFFERENT databases.');
    return;
  }

  console.log('stored email         :', JSON.stringify(user.email));
  console.log('isPlatformOperator   :', user.isPlatformOperator);
  console.log('status               :', user.status, '(ACTIVE required)');
  const locked = !!(user.lockedUntil && user.lockedUntil.getTime() > Date.now());
  console.log('locked               :', locked, user.lockedUntil ? `(until ${user.lockedUntil.toISOString()})` : '');
  console.log('failedLoginAttempts  :', user.failedLoginAttempts);
  console.log('emailVerifiedAt set  :', !!user.emailVerifiedAt);
  console.log('passwordHash present  :', !!user.passwordHash);
  console.log('passwordHash format  :', /^\$2[aby]\$\d\d\$/.test(user.passwordHash || '') ? 'valid bcrypt' : 'NOT bcrypt');

  const matches = await verifyPassword(password, user.passwordHash);
  console.log('password matches     :', matches);

  const factors = await MfaFactor.find({ userId: user._id, deletedAt: null, verifiedAt: { $ne: null } }).lean();
  console.log('verified MFA factors :', factors.length);

  console.log('\nVERDICT:',
    user.status !== 'ACTIVE' ? 'would return 403 (status not ACTIVE) — not 401'
    : locked ? 'would return 423 (locked) — not 401'
    : !matches ? '401 CAUSE = password does not match stored hash (re-seed with the exact password)'
    : factors.length ? 'password OK, but sign-in returns MFA_REQUIRED (a verified MFA factor exists)'
    : 'credentials VALID — sign-in should return 200 OK');
});
await disconnectDatabase();
