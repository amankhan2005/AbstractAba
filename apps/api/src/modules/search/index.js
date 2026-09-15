import { SearchService } from './search.service.js';
import { searchRepository } from './search.repository.js';
import { createSearchRouter } from './search.routes.js';

/**
 * Composition root for the global-search module. Read-only and cross-cutting: it
 * queries existing tenant-owned models through the shared tenant context, never
 * mutating and never reaching into another module's service internals.
 */
export const searchService = new SearchService({ repository: searchRepository });

export const searchRouter = createSearchRouter(searchService);

export { SearchService } from './search.service.js';
export { SearchController } from './search.controller.js';
export { searchRepository } from './search.repository.js';
