/**
 * DB-free proof that the RLS-equivalent isolation holds. Runs the same
 * assertions as test/isolation.test.js and prints a summary — handy in CI as a
 * fast gate before spinning up MongoDB.
 */
import { Membership } from '../src/models/index.js';
import { withPlatform, withTenant, TenantContextError } from '../src/tenancy/tenantContext.js';

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  ✗ ${name} — ${err.message}`);
  }
}
const isCtxErr = (e) => e instanceof TenantContextError;

console.log('Isolation (RLS-equivalent) verification:');
await check('read without context fails closed', async () => {
  try { await Membership.find({}).exec(); throw new Error('did not throw'); }
  catch (e) { if (!isCtxErr(e)) throw e; }
});
await check('write without context fails closed', async () => {
  try { await new Membership({ userId: 'u', tenantId: 'x' }).save(); throw new Error('did not throw'); }
  catch (e) { if (!isCtxErr(e)) throw e; }
});
await check('platform scope bypasses the tenant filter', async () => {
  try { await withPlatform(() => Membership.find({}).maxTimeMS(50).exec()); }
  catch (e) { if (isCtxErr(e)) throw new Error('platform scope wrongly failed closed'); }
});
await check('invalid tenant id rejected', async () => {
  try { await withTenant('bad', async () => {}); throw new Error('did not throw'); }
  catch (e) { if (!isCtxErr(e)) throw e; }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
