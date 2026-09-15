import { env } from '../../../config/env.js';
import { LocalStorageAdapter } from './localStorageAdapter.js';

/**
 * Storage factory. Selects the adapter from env (default: local). To add S3,
 * implement the same { put, get, remove } contract and branch on 's3' here —
 * no caller changes required.
 */
export function createStorageAdapter(overrides = {}) {
  const driver = overrides.driver ?? env.documentStorageDriver;
  if (driver === 'local') {
    return new LocalStorageAdapter({ baseDir: overrides.baseDir ?? env.documentStorageDir });
  }
  throw new Error(`Unknown document storage driver: ${driver}`);
}

export { LocalStorageAdapter } from './localStorageAdapter.js';
