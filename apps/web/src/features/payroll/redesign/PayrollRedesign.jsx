import { PeriodPayrollPanel } from './PeriodPayrollPanel.jsx';

/**
 * PAYROLL — Company Admin payroll workspace. Choose a payroll period (Weekly /
 * Bi-weekly / Custom) → review each staff member's payout (actual worked hours ×
 * their Staff Profile hourly rate, calculated on the server) → Generate Payroll →
 * Download Excel / Download PDF. The whole experience lives in PeriodPayrollPanel.
 */
export function PayrollRedesign() {
  return <PeriodPayrollPanel />;
}

export default PayrollRedesign;
