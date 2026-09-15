import { z } from 'zod';
import { STAFF_STATUS, CREDENTIAL_STATUS } from '../../models/enums.js';

const uuidSchema = z.string().uuid();
const nameSchema = z.string().trim().min(1).max(100);
const optStr = (max) => z.string().trim().min(1).max(max).optional();
const dateSchema = z.string().trim().refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date');

// --- staff profile ---------------------------------------------------------

// Public Add-Staff input: the admin supplies email + role; the server creates
// and links the user account. A userId is NEVER accepted from the client.
// Hourly Pay Rate is the staff member's compensation (spec Module 1). It is
// captured in whole dollars/hour here and persisted to the authoritative,
// effective-dated PayRate model (minor units). It belongs to the STAFF, never to
// a care-team assignment.
const hourlyPayRateSchema = z.coerce.number().min(0).max(10000);

export const provisionStaffSchema = z
  .object({
    firstName: nameSchema,
    middleName: optStr(80),
    lastName: nameSchema,
    email: z.string().trim().toLowerCase().email(),
    roleKey: z.enum(['bcba', 'rbt']),
    title: optStr(120),
    discipline: optStr(80),
    // Employee ID is SERVER-generated (never client-supplied) — see staff.service.
    hourlyPayRate: hourlyPayRateSchema.optional(),
    startDate: dateSchema.optional(),
    notes: optStr(1000),
  })
  .strict();

export const createStaffSchema = z
  .object({
    userId: uuidSchema,
    firstName: nameSchema,
    middleName: optStr(80),
    lastName: nameSchema,
    title: optStr(120),
    discipline: optStr(80),
    status: z.enum(STAFF_STATUS).optional(),
    startDate: dateSchema.optional(),
    notes: optStr(1000),
  })
  .strict();

export const updateStaffSchema = z
  .object({
    firstName: nameSchema.optional(),
    // Optional text fields accept null on update so an admin can clear them.
    middleName: optStr(80).nullable(),
    lastName: nameSchema.optional(),
    // Company Admin can update the staff member's login email (canonical on the
    // User row). Employee ID is server-managed and NOT accepted here.
    email: z.string().trim().toLowerCase().email().optional(),
    title: optStr(120).nullable(),
    discipline: optStr(80).nullable(),
    hourlyPayRate: hourlyPayRateSchema.optional(),
    status: z.enum(STAFF_STATUS).optional(),
    startDate: dateSchema.optional(),
    notes: optStr(1000).nullable(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export const listStaffQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
  status: z.enum(STAFF_STATUS).optional(),
  search: z.string().trim().min(1).max(100).optional(),
});

export const staffIdParamsSchema = z.object({ staffId: uuidSchema });

// --- credentials -----------------------------------------------------------

export const createCredentialSchema = z
  .object({
    credentialType: z.string().trim().min(1).max(80),
    number: optStr(80),
    issuingAuthority: optStr(160),
    issuedDate: dateSchema.optional(),
    expiresDate: dateSchema.optional(),
    status: z.enum(CREDENTIAL_STATUS).optional(),
  })
  .strict();

export const updateCredentialSchema = createCredentialSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'Provide at least one field to update' },
);

export const credentialParamsSchema = z.object({ staffId: uuidSchema, credentialId: uuidSchema });

// --- supervision -----------------------------------------------------------

export const assignSuperviseeSchema = z
  .object({
    superviseeStaffId: uuidSchema,
    startDate: dateSchema.optional(),
  })
  .strict();

export const superviseeParamsSchema = z.object({ staffId: uuidSchema, superviseeStaffId: uuidSchema });
