import { AppError } from '../../common/errors/AppError.js';
import { SETTINGS_CATALOGUE } from './settings.catalogue.js';

const notFound = (namespace) => new AppError('NOT_FOUND', { status: 404, message: 'Unknown settings namespace', context: { namespace } });
const validationFailed = (details) => new AppError('VALIDATION_FAILED', { status: 422, message: 'Validation failed', details });

/**
 * The settings registry, ported from the original. Its real work happens at
 * construction: it indexes the catalogue, refuses a duplicate namespace/key, and
 * checks every declared default against its own schema — so an inconsistent
 * catalogue stops the process from booting. At runtime it is the single
 * authority: it resolves stored rows over defaults and validates writes,
 * rejecting any unregistered key.
 */
export class SettingsRegistry {
  constructor(descriptors = SETTINGS_CATALOGUE) {
    const map = new Map();
    for (const d of descriptors) {
      let ns = map.get(d.namespace);
      if (!ns) { ns = new Map(); map.set(d.namespace, ns); }
      if (ns.has(d.key)) throw new Error(`Settings registry: duplicate "${d.namespace}.${d.key}".`);
      if (!d.schema.safeParse(d.default).success) {
        throw new Error(`Settings registry: default for "${d.namespace}.${d.key}" does not satisfy its own schema.`);
      }
      ns.set(d.key, d);
    }
    this.byNamespace = map;
  }

  namespaces() { return [...this.byNamespace.keys()]; }
  has(namespace) { return this.byNamespace.has(namespace); }

  _require(namespace) {
    const found = this.byNamespace.get(namespace);
    if (!found) throw notFound(namespace);
    return found;
  }

  _defaultsFor(descriptors) {
    const out = {};
    for (const [key, d] of descriptors) out[key] = d.default;
    return out;
  }

  /** Effective values for every namespace: defaults overlaid with registered stored rows. */
  resolve(stored) {
    const out = {};
    for (const [namespace, descriptors] of this.byNamespace) out[namespace] = this._defaultsFor(descriptors);
    for (const row of stored) {
      const descriptors = this.byNamespace.get(row.namespace);
      if (descriptors?.has(row.key)) out[row.namespace][row.key] = row.value;
    }
    return out;
  }

  /** Effective values for one namespace; NOT_FOUND if unknown. */
  resolveNamespace(namespace, stored) {
    const descriptors = this._require(namespace);
    const out = this._defaultsFor(descriptors);
    for (const row of stored) {
      if (row.namespace === namespace && descriptors.has(row.key)) out[row.key] = row.value;
    }
    return out;
  }

  /**
   * Validates a write patch and returns the rows to persist. Unknown namespace →
   * NOT_FOUND; empty patch, unregistered key, or schema-failing value →
   * VALIDATION_FAILED with field detail. Nothing outside the catalogue is writable.
   */
  validatePatch(namespace, patch) {
    const descriptors = this._require(namespace);
    const keys = Object.keys(patch);
    if (keys.length === 0) {
      throw validationFailed([{ path: 'body', message: 'Provide at least one setting to update.' }]);
    }
    const details = [];
    const entries = [];
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (!descriptor) { details.push({ path: `body.${key}`, message: 'Unknown setting for this namespace.' }); continue; }
      const parsed = descriptor.schema.safeParse(patch[key]);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) details.push({ path: `body.${key}`, message: issue.message });
        continue;
      }
      entries.push({ namespace, key, value: parsed.data });
    }
    if (details.length > 0) throw validationFailed(details);
    return entries;
  }
}
