import { AppError } from '../../common/errors/AppError.js';
import { sendSuccess } from '../../common/http/responder.js';
import { SEARCH_ENTITIES } from './search.engine.js';

/**
 * Search HTTP surface. Tenant and permissions come from the authenticated
 * principal (server-authoritative); the client supplies only the query. Follows
 * the established controller conventions ({data} envelopes, static guards).
 */
export class SearchController {
  constructor(service) {
    this.service = service;
  }

  static requirePrincipal(req) {
    if (!req.principal) throw AppError.unauthorized('AUTH-401', 'Authentication required');
    return req.principal;
  }

  static requireTenantId(req) {
    const tenantId = req.principal?.activeTenantId;
    if (tenantId === undefined || tenantId === null) throw AppError.unauthorized('AUTH-401', 'Tenant context missing');
    return tenantId;
  }

  static permissionList(req) {
    // principal.permissions is a Set; the engine works with an array.
    return [...(req.principal?.permissions ?? [])];
  }

  // Collect the flat structured filters and route them to the entities that
  // declare each key (server-side; the client cannot target unknown fields).
  static filtersByType(query) {
    const flat = {};
    for (const key of ['status', 'documentType', 'discipline', 'clientId']) {
      if (query[key] != null) flat[key] = query[key];
    }
    const byType = {};
    for (const [type, spec] of Object.entries(SEARCH_ENTITIES)) {
      const allowed = {};
      for (const key of Object.keys(spec.filters ?? {})) {
        if (flat[key] != null) allowed[key] = flat[key];
      }
      if (Object.keys(allowed).length) byType[type] = allowed;
    }
    return byType;
  }

  globalSearch = async (req, res) => {
    SearchController.requirePrincipal(req);
    const result = await this.service.search({
      tenantId: SearchController.requireTenantId(req),
      permissions: SearchController.permissionList(req),
      term: req.query.q,
      types: req.query.types,
      filtersByType: SearchController.filtersByType(req.query),
      limit: req.query.limit,
    });
    sendSuccess(res, result);
  };

  entitySearch = async (req, res) => {
    SearchController.requirePrincipal(req);
    const type = req.params.entityType;
    const spec = SEARCH_ENTITIES[type];
    const filters = {};
    for (const key of Object.keys(spec.filters ?? {})) {
      if (req.query[key] != null) filters[key] = req.query[key];
    }
    const result = await this.service.searchOne({
      tenantId: SearchController.requireTenantId(req),
      permissions: SearchController.permissionList(req),
      entityKey: type,
      term: req.query.q,
      filters,
      limit: req.query.limit,
      cursor: req.query.cursor ?? null,
    });
    sendSuccess(res, result);
  };
}
