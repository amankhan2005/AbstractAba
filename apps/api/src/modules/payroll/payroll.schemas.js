import { z } from 'zod';

const money = z.number().int().min(0);

export const createPayRateSchema = z.object({
  staffProfileId: z.string().min(1),
  rateType: z.enum(['HOURLY', 'PER_SESSION', 'SALARY']),
  amount: money,
  currency: z.string().trim().length(3).optional(),
  effectiveFrom: z.coerce.date(),
  effectiveTo: z.coerce.date().optional(),
});

export const createPayPeriodSchema = z.object({
  label: z.string().trim().min(2).max(120),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
});

export const openTimesheetSchema = z.object({
  staffProfileId: z.string().min(1),
  payPeriodId: z.string().min(1),
});

export const manualEntrySchema = z.object({
  workDate: z.coerce.date(),
  minutes: z.number().int().min(1).max(1440),
  note: z.string().trim().max(500).optional(),
});

export const timesheetTransitionSchema = z.object({
  target: z.enum(['SUBMITTED', 'APPROVED', 'REJECTED', 'DRAFT']),
  reason: z.string().trim().max(500).optional(),
});

export const generateRunSchema = z.object({
  payPeriodId: z.string().min(1),
});

export const runTransitionSchema = z.object({
  target: z.enum(['APPROVED', 'FINALIZED', 'DRAFT']),
});

// Company Admin period payroll (spec §1). Mode drives which dates are required;
// custom needs from+to (YYYY-MM-DD). weekly/biweekly may carry an optional
// anchor (a date inside the desired week) — never trusted for totals, only for
// resolving the window server-side.
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
export const periodPayrollQuerySchema = z.object({
  mode: z.enum(['weekly', 'biweekly', 'custom']),
  from: ymd.optional(),
  to: ymd.optional(),
  anchor: ymd.optional(),
}).refine((v) => v.mode !== 'custom' || (v.from && v.to), {
  message: 'Select a From Date and a To Date.', path: ['from'],
});

export const generatePeriodSchema = periodPayrollQuerySchema;
