import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../../common/errors/AppError.js';
import { parseStorageKey } from './storageKey.js';

/**
 * Local-filesystem storage adapter. Implements the storage contract:
 *   put(key, buffer, contentType) -> void
 *   get(key) -> { buffer, contentType }
 *   remove(key) -> void
 * Production can swap in an S3 adapter with the same shape (env driver) without
 * changing any caller. Paths are confined under baseDir; key traversal is
 * rejected.
 */
export class LocalStorageAdapter {
  constructor({ baseDir }) {
    this.baseDir = path.resolve(baseDir);
  }

  #resolve(key) {
    if (!parseStorageKey(key)) throw AppError.validation('Invalid storage key.');
    const full = path.resolve(this.baseDir, key);
    // Confinement: the resolved path must stay under baseDir.
    if (full !== this.baseDir && !full.startsWith(this.baseDir + path.sep)) {
      throw AppError.forbidden('DOC-403', 'Illegal storage path.');
    }
    return full;
  }

  async put(key, buffer, contentType) {
    const full = this.#resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buffer);
    await fs.writeFile(`${full}.meta`, JSON.stringify({ contentType }), 'utf8');
  }

  async get(key) {
    const full = this.#resolve(key);
    try {
      const buffer = await fs.readFile(full);
      let contentType = 'application/octet-stream';
      try { contentType = JSON.parse(await fs.readFile(`${full}.meta`, 'utf8')).contentType ?? contentType; } catch { /* meta optional */ }
      return { buffer, contentType };
    } catch {
      throw AppError.notFound('DOC-404', 'Stored file not found.');
    }
  }

  async remove(key) {
    const full = this.#resolve(key);
    await fs.rm(full, { force: true });
    await fs.rm(`${full}.meta`, { force: true });
  }
}
