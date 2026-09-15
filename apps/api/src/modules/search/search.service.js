import { resolveSearchableEntities, SEARCH_ENTITIES } from './search.engine.js';

/**
 * Global-search orchestration. Read-only and strictly tenant-scoped:
 *  - The tenant comes from the authenticated principal's active tenant (passed
 *    by the controller from tenant context), never from the client body/query.
 *  - Only entities the caller is authorized to read are searched; unauthorized
 *    types are silently omitted (no existence leak).
 *  - No mutations, so no audit events (consistent with the codebase, which
 *    audits writes, not reads).
 */
export class SearchService {
  /** @param {{ repository: object }} deps */
  constructor(deps) {
    this.deps = deps;
  }

  /**
   * Multi-entity search. Returns per-entity groups plus aggregate metadata.
   *   { term, groups: [{ type, items, nextCursor, hasMore, count }], totalCount,
   *     searchedTypes }
   */
  async search({ tenantId, permissions, term, types, filtersByType = {}, limit = 10 }) {
    const searchable = resolveSearchableEntities({ requestedTypes: types, permissions });

    const groups = [];
    let totalCount = 0;
    for (const entityKey of searchable) {
      const filters = filtersByType[entityKey] ?? {};
      const [page, count] = await Promise.all([
        this.deps.repository.searchEntity(tenantId, entityKey, { term, filters, limit, cursor: null }),
        this.deps.repository.countEntity(tenantId, entityKey, { term, filters }),
      ]);
      groups.push({ ...page, count });
      totalCount += count;
    }

    return { term: term ?? null, groups, totalCount, searchedTypes: searchable };
  }

  /**
   * Single-entity search with cursor pagination — used to page within one
   * entity's results. Enforces the same authorization gate.
   */
  async searchOne({ tenantId, permissions, entityKey, term, filters = {}, limit = 25, cursor = null }) {
    const searchable = resolveSearchableEntities({ requestedTypes: [entityKey], permissions });
    if (searchable.length === 0) {
      // Not authorized for this entity → empty, indistinguishable from no matches.
      return { type: entityKey, items: [], nextCursor: null, hasMore: false, count: 0 };
    }
    const [page, count] = await Promise.all([
      this.deps.repository.searchEntity(tenantId, entityKey, { term, filters, limit, cursor }),
      this.deps.repository.countEntity(tenantId, entityKey, { term, filters }),
    ]);
    return { ...page, count };
  }
}

export { SEARCH_ENTITIES };
