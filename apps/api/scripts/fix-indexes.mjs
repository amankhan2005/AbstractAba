/**
 * Manual index repair for a running database.
 *
 * WHY THIS EXISTS: fixing the Mongoose schema is not enough for a database that
 * is already running. Mongoose `autoIndex` CREATES missing indexes but NEVER
 * DROPS obsolete ones, so old broken indexes persist and keep rejecting valid
 * writes:
 *   - organization.customDomain / invoice.generationKey: a single-field unique
 *     (non-partial) index collides on the null key -> false 409 on company
 *     creation.
 *   - serviceauthorizations { tenantId, clientId, serviceType } unique: caps a
 *     child at ONE ABA + ONE FBA -> duplicate-key error on the second one.
 *
 * The actual reconciliation logic lives in src/config/reconcileIndexes.js and is
 * shared with API startup (server.js), so the manual script and the automatic
 * startup path can never drift. The API also runs this on every boot (best
 * effort); run THIS script explicitly when the API authenticates with a DB role
 * that cannot alter indexes -- invoke it with a privileged role instead.
 *
 * Idempotent and non-destructive: it drops only the specific broken indexes and
 * touches no documents. Safe to run more than once.
 *
 * Usage:
 *   node --env-file=.env scripts/fix-indexes.mjs
 */
import { connectDatabase, disconnectDatabase, mongoose } from '../src/config/db.js';
import { reconcileIndexes } from '../src/config/reconcileIndexes.js';

async function main() {
  await connectDatabase();
  console.log(`Connected to database: ${mongoose.connection?.db?.databaseName ?? '(default)'}`);

  // Throw on failure here (unlike startup) so a genuine problem gives this
  // manual run a non-zero exit the operator can see.
  const result = await reconcileIndexes({ throwOnError: true });
  console.log(`Reconciliation dropped: ${JSON.stringify(result.dropped)}`);

  // Show the resulting indexes for the repaired collections so the operator can
  // confirm the obsolete constraints are gone.
  for (const [collName, field] of [
    ['organization', 'customDomain'],
    ['invoice', 'generationKey'],
  ]) {
    const coll = mongoose.connection.db.collection(collName);
    const after = (await coll.listIndexes().toArray()).filter((ix) =>
      Object.keys(ix.key ?? {}).includes(field),
    );
    console.log(
      `[${collName}] ${field} indexes now: ${JSON.stringify(
        after.map((i) => ({ name: i.name, unique: !!i.unique, partial: !!i.partialFilterExpression })),
      )}`,
    );
  }

  try {
    const saColl = mongoose.connection.db.collection('serviceauthorizations');
    const saAfter = await saColl.listIndexes().toArray();
    console.log(
      `[serviceauthorizations] indexes now: ${JSON.stringify(
        saAfter.map((i) => ({ name: i.name, key: i.key, unique: !!i.unique, partial: !!i.partialFilterExpression })),
      )}`,
    );
  } catch {
    console.log('[serviceauthorizations] collection not present yet -- nothing to show.');
  }

  await disconnectDatabase();
  console.log(
    '\nIndex repair complete. New companies with no custom domain can be created; ' +
      'real duplicates (same slug, or same custom domain) are still rejected. A child can now hold ' +
      'MULTIPLE ABA/FBA authorizations; only a repeated authorization NUMBER (per tenant + child) is rejected.',
  );
}

main().catch(async (err) => {
  console.error('Index repair failed:', err);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
