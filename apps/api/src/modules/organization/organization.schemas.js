import { z } from 'zod';
import { ORGANIZATION_STATE, US_STATE_CODES } from '../../models/enums.js';
import { isValidTimeZone } from '../../domain/businessDate.js';

// Operating states (spec Module 5.3): a de-duplicated list of canonical US
// state codes. Same shape for onboarding and settings so both write the one
// serviceStates field. Uppercased before validation so a lowercase code from a
// form still matches the canonical enum.
const serviceStatesSchema = z
  .array(z.string().trim().toUpperCase().pipe(z.enum(US_STATE_CODES)))
  .max(51)
  .transform((list) => [...new Set(list)]);

/**
 * Request schemas for the organization module. Shape validation lives here;
 * business rules (slug reservation, lifecycle legality, separation of duties)
 * live in the service. Mirrors the original split.
 *
 * The original imported shared primitives from @aba1on1/schemas; those are
 * inlined here as equivalent zod definitions since the MERN build has no shared
 * schema package.
 */
const slugSchema = z
  .string().trim().toLowerCase()
  .min(3, 'Use 3 to 40 lowercase letters, numbers or hyphens')
  .max(40, 'Use 3 to 40 lowercase letters, numbers or hyphens')
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Use 3 to 40 lowercase letters, numbers or hyphens');

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const countryCodeSchema = z.string().trim().toUpperCase().length(2);
// The organization's business timezone: a real IANA zone identifier (e.g.
// America/New_York). Stored as the identifier, never a display label or offset.
const timezoneSchema = z.string().trim().min(1).max(64)
  .refine(isValidTimeZone, { message: 'Choose a valid time zone.' });
const localeSchema = z.string().trim().min(2).max(35);
const uuidSchema = z.string().uuid();

export const createOrganizationSchema = z.object({
  slug: slugSchema,
  legalName: z.string().trim().min(2).max(200),
  tradingName: z.string().trim().min(2).max(200),
  countryCode: countryCodeSchema,
  stateCode: z.string().trim().min(1).max(10).optional(),
  timezone: timezoneSchema,
  locale: localeSchema.optional(),
  primaryContactName: z.string().trim().min(2).max(200),
  primaryContactEmail: emailSchema,
  planCode: z.string().trim().min(1).max(50).optional(),
  // US states this company operates in (spec Module 5.3). Optional at creation
  // so pre-feature callers still work; drives which catalog insurers appear.
  serviceStates: serviceStatesSchema.optional(),
  // Set by the onboarding form after a direct-to-Cloudinary upload completes
  // (see modules/company-invitations/logo-upload.routes.js); Cloudinary's own
  // secure_url shape, never a client-chosen arbitrary URL.
  logoUrl: z.string().trim().url().max(500).optional(),
});

export const organizationIdParamsSchema = z.object({ id: uuidSchema });

export const listOrganizationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
  state: z.enum(ORGANIZATION_STATE).optional(),
  search: z.string().trim().min(1).max(100).optional(),
});

export const transitionSchema = z.object({
  toState: z.enum(ORGANIZATION_STATE),
  reason: z.string().trim().min(5, 'Give a reason of at least 5 characters').max(500),
  destruction: z
    .object({ requestedByUserId: uuidSchema, exportCompleted: z.boolean() })
    .optional(),
});

export const updateProfileSchema = z
  .object({
    tradingName: z.string().trim().min(2).max(200).optional(),
    primaryContactName: z.string().trim().min(2).max(200).optional(),
    // primaryContactEmail is intentionally NOT accepted here. It is the owner's
    // login identity, set once at onboarding and derived from the authenticated
    // account — never mutable through the company profile. It is absent from this
    // schema, so zod strips it from any request body: a change attempt is
    // silently ignored, never honoured. The editable public address is contactEmail.
    timezone: timezoneSchema.optional(),
    locale: localeSchema.optional(),
    // Public company contact profile (footer source). Nullable so a field can
    // be cleared. Never accepted as email authority — used only for display.
    contactPhone: z.string().trim().max(40).nullable().optional(),
    contactEmail: emailSchema.nullable().optional(),
    websiteUrl: z.string().trim().max(200).nullable().optional(),
    addressLine1: z.string().trim().max(200).nullable().optional(),
    addressLine2: z.string().trim().max(200).nullable().optional(),
    city: z.string().trim().max(120).nullable().optional(),
    postalCode: z.string().trim().max(20).nullable().optional(),
    // Operating states (spec Module 5.3 / Company Settings). The SAME field
    // onboarding writes — add/remove states here and catalog eligibility for
    // NEW client-insurance selections recomputes automatically. Existing
    // coverage rows are never touched by a state change.
    serviceStates: serviceStatesSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Supply at least one field to update' });

export const brandingQuerySchema = z.object({ host: z.string().trim().min(1).max(253) });
export const switchOrganizationSchema = z.object({ organizationId: uuidSchema });
