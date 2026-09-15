import { ClaimsService } from './claims.service.js';
import { createClaimsRouter } from './claims.routes.js';

export const claimsService = new ClaimsService();
export const claimsRouter = createClaimsRouter(claimsService);

export { ClaimsService } from './claims.service.js';
