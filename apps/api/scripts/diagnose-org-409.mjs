/**
 * READ-ONLY diagnostic for the false 409 on company creation.
 *
 * It changes nothing. It inspects the live MongoDB you are configured against
 * (MONGODB_URI) and reports whether the organization / invoice collections
 * carry the broken `unique + sparse` index on a field that is stored as an
 * explicit null on every document — the exact condition that makes a genuinely
 * new company fail with E11000 (surfaced by the API as 409).
 *
 * Usage:
 *   node --env-file=.env scripts/diagnose-org-409.mjs
 */
import { connectDatabase, disconnectDatabase, mongoose } from '../src/config/db.js';
import '../src/models/index.js'; // register all schemas

function classify(ix) {
  const keys = Object.keys(ix.key);
  const singleField = keys.length === 1 ? keys[0] : null;
  const isUnique = !!ix.unique;
  const isSparse = !!ix.sparse;
  const isPartial = !!ix.partialFilterExpression;
  return { name: ix.name, keys, singleField, isUnique, isSparse, isPartial };
}

async function inspect(collName, field) {
  const coll = mongoose.connection.db.collection(collName);
  const exists = await coll
    .listIndexes()
    .toArray()
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    console.log(`\n[${collName}] collection does not exist yet — nothing to diagnose.`);
    return;
  }
  const indexes = (await coll.listIndexes().toArray()).map(classify);
  console.log(`\n===== ${collName} =====`);
  for (const ix of indexes) {
    const tags = [
      ix.isUnique ? 'unique' : null,
      ix.isSparse ? 'sparse' : null,
      ix.isPartial ? 'partial' : null,
    ]
      .filter(Boolean)
      .join(',');
    console.log(`  • ${ix.name}  keys=${JSON.stringify(ix.key ?? ix.keys)}  ${tags || '(plain)'}`);
  }

  const total = await coll.countDocuments({});
  const nonString = await coll.countDocuments({ [field]: { $not: { $type: 'string' } } });
  const asString = await coll.countDocuments({ [field]: { $type: 'string' } });

  const broken = indexes.find(
    (ix) => ix.singleField === field && ix.isUnique && !ix.isPartial,
  );
  const fixed = indexes.find(
    (ix) => ix.singleField === field && ix.isUnique && ix.isPartial,
  );

  console.log(`  documents: total=${total}  ${field}=null/absent=${nonString}  ${field}=string=${asString}`);
  if (broken) {
    console.log(
      `  >>> BROKEN INDEX FOUND: "${broken.name}" is unique but NOT partial ` +
        `(${broken.isSparse ? 'sparse' : 'plain'}). Under this index, ${nonString} documents ` +
        `share the null key. Creating one more org/invoice with ${field}=null ` +
        `=> E11000 duplicate key => the API returns 409.`,
    );
    console.log(`  >>> FIX: run  npm run fix:indexes  (drops "${broken.name}", builds a partial unique index).`);
  } else if (fixed) {
    console.log(`  OK: "${fixed.name}" is a partial unique index — null values are excluded, no false collision.`);
  } else {
    console.log(`  No unique index on ${field} present.`);
  }
}

await connectDatabase();
console.log(`Connected to database: ${mongoose.connection?.db?.databaseName ?? '(default)'}`);
await inspect('organization', 'customDomain');
await inspect('invoice', 'generationKey');
await disconnectDatabase();
console.log('\nDone (read-only — nothing was modified).');
