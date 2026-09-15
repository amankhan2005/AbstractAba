import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Organization } from '../src/models/organization.model.js';
import { Invoice } from '../src/models/invoice.model.js';

/**
 * Regression guard for the false-409 root cause.
 *
 * A field with `default: null` is stored as an explicit null on every document.
 * A `unique + sparse` index does NOT skip explicit nulls (sparse only skips
 * ABSENT fields), so a unique+sparse index on such a field collides on the null
 * key from the 2nd document onward — which is what made a genuinely new company
 * fail with E11000 -> 409. The correct guarantee is a partial unique index that
 * only applies to real string values.
 *
 * These assertions run without a database (they read the compiled schema), so
 * the footgun cannot silently return even though the fake-repo suite never
 * touches a live index.
 */
function singleFieldIndexes(Model, field) {
  return Model.schema
    .indexes()
    .filter(([keys]) => {
      const k = Object.keys(keys);
      return k.length === 1 && k[0] === field;
    })
    .map(([, opts]) => opts ?? {});
}

for (const [name, Model, field] of [
  ['Organization.customDomain', Organization, 'customDomain'],
  ['Invoice.generationKey', Invoice, 'generationKey'],
]) {
  test(`${name}: no unique+sparse (non-partial) index (would collide on explicit null)`, () => {
    const broken = singleFieldIndexes(Model, field).filter(
      (opts) => opts.unique && !opts.partialFilterExpression,
    );
    assert.equal(
      broken.length,
      0,
      `${name} has a unique index without a partialFilterExpression; ` +
        `with default:null this collides on the null key. Use a partial unique index.`,
    );
  });

  test(`${name}: has a partial unique index scoped to string values only`, () => {
    const good = singleFieldIndexes(Model, field).find(
      (opts) =>
        opts.unique &&
        opts.partialFilterExpression &&
        opts.partialFilterExpression[field] &&
        opts.partialFilterExpression[field].$type === 'string',
    );
    assert.ok(
      good,
      `${name} must have { unique:true, partialFilterExpression:{ ${field}: { $type: 'string' } } }`,
    );
  });
}
