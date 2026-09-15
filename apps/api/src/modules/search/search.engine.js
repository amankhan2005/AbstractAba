import { AppError } from '../../common/errors/AppError.js';
import { escapeRegExp } from '../../common/text/escapeRegExp.js';

/**
 * Global-search engine (pure). Declares WHICH entities are searchable, the
 * permission required to see each, the text fields matched, the structured
 * filters allowed, and how a row maps to a lean, PHI-safe result. No I/O — the
 * repository executes the plan this builds, always inside withTenant().
 *
 * Security properties enforced here:
 *  - Every entity is gated by a read permission; an entity the caller cannot
 *    read is never queried (no existence leak).
 *  - Search terms are escaped (literal match) — no regex injection / ReDoS.
 *  - Result mappers project only safe, non-PHI-envelope fields.
 */

export const SEARCH_ENTITIES = {
  clients: {
    permission: 'clients.read',
    modelName: 'Client',
    textFields: ['firstName', 'lastName', 'clientNumber'],
    filters: { status: { field: 'status', kind: 'enum' } },
    projection: { sensitive: 0 },
    sort: { lastName: 1, firstName: 1 },
    map: (d) => ({ id: d._id, type: 'client', label: [d.firstName, d.lastName].filter(Boolean).join(' '), clientNumber: d.clientNumber ?? null, status: d.status }),
  },
  staff: {
    permission: 'staff.read',
    modelName: 'StaffProfile',
    textFields: ['firstName', 'lastName', 'employeeNumber'],
    filters: { status: { field: 'status', kind: 'enum' }, discipline: { field: 'discipline', kind: 'string' } },
    sort: { lastName: 1, firstName: 1 },
    map: (d) => ({ id: d._id, type: 'staff', label: [d.firstName, d.lastName].filter(Boolean).join(' '), discipline: d.discipline ?? null, status: d.status }),
  },
  authorizations: {
    permission: 'scheduling.read',
    modelName: 'Authorization',
    textFields: ['authorizationNumber', 'payerName', 'serviceCode'],
    filters: { status: { field: 'status', kind: 'enum' }, clientId: { field: 'clientId', kind: 'id' } },
    sort: { startDate: -1 },
    map: (d) => ({ id: d._id, type: 'authorization', label: d.authorizationNumber ?? '(unnumbered)', payerName: d.payerName ?? null, serviceCode: d.serviceCode ?? null, status: d.status }),
  },
  documents: {
    permission: 'documents.read',
    modelName: 'ClinicalDocument',
    textFields: ['title', 'description'],
    filters: { status: { field: 'status', kind: 'enum' }, documentType: { field: 'documentType', kind: 'string' }, clientId: { field: 'clientId', kind: 'id' } },
    projection: { storageRef: 0, checksum: 0 },
    sort: { createdAt: -1 },
    map: (d) => ({ id: d._id, type: 'document', label: d.title, documentType: d.documentType ?? null, status: d.status }),
  },
  claims: {
    permission: 'claims.read',
    modelName: 'Claim',
    textFields: ['claimNumber', 'payerName', 'payerControlNumber'],
    filters: { status: { field: 'status', kind: 'enum' }, clientId: { field: 'clientId', kind: 'id' } },
    sort: { createdAt: -1 },
    map: (d) => ({ id: d._id, type: 'claim', label: d.claimNumber ?? '(draft)', payerName: d.payerName ?? null, status: d.status }),
  },
};

export const SEARCHABLE_TYPES = Object.keys(SEARCH_ENTITIES);

/**
 * Given the caller's permission set and a requested entity list, return the
 * entities that are BOTH requested (or all, if none requested) AND authorized.
 * Requesting an unknown type is a validation error; requesting an unauthorized
 * type simply omits it (no leak, no error).
 */
export function resolveSearchableEntities({ requestedTypes, permissions }) {
  const has = (p) => permissions.includes(p);
  let types = SEARCHABLE_TYPES;
  if (requestedTypes && requestedTypes.length) {
    for (const t of requestedTypes) {
      if (!SEARCH_ENTITIES[t]) throw AppError.validation(`Unknown search type: ${t}`);
    }
    types = requestedTypes;
  }
  return types.filter((t) => has(SEARCH_ENTITIES[t].permission));
}

/**
 * Build the MongoDB filter for one entity from the escaped term + structured
 * filters. Always includes deletedAt:null; tenant scoping is applied by the
 * repository via withTenant (never here, never from the client).
 */
export function buildEntityFilter(entityKey, { term, filters = {} }) {
  const spec = SEARCH_ENTITIES[entityKey];
  if (!spec) throw AppError.validation(`Unknown search type: ${entityKey}`);
  const mongo = { deletedAt: null };

  if (term != null && String(term).trim() !== '') {
    const rx = new RegExp(escapeRegExp(String(term).trim()), 'i');
    mongo.$or = spec.textFields.map((f) => ({ [f]: rx }));
  }

  for (const [key, value] of Object.entries(filters)) {
    if (value == null || value === '') continue;
    const fspec = spec.filters?.[key];
    if (!fspec) throw AppError.validation(`Unsupported filter "${key}" for ${entityKey}.`);
    mongo[fspec.field] = value;
  }
  return mongo;
}
