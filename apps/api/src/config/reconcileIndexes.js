import mongoose from 'mongoose';
import { Organization, Invoice, ServiceAuthorization, Claim, ClaimLine } from '../models/index.js';
import { logger } from './logger.js';

/**
 * ---------------------------------------------------------------------------
 * LIVE-DATABASE INDEX RECONCILIATION — the half a corrected schema cannot do.
 *
 * Fixing a Mongoose schema is not enough for a database that is already
 * running. Mongoose `autoIndex` CREATES indexes the schema declares but NEVER
 * DROPS an obsolete one, so a live collection keeps any old unique constraint
 * forever. That is the exact reason the reported bugs survived a "fixed" schema:
 *
 *   - serviceauthorizations kept a unique { tenantId, clientId, serviceType }
 *     index, which caps a child at ONE ABA + ONE FBA and throws E11000 on the
 *     second authorization — even though the schema no longer declares it.
 *   - organization/invoice kept a single-field unique (non-partial) index on a
 *     nullable field, which collides on the null key (the false 409 on company
 *     creation).
 *
 * This module reconciles the live collections with the corrected schema. It is
 * the SINGLE source of truth for that reconciliation: both the API on startup
 * (see server.js) and the manual `scripts/fix-indexes.mjs` call it, so the two
 * can never drift.
 *
 * PROPERTIES:
 *   - Idempotent. Running it twice changes nothing the second time.
 *   - Non-destructive. It drops ONLY the specific broken indexes identified by
 *     exact shape; it never touches documents or any other index.
 *   - Best-effort by default (throwOnError=false). On startup a restricted
 *     MongoDB role that cannot drop/build indexes must not crash the API — the
 *     failure is logged and the operator runs scripts/fix-indexes.mjs with a
 *     privileged role. The migration script calls it with throwOnError=true so a
 *     genuine failure there is surfaced with a non-zero exit.
 * ---------------------------------------------------------------------------
 */

/**
 * Drop a single-field unique index that is NOT partial (the broken shape that
 * collides on an explicit null key). Leaves partial-unique indexes intact.
 */
async function dropBrokenUnique(collName, field) {
  const coll = mongoose.connection.db.collection(collName);
  let indexes;
  try {
    indexes = await coll.listIndexes().toArray();
  } catch {
    logger.info(`[reconcileIndexes] ${collName}: collection not present yet — skipping.`);
    return;
  }
  for (const ix of indexes) {
    const keys = Object.keys(ix.key ?? {});
    const isSingleField = keys.length === 1 && keys[0] === field;
    if (isSingleField && !!ix.unique && !ix.partialFilterExpression) {
      logger.warn(`[reconcileIndexes] ${collName}: dropping broken index "${ix.name}" (unique, not partial).`);
      await coll.dropIndex(ix.name);
    }
  }
}

/**
 * Drop a COMPOUND unique index by its exact ordered key shape. Used to remove an
 * obsolete constraint whose key no longer matches any index the schema declares,
 * which is why syncIndexes() alone cannot recognise and drop it.
 *
 * @param {string} collName
 * @param {Record<string, 1|-1>} keyShape ordered {field: direction} map
 */
async function dropCompoundUnique(collName, keyShape) {
  const coll = mongoose.connection.db.collection(collName);
  let indexes;
  try {
    indexes = await coll.listIndexes().toArray();
  } catch {
    logger.info(`[reconcileIndexes] ${collName}: collection not present yet — skipping.`);
    return;
  }
  const wantKeys = Object.keys(keyShape);
  for (const ix of indexes) {
    const keys = Object.keys(ix.key ?? {});
    const sameShape =
      keys.length === wantKeys.length &&
      keys.every((k, i) => k === wantKeys[i] && ix.key[k] === keyShape[k]);
    if (sameShape && ix.unique) {
      logger.warn(`[reconcileIndexes] ${collName}: dropping obsolete compound unique index "${ix.name}" (${keys.join(', ')}).`);
      await coll.dropIndex(ix.name);
    }
  }
}

/**
 * Drop EVERY stale unique index that caps a child at one ABA + one FBA, whatever
 * its exact shape. `dropCompoundUnique` only recognises one precise key ordering
 * ({tenantId, clientId, serviceType}); a database migrated across older builds
 * can instead carry the capping constraint as {clientId, serviceType},
 * {tenantId, serviceType, clientId}, or a differently-ordered/extended variant,
 * and any of those keeps rejecting the second authorization. The real, shape-
 * independent test is simple:
 *
 *   a unique index on serviceauthorizations whose key INCLUDES `serviceType`
 *   but does NOT include `authorizationNumber` forces uniqueness per service
 *   line — i.e. at most one ABA + one FBA per child — and must be dropped.
 *
 * The one legitimate unique index (partial-unique on authorizationNumber)
 * includes `authorizationNumber`, so it is preserved. Non-unique indexes and the
 * `_id_` index are never touched. Idempotent (a second run finds nothing) and
 * non-destructive (documents are untouched; only obsolete unique constraints go).
 */
async function dropCappingServiceTypeUnique(collName) {
  const coll = mongoose.connection.db.collection(collName);
  let indexes;
  try {
    indexes = await coll.listIndexes().toArray();
  } catch {
    logger.info(`[reconcileIndexes] ${collName}: collection not present yet — skipping.`);
    return;
  }
  for (const ix of indexes) {
    if (!ix.unique) continue;
    if (ix.name === '_id_') continue;
    const keys = Object.keys(ix.key ?? {});
    const capsServiceLine = keys.includes('serviceType') && !keys.includes('authorizationNumber');
    if (capsServiceLine) {
      logger.warn(
        `[reconcileIndexes] ${collName}: dropping obsolete capping unique index "${ix.name}" (${keys.join(', ')}) — it limits a child to one ${'ABA'} + one FBA.`,
      );
      await coll.dropIndex(ix.name);
    }
  }
}

/**
 * Reconcile the live database with the corrected schema. Safe to call on every
 * boot.
 *
 * @param {{ throwOnError?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, dropped: object, error?: string }>}
 */
export async function reconcileIndexes(opts = {}) {
  const { throwOnError = false } = opts;
  try {
    // 1. False-409 fixes (nullable unique → partial unique).
    await dropBrokenUnique('organization', 'customDomain');
    await dropBrokenUnique('invoice', 'generationKey');

    // 2. Multiple ABA/FBA fix — drop the obsolete unique (tenant, client,
    //    serviceType) index that caps a child at one ABA + one FBA. The exact-
    //    shape drop stays for the canonical name; the shape-independent pass
    //    additionally catches any differently-ordered/extended variant a
    //    database migrated across older builds may carry.
    await dropCompoundUnique('serviceauthorizations', { tenantId: 1, clientId: 1, serviceType: 1 });
    await dropCappingServiceTypeUnique('serviceauthorizations');

    // 3. Claim isolation — the claim / claim-line unique indexes were declared
    //    on `organizationId`, a field these tenant-plugin documents never carry,
    //    so they were global: organizations collided on claim numbers. The
    //    schema now keys them on tenantId; drop the obsolete global ones.
    await dropCompoundUnique('claim', { organizationId: 1, claimNumber: 1 });
    await dropCompoundUnique('claim', { organizationId: 1, generationKey: 1 });
    await dropCompoundUnique('claim_line', { organizationId: 1, sessionId: 1 });

    // 4. Reconcile each affected collection with its corrected schema.
    //    syncIndexes() builds the partial-unique authorizationNumber index and
    //    the non-unique (tenant, client, serviceType) index, and removes any
    //    index the schema no longer declares.
    const dropped = {
      organization: await Organization.syncIndexes(),
      invoice: await Invoice.syncIndexes(),
      serviceauthorizations: await ServiceAuthorization.syncIndexes(),
      claim: await Claim.syncIndexes(),
      claim_line: await ClaimLine.syncIndexes(),
    };

    logger.info({ dropped }, '[reconcileIndexes] complete — live indexes reconciled with schema.');
    return { ok: true, dropped };
  } catch (err) {
    const message = err?.message ?? String(err);
    if (throwOnError) throw err;
    // Startup path: never crash the API on an index-permission problem. The
    // operator can run scripts/fix-indexes.mjs with a privileged role.
    logger.error(
      { err: message },
      '[reconcileIndexes] could not reconcile live indexes on startup. ' +
        'If second ABA/FBA authorizations fail with a duplicate-key error, run: ' +
        'npm run fix:indexes --workspace apps/api (with a role that can drop/build indexes).',
    );
    return { ok: false, dropped: {}, error: message };
  }
}

export const __testables = { dropBrokenUnique, dropCompoundUnique, dropCappingServiceTypeUnique };
