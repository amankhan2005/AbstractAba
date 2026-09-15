import { PayrollService } from './payroll.service.js';
import { createPayrollRouter } from './payroll.routes.js';

export const payrollService = new PayrollService();
export const payrollRouter = createPayrollRouter(payrollService);

export { PayrollService } from './payroll.service.js';
