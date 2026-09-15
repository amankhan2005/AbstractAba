import { z } from 'zod';
import { US_STATE_CODES } from '../../models/enums.js';
import { isValidTimeZone } from '../../domain/businessDate.js';

/**
 * Public self-serve clinic signup (BR-3). Captures only the fields the existing
 * domain already requires to stand up an organization, invite its first owner,
 * and record the business-associate agreement. No tenant id, state, role,
 * provisioning, or other server-authoritative field is accepted — those are all
 * derived server-side by reusing the existing organization / onboarding / users
 * services. The organization is created behind the SAME agreement gate: signup
 * reaches PENDING_AGREEMENT and never self-activates.
 */

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Use lowercase letters, numbers, and hyphens only.');

export const selfServeSignupSchema = z
  .object({
    // Organization (only the domain-required fields).
    slug,
    legalName: z.string().trim().min(2).max(200),
    tradingName: z.string().trim().min(2).max(200),
    countryCode: z.string().trim().length(2),
    stateCode: z.string().trim().min(1).max(10).optional(),
    // Operating states (spec Module 5.3). Optional here — a self-serve clinic
    // may set them later in Company Settings — validated against the canonical
    // codes and de-duplicated.
    serviceStates: z
      .array(z.string().trim().toUpperCase().pipe(z.enum(US_STATE_CODES)))
      .max(51)
      .transform((list) => [...new Set(list)])
      .optional(),
    timezone: z.string().trim().min(1).max(100).refine(isValidTimeZone, { message: 'Choose a valid time zone.' }),
    // First owner (the person signing up).
    ownerFullName: z.string().trim().min(2).max(200),
    ownerEmail: z.string().trim().email().max(320),
    // Business-associate agreement acceptance (the gate). The signer attests
    // here; an operator still countersigns before activation.
    agreement: z
      .object({
        version: z.string().trim().min(1).max(50),
        acceptedByName: z.string().trim().min(2).max(200),
        acceptedByTitle: z.string().trim().min(2).max(200),
        accepted: z.literal(true),
      })
      .strict(),
  })
  .strict();
