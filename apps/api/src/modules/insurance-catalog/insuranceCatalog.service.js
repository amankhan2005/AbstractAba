import { AppError } from '../../common/errors/AppError.js';
import { statesIntersect } from '../clients/insuranceEligibility.js';

/**
 * Insurance master catalog service (spec Module 5.1-5.5).
 *
 * Two audiences, one source of truth:
 *   - PLATFORM (Super Admin): full CRUD over the global catalog.
 *   - TENANT (company): read-only, and only the ACTIVE entries whose states
 *     intersect the company's own service states — so a company only ever sees
 *     insurers it can actually use (spec 5.4).
 *
 * The repository, organizations port, audit sink and logo uploader are all
 * injected so the whole service is exercised without a database or Cloudinary.
 * All state/authorization decisions are made here on the server; the browser
 * never supplies which company it is or which states it serves.
 *
 * AUDIT. Every Super Admin write (create, update, state change, logo, activate,
 * deactivate, archive) is recorded through the existing append-only audit
 * service (spec §19). The catalog is platform-global, so these land on a
 * dedicated platform chain (PLATFORM_AUDIT_TENANT) rather than any company's —
 * verifiable with the same tamper-detection as every tenant chain.
 */
export const PLATFORM_AUDIT_TENANT = '__platform__';

export class InsuranceCatalogService {
  constructor(deps) {
    // { repository, organizations, audit?, logoUploader? }
    this.deps = deps;
  }

  // --- platform (Super Admin) ------------------------------------------------

  async list({ activeOnly = false, state = null } = {}) {
    return this.deps.repository.list({ activeOnly, state });
  }

  async get(id) {
    const entry = await this.deps.repository.findById(id);
    if (!entry) throw AppError.notFound('INSURANCE_CATALOG_NOT_FOUND', 'Insurance not found.');
    return entry;
  }

  async create({ actorUserId, input }) {
    const doc = {
      name: input.name.trim(),
      states: normalizeStates(input.states),
      logoUrl: input.logoUrl?.trim() || null,
      active: input.active ?? true,
      notes: input.notes?.trim() || null,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    };
    const created = await this.deps.repository.create(doc);
    await this._audit(actorUserId, 'insurance_catalog.created', created.id, {
      after: { name: created.name, states: created.states, active: created.active, hasLogo: Boolean(created.logoUrl) },
    });
    return created;
  }

  async update({ id, actorUserId, input }) {
    const before = await this.get(id); // 404 if missing
    const patch = { updatedBy: actorUserId };
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.states !== undefined) patch.states = normalizeStates(input.states);
    if (input.logoUrl !== undefined) patch.logoUrl = input.logoUrl?.trim() || null;
    if (input.active !== undefined) patch.active = input.active;
    if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
    const updated = await this.deps.repository.update(id, patch);

    // A change to `active` is the activate/deactivate action §19 lists by name;
    // a change to `states` is the "states changed" action. Emit the specific
    // one(s) that apply, plus a general update record so the trail is complete.
    if (input.active !== undefined && input.active !== before.active) {
      await this._audit(actorUserId, input.active ? 'insurance_catalog.activated' : 'insurance_catalog.deactivated', id, {
        before: { active: before.active }, after: { active: updated.active },
      });
    }
    if (input.states !== undefined && !sameStates(before.states, updated.states)) {
      await this._audit(actorUserId, 'insurance_catalog.states_changed', id, {
        before: { states: before.states }, after: { states: updated.states },
      });
    }
    await this._audit(actorUserId, 'insurance_catalog.updated', id, {
      changed: Object.keys(patch).filter((k) => k !== 'updatedBy'),
    });
    return updated;
  }

  async remove({ id, actorUserId }) {
    await this.get(id); // 404 if missing
    const result = await this.deps.repository.softDelete(id, actorUserId);
    await this._audit(actorUserId, 'insurance_catalog.archived', id, {});
    return result;
  }

  /**
   * Upload (or replace) an insurance company's logo through the existing
   * Cloudinary uploader (spec Module 6). The bytes are validated server-side by
   * magic number — the request-declared content type is not trusted — and the
   * asset is foldered per catalog entry with a deterministic public id, so a
   * replacement overwrites the previous file rather than orphaning it.
   */
  async uploadLogo({ id, buffer, actorUserId }) {
    await this.get(id); // 404 if missing
    if (!this.deps.logoUploader) {
      throw AppError.validation('Image uploads aren’t available on this server.');
    }
    const { url } = await this.deps.logoUploader({
      publicId: `aba1on1/insurance-catalog/${id}/logo`,
      buffer,
    });
    const updated = await this.deps.repository.update(id, { logoUrl: url, updatedBy: actorUserId });
    await this._audit(actorUserId, 'insurance_catalog.logo_uploaded', id, { after: { hasLogo: true } });
    return updated;
  }

  // --- tenant (company) ------------------------------------------------------

  /**
   * The catalog a company may pick from: ACTIVE entries whose states intersect
   * the company's service states. Company identity + states are resolved on the
   * SERVER from the authenticated tenant — never trusted from the browser
   * (spec 5.4 / security). If the company has no service states configured we
   * fall back to its single stateCode, and if it has neither we return the full
   * active catalog rather than silently blocking all insurance entry.
   */
  async listForCompany({ tenantId }) {
    const org = await this.deps.organizations.getById(tenantId);
    const states = resolveCompanyStates(org);
    const active = await this.deps.repository.list({ activeOnly: true });
    if (states.length === 0) return active;
    return active.filter((e) => statesIntersect(states, e.states));
  }

  // --- audit -----------------------------------------------------------------

  async _audit(actorUserId, action, entityId, payload) {
    if (!this.deps.audit?.record) return; // audit is optional in unit tests
    try {
      await this.deps.audit.record({
        tenantId: PLATFORM_AUDIT_TENANT,
        actorId: actorUserId ?? null,
        action,
        entityType: 'insurance_catalog',
        entityId,
        outcome: 'success',
        payload: payload ?? {},
      });
    } catch {
      // An audit append must never break the operator's action; the audit
      // service already logs its own failures.
    }
  }
}

function normalizeStates(states) {
  if (!Array.isArray(states)) return [];
  return [...new Set(states.map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
}

function sameStates(a, b) {
  const sa = new Set((a ?? []).map((s) => String(s).toUpperCase()));
  const sb = new Set((b ?? []).map((s) => String(s).toUpperCase()));
  if (sa.size !== sb.size) return false;
  for (const s of sa) if (!sb.has(s)) return false;
  return true;
}

function resolveCompanyStates(org) {
  if (!org) return [];
  if (Array.isArray(org.serviceStates) && org.serviceStates.length > 0) {
    return org.serviceStates.map((s) => String(s).toUpperCase());
  }
  if (org.stateCode) return [String(org.stateCode).toUpperCase()];
  return [];
}
