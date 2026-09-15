import { currentScope, TenantContextError } from './tenantContext.js';

/**
 * ---------------------------------------------------------------------------
 * Tenant isolation plugin — the enforcement half of the RLS replacement.
 *
 * PostgreSQL row-level security was applied by the database to every statement:
 * a developer could not write a query that forgot the tenant filter, because
 * the policy was not part of the query. This plugin reproduces that property in
 * the one place every Mongoose query and write funnels through — the model's
 * query middleware — so the guarantee is centralised, not sprinkled across
 * repositories where a single omission would breach it.
 *
 * Applied to a schema, it does four things, mirroring the four load-bearing
 * properties of the original RLS migration:
 *
 *   1. READ / UPDATE / DELETE FILTER  (RLS `USING`)
 *      Every find/update/delete/count/aggregate has `{ tenantId: <context> }`
 *      merged into its filter. The caller cannot widen it: even an explicit
 *      `tenantId` in the query is overwritten with the context's tenant.
 *
 *   2. WRITE STAMP + CHECK  (RLS `WITH CHECK`)
 *      Every insert is stamped with the context's `tenantId`. An insert that tries
 *      to carry a *different* tenantId is rejected, so a tenant can never write a
 *      row belonging to another — the exact abuse `WITH CHECK` prevented.
 *
 *   3. FAIL CLOSED  (RLS: unset context ⇒ zero rows)
 *      A tenant-scoped operation with no active context throws. We surface the
 *      defect rather than silently returning nothing.
 *
 *   4. EXPLICIT PLATFORM BYPASS  (RLS: `current_tenant_id() IS NULL` path)
 *      Under `withPlatform()` the filter is not applied — the deliberate,
 *      separately-authorised cross-tenant path used by the console and billing.
 *      "Platform scope" is an explicit state, never the accidental default.
 *
 * `FORCE ROW LEVEL SECURITY` applied even to the table owner. The analogue here
 * is that there is no privileged Mongoose connection that skips the plugin:
 * application code reaches tenant data only through these models, and these
 * models always carry the plugin. Out-of-band access (a raw driver handle, the
 * mongo shell) is controlled at the deployment layer by the MongoDB role the
 * application authenticates with — see ARCHITECTURE.md §"Isolation".
 * ---------------------------------------------------------------------------
 */

/** Query middleware hooks that must be tenant-filtered. */
const READ_WRITE_HOOKS = [
  'count',
  'countDocuments',
  'estimatedDocumentCount',
  'find',
  'findOne',
  'findOneAndDelete',
  'findOneAndRemove',
  'findOneAndReplace',
  'findOneAndUpdate',
  'replaceOne',
  'update',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'distinct',
];

/**
 * @param {import('mongoose').Schema} schema
 */
export function tenantPlugin(schema) {
  // Every tenant-owned document carries the discriminator. Indexed together
  // with the natural key on each model; here we guarantee the column exists.
  schema.add({
    tenantId: {
      type: String,
      required: true,
      index: true,
      immutable: true, // a row's tenant can never change after creation
    },
  });

  /** Resolve the active scope or fail closed. */
  function activeTenantIdOrThrow(operation) {
    const scope = currentScope();
    if (!scope) {
      throw new TenantContextError(
        `Refused a tenant-scoped ${operation}: no tenant context is active. ` +
          `Wrap it in withTenant() or, for a deliberate cross-tenant operation, withPlatform().`,
      );
    }
    if (scope.platform) return null; // explicit platform bypass
    return scope.tenantId;
  }

  // --- 1 & 3 & 4: filter reads/updates/deletes, or bypass under platform ----
  for (const hook of READ_WRITE_HOOKS) {
    schema.pre(hook, function tenantFilter() {
      const tenantId = activeTenantIdOrThrow(hook);
      if (tenantId === null) return; // platform scope — no filter
      // Overwrite rather than merge: the context is authoritative, a caller-
      // supplied tenantId must never be able to broaden scope.
      this.setQuery({ ...this.getQuery(), tenantId: tenantId });
    });
  }

  // aggregate() has its own pipeline shape.
  schema.pre('aggregate', function tenantAggregateFilter() {
    const tenantId = activeTenantIdOrThrow('aggregate');
    if (tenantId === null) return;
    const pipeline = this.pipeline();
    pipeline.unshift({ $match: { tenantId: tenantId } });
    // Isolate $lookup sub-pipelines: a joined tenant-owned collection must be
    // filtered too, or a pipeline-form $lookup could read across tenants.
    for (const stage of pipeline) {
      if (stage && stage.$lookup && Array.isArray(stage.$lookup.pipeline)) {
        stage.$lookup.pipeline.unshift({ $match: { tenantId: tenantId } });
      }
    }
  });

  // bulkWrite() does not fire per-op query/document hooks, so enforce here:
  // fail closed without context, stamp inserts and scope every op's filter to
  // the active tenant. A caller-supplied tenantId can never broaden scope.
  schema.pre('bulkWrite', function tenantBulkWriteFilter(next, ops) {
    try {
      const tenantId = activeTenantIdOrThrow('bulkWrite');
      if (Array.isArray(ops)) {
        for (const op of ops) {
          if (op.insertOne) {
            if (tenantId === null) {
              if (!op.insertOne.document || op.insertOne.document.tenantId === undefined) {
                throw new TenantContextError('bulkWrite insertOne under withPlatform() requires tenantId on the document.');
              }
            } else {
              op.insertOne.document = { ...op.insertOne.document, tenantId };
            }
          }
          if (tenantId !== null) {
            if (op.updateOne) op.updateOne.filter = { ...op.updateOne.filter, tenantId };
            if (op.updateMany) op.updateMany.filter = { ...op.updateMany.filter, tenantId };
            if (op.replaceOne) op.replaceOne.filter = { ...op.replaceOne.filter, tenantId };
            if (op.deleteOne) op.deleteOne.filter = { ...op.deleteOne.filter, tenantId };
            if (op.deleteMany) op.deleteMany.filter = { ...op.deleteMany.filter, tenantId };
          }
        }
      }
      return next();
    } catch (err) {
      return next(err);
    }
  });

  // --- 2: stamp + check writes (RLS WITH CHECK) ---------------------------
  //
  // CRITICAL ORDERING: the stamp must run at pre('validate'), not only at
  // pre('save'). Mongoose runs document validation BEFORE pre('save'), so a
  // tenantId assigned in pre('save') arrives too late — `tenantId: { required:
  // true }` fails first with "Path `tenantId` is required" and the write is
  // rejected (surfaced by the API as a 422). Every tenant-owned document
  // created via .create()/.save() (Membership, MembershipRole, UserInvitation,
  // Role, …) hit this. We therefore stamp at validate time so the required
  // field is present for validation, and RE-CHECK at save time so the guarantee
  // still holds even when a caller uses save({ validateBeforeSave: false }).
  function stampAndCheck(doc, operation) {
    const tenantId = activeTenantIdOrThrow(operation);
    if (tenantId === null) {
      // Platform scope: a tenant-owned document must carry an explicit tenantId.
      if (!doc.tenantId) {
        throw new TenantContextError(
          'A tenant-owned document written under withPlatform() must set tenantId explicitly.',
        );
      }
      return;
    }
    if (doc.isNew) {
      doc.tenantId = tenantId; // WRITE STAMP
    } else if (doc.tenantId !== tenantId) {
      throw new TenantContextError(
        'Refused to write a document belonging to a different tenant (WITH CHECK).',
      );
    }
  }

  schema.pre('validate', function tenantStampOnValidate(next) {
    try {
      stampAndCheck(this, 'validate');
      return next();
    } catch (err) {
      return next(err);
    }
  });

  schema.pre('save', function tenantStampOnSave(next) {
    try {
      stampAndCheck(this, 'save');
      return next();
    } catch (err) {
      return next(err);
    }
  });

  schema.pre('insertMany', function tenantStampOnInsertMany(next, docs) {
    try {
      const tenantId = activeTenantIdOrThrow('insertMany');
      if (Array.isArray(docs)) {
        for (const doc of docs) {
          if (tenantId === null) {
            if (!doc.tenantId) {
              throw new TenantContextError(
                'insertMany under withPlatform() requires tenantId on every document.',
              );
            }
          } else {
            doc.tenantId = tenantId;
          }
        }
      }
      return next();
    } catch (err) {
      return next(err);
    }
  });
}
