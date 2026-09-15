import { ReportsService } from './reports.service.js';
import { createReportsRouter } from './reports.routes.js';

export const reportsService = new ReportsService();
export const reportsRouter = createReportsRouter(reportsService);

export { ReportsService } from './reports.service.js';
