import { ReconciliationService } from './reconciliation.service.js';
import { createReconciliationRouter } from './reconciliation.routes.js';

export const reconciliationService = new ReconciliationService();
export const reconciliationRouter = createReconciliationRouter(reconciliationService);

export { ReconciliationService } from './reconciliation.service.js';
