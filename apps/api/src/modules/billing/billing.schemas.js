import { z } from 'zod';

const money = z.number().int().min(0);

export const createPlanSchema = z.object({
  code: z.string().trim().min(2).max(40),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).optional(),
  monthlyPrice: money,
  yearlyPrice: money,
  currency: z.string().trim().length(3).optional(),
  interval: z.enum(['MONTHLY', 'YEARLY']).optional(),
  trialDays: z.number().int().min(0).max(365).optional(),
  features: z.array(z.string()).optional(),
});

export const updatePlanSchema = createPlanSchema.partial().extend({ active: z.boolean().optional() });

export const assignSubscriptionSchema = z.object({
  organizationId: z.string().min(1),
  planId: z.string().min(1),
  billingInterval: z.enum(['MONTHLY', 'YEARLY']).optional(),
  // Optional explicit validity (spec §8). When omitted, the service computes the
  // end from the interval. Range validity (end > start) is enforced server-side.
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
}).refine((v) => !(v.startDate && v.endDate) || v.endDate > v.startDate, {
  message: 'The renewal/expiration date must be after the start date.', path: ['endDate'],
});

export const changePackageSchema = z.object({
  organizationId: z.string().min(1),
  planId: z.string().min(1),
  billingInterval: z.enum(['MONTHLY', 'YEARLY']).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
}).refine((v) => !(v.startDate && v.endDate) || v.endDate > v.startDate, {
  message: 'The renewal/expiration date must be after the start date.', path: ['endDate'],
});

export const extendSubscriptionSchema = z.object({
  endDate: z.coerce.date(),
});

export const updateValiditySchema = z.object({
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
}).refine((v) => v.startDate || v.endDate, { message: 'Provide a start or end date to update.' })
  .refine((v) => !(v.startDate && v.endDate) || v.endDate > v.startDate, {
    message: 'The renewal/expiration date must be after the start date.', path: ['endDate'],
  });

export const transitionSubscriptionSchema = z.object({
  target: z.enum(['ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELED']),
  atPeriodEnd: z.boolean().optional(),
});

export const generateInvoiceSchema = z.object({
  organizationId: z.string().min(1),
  subscriptionId: z.string().optional(),
  dueDate: z.coerce.date().optional(),
  generationKey: z.string().optional(),
  lines: z.array(z.object({
    description: z.string().trim().min(1).max(300),
    quantity: z.number().min(0),
    unitAmount: z.number().int(),
    periodStart: z.coerce.date().optional(),
    periodEnd: z.coerce.date().optional(),
  })).min(1),
});

export const recordPaymentSchema = z.object({
  invoiceId: z.string().min(1),
  amount: money.refine((v) => v > 0, 'Amount must be greater than zero.'),
  paymentMethod: z.enum(['BANK_TRANSFER', 'CHECK', 'CASH', 'OTHER']).optional(),
  referenceNumber: z.string().trim().max(120).optional(),
  paymentDate: z.coerce.date().optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const issueCreditSchema = z.object({
  organizationId: z.string().min(1),
  invoiceId: z.string().optional(),
  amount: money,
  reason: z.string().trim().min(2).max(500),
});
