import { parseCsv, toSafeCsv } from './csv.js';
import { IMPORTERS, validateImport } from './import.engine.js';
import { EXPORT_ENTITIES } from './export.engine.js';
import { recordSafely } from '../audit/audit.service.js';
import { AppError } from '../../common/errors/AppError.js';

/**
 * Bulk import + organization export. Import reuses the existing per-entity create
 * services (so every row goes through the SAME model validation, PHI sealing,
 * tenant assignment, and audit as a single create) — no bulk path bypasses
 * model-level authorization. Export generates a tenant-scoped, field-allowlisted
 * CSV bundle and stores it via the Phase 4.1 storage abstraction.
 *
 * Tenant is always the caller's active tenant (passed by the controller from the
 * principal). The CSV never supplies tenant, ownership, audit actor, or roles.
 */
export class BulkService {
  constructor(deps) {
    this.deps = deps; // { clients, staff, repositories, storage, exportRepo }
  }

  // --- import --------------------------------------------------------------

  /**
   * Validate a CSV without persisting anything (preview). Returns the same
   * summary the commit path uses, plus DB-duplicate detection (tenant-scoped).
   */
  async previewImport({ tenantId, entity, csvText }) {
    const importer = IMPORTERS[entity];
    if (!importer) throw AppError.validation(`Unknown import entity: ${entity}`);
    const { rows } = parseCsv(csvText);
    const result = validateImport(importer, rows);
    await this._markDbDuplicates(tenantId, entity, result);
    return { entity, dryRun: true, ...result };
  }

  /**
   * Commit an import. Validates first; only valid, non-duplicate rows are
   * created, each through the entity's own create service (independent
   * transactions — a failed row cannot partially mutate unrelated records).
   * Returns per-row outcomes.
   */
  async commitImport({ tenantId, actorUserId, entity, csvText }) {
    const importer = IMPORTERS[entity];
    if (!importer) throw AppError.validation(`Unknown import entity: ${entity}`);
    const { rows } = parseCsv(csvText);
    const result = validateImport(importer, rows);
    await this._markDbDuplicates(tenantId, entity, result);

    recordSafely({
      tenantId, actorId: actorUserId, action: 'bulk.import_started', entityType: entity, entityId: null,
      outcome: 'success', payload: { total: result.summary.total, valid: result.valid.length },
    });

    const created = [];
    const failed = [...result.invalid];
    for (const row of result.valid) {
      const { __row, ...fields } = row;
      try {
        const rec = await this._createOne(tenantId, actorUserId, entity, fields);
        created.push({ __row, id: rec.id ?? rec._id });
      } catch (err) {
        // A create failure (e.g. race on a unique index) is isolated to this row.
        failed.push({ __row, errors: [this._safeError(err)] });
      }
    }

    const outcome = { entity, created: created.length, failed: failed.length, createdRows: created, failedRows: failed };
    recordSafely({
      tenantId, actorId: actorUserId,
      action: created.length > 0 ? 'bulk.import_completed' : 'bulk.import_failed',
      entityType: entity, entityId: null, outcome: 'success',
      payload: { created: created.length, failed: failed.length },
    });
    return outcome;
  }

  async _createOne(tenantId, actorUserId, entity, fields) {
    if (entity === 'clients') return this.deps.clients.createClient({ tenantId, actorUserId, input: fields });
    if (entity === 'staff') return this.deps.staff.createStaff({ tenantId, actorUserId, input: fields });
    throw AppError.validation(`Unknown import entity: ${entity}`);
  }

  /** Flag rows whose dedupe key already exists in the tenant (move to invalid). */
  async _markDbDuplicates(tenantId, entity, result) {
    const existing = await this.deps.repositories.existingKeys(tenantId, entity, result.valid);
    if (!existing || existing.size === 0) return;
    const importer = IMPORTERS[entity];
    const stillValid = [];
    for (const row of result.valid) {
      const key = importer.dedupeKey(row);
      if (existing.has(key)) {
        result.invalid.push({ __row: row.__row, errors: ['already exists in this organization'] });
        result.summary.invalid += 1;
        result.summary.valid -= 1;
        result.summary.duplicates += 1;
      } else {
        stillValid.push(row);
      }
    }
    result.valid = stillValid;
  }

  _safeError(err) {
    // Never leak internals/secrets in row errors.
    if (err?.code === 11000) return 'already exists in this organization';
    if (err?.expose && err?.message) return err.message;
    return 'could not be created';
  }

  // --- export --------------------------------------------------------------

  /**
   * Generate a tenant-scoped export. Each entity is serialized to an
   * injection-safe CSV using an explicit field allowlist (no secrets, PHI
   * envelopes, storage descriptors, tokens, or hashes). The bundle is stored via
   * the Phase 4.1 storage adapter under a tenant-partitioned key.
   */
  async generateExport({ tenantId, actorUserId }) {
    const record = await this.deps.exportRepo.createExport(tenantId, { organizationId: tenantId, requestedByUserId: actorUserId, state: 'BUILDING' });
    try {
      const files = {};
      for (const [entity, spec] of Object.entries(EXPORT_ENTITIES)) {
        const rows = await this.deps.repositories.exportRows(tenantId, entity);
        const mapped = rows.map(spec.map);
        files[`${entity}.csv`] = toSafeCsv(spec.headers, mapped);
      }
      // Combine into a single manifest artifact (one text blob; storage adapter
      // stores bytes). We store the concatenation with clear file delimiters.
      const bundle = Object.entries(files)
        .map(([name, csv]) => `# FILE: ${name}\r\n${csv}`)
        .join('\r\n\r\n');
      const buffer = Buffer.from(bundle, 'utf8');
      const key = this.deps.buildExportKey({ tenantId, exportId: record.id });
      await this.deps.storage.put(key, buffer, 'text/csv');

      const updated = await this.deps.exportRepo.completeExport(tenantId, record.id, {
        artifactRef: key, sizeBytes: buffer.length, state: 'AVAILABLE',
        availableAt: new Date(),
      });
      recordSafely({
        tenantId, actorId: actorUserId, action: 'organization.export_generated',
        entityType: 'organization_export', entityId: record.id, outcome: 'success',
        payload: { sizeBytes: buffer.length, entities: Object.keys(files) },
      });
      return updated;
    } catch (err) {
      await this.deps.exportRepo.failExport(tenantId, record.id, this._safeError(err));
      recordSafely({
        tenantId, actorId: actorUserId, action: 'organization.export_failed',
        entityType: 'organization_export', entityId: record.id, outcome: 'failure', payload: {},
      });
      throw err;
    }
  }

  async listExports({ tenantId }) {
    return this.deps.exportRepo.listExports(tenantId);
  }

  /** Stream an export artifact; re-asserts tenant ownership of the stored key. */
  async downloadExport({ tenantId, exportId, actorUserId }) {
    const record = await this.deps.exportRepo.findExportById(tenantId, exportId);
    if (!record || !record.artifactRef) throw AppError.notFound('EXPORT-404', 'Export not found');
    if (!this.deps.keyBelongsToTenant(record.artifactRef, tenantId)) {
      throw AppError.notFound('EXPORT-404', 'Export not found');
    }
    const { buffer } = await this.deps.storage.get(record.artifactRef);
    await this.deps.exportRepo.markDownloaded(tenantId, exportId);
    recordSafely({
      tenantId, actorId: actorUserId, action: 'organization.export_downloaded',
      entityType: 'organization_export', entityId: exportId, outcome: 'success', payload: {},
    });
    return { buffer, fileName: `organization-export-${exportId}.txt` };
  }
}
