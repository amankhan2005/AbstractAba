import * as models from '../../models/index.js';
import { withTenant } from '../../tenancy/tenantContext.js';
import { SEARCH_ENTITIES, buildEntityFilter } from './search.engine.js';

/**
 * Search data access. Every query runs inside withTenant(tenantId) so the tenant
 * plugin scopes and fails closed — the caller's tenant is authoritative and is
 * never taken from the client. The model is resolved from the engine's registry
 * (a fixed allowlist), not from any client-supplied name.
 */
export class SearchRepository {
  /**
   * Run one entity's search. Returns { type, items, nextCursor, hasMore }.
   * Cursor pagination mirrors the existing list endpoints (_id descending, or
   * the entity's declared sort with an _id tiebreaker for stability).
   */
  async searchEntity(tenantId, entityKey, { term, filters, limit, cursor, sort }) {
    const spec = SEARCH_ENTITIES[entityKey];
    const Model = models[spec.modelName];
    if (!Model) throw new Error(`Search model not found: ${spec.modelName}`);

    return withTenant(tenantId, async () => {
      const filter = buildEntityFilter(entityKey, { term, filters });
      // Stable pagination on _id (descending). A cursor is an _id boundary.
      if (cursor) filter._id = { $lt: cursor };
      const projection = spec.projection ?? {};
      const rows = await Model.find(filter)
        .select(projection)
        .sort({ _id: -1 })
        .limit(limit + 1)
        .lean();
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return {
        type: entityKey,
        items: page.map(spec.map),
        nextCursor: hasMore ? page[page.length - 1]._id : null,
        hasMore,
      };
    });
  }

  /** Count matches for one entity (for result metadata / facets). */
  async countEntity(tenantId, entityKey, { term, filters }) {
    const spec = SEARCH_ENTITIES[entityKey];
    const Model = models[spec.modelName];
    return withTenant(tenantId, async () => {
      const filter = buildEntityFilter(entityKey, { term, filters });
      return Model.countDocuments(filter);
    });
  }
}

export const searchRepository = new SearchRepository();
