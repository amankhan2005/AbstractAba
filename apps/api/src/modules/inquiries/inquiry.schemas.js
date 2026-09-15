import { z } from 'zod';

/**
 * Validation for public website inquiries. Text is trimmed, control characters
 * (other than line breaks and tabs in the message) are stripped, and every field
 * is length-bounded so an oversized payload is rejected before it reaches the
 * database. Output is always rendered as escaped text (React / escapeHtml), so
 * no markup can be injected through a submission.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const clean = (v) => (typeof v === 'string' ? v.replace(CONTROL, '').trim() : v);
const oneLine = (v) => (typeof v === 'string' ? clean(v).replace(/[\r\n\t]+/g, ' ') : v);

const text = (min, max, label) => z.preprocess(
  oneLine,
  z.string({ required_error: `${label} is required.`, invalid_type_error: `${label} is required.` })
    .min(min, `${label} is required.`)
    .max(max, `${label} must be ${max} characters or fewer.`),
);

export const submitInquirySchema = z
  .object({
    name: text(2, 120, 'Full name'),
    organization: text(2, 200, 'Company or organization'),
    email: z.preprocess(
      oneLine,
      z.string({ required_error: 'Enter a valid work email.', invalid_type_error: 'Enter a valid work email.' })
        .toLowerCase().max(254, 'Enter a valid work email.').email('Enter a valid work email.'),
    ),
    phone: z.preprocess(
      (v) => (v === '' || v == null ? undefined : oneLine(v)),
      z.string().max(40, 'Enter a valid phone number.').regex(/^[+()\-.\s0-9]{7,40}$/, 'Enter a valid phone number.').optional(),
    ),
    subject: text(3, 150, 'Subject'),
    message: z.preprocess(
      clean,
      z.string({ required_error: 'Message is required.', invalid_type_error: 'Message is required.' })
        .min(10, 'Please tell us a little more (at least 10 characters).')
        .max(5000, 'Message must be 5,000 characters or fewer.'),
    ),
    // Honeypot: real visitors never see or fill this field.
    website: z.string().max(200).optional(),
  })
  .strict();

export const inquiryIdParamsSchema = z.object({ id: z.string().trim().min(1).max(100) }).strict();

export const listInquiriesQuerySchema = z
  .object({ status: z.enum(['NEW', 'CONTACTED', 'CLOSED']).optional() })
  .strict();

export const updateInquirySchema = z
  .object({
    status: z.enum(['NEW', 'CONTACTED', 'CLOSED']).optional(),
    internalNote: z.preprocess(
      (v) => (typeof v === 'string' ? clean(v) : v),
      z.string().max(2000, 'Note must be 2,000 characters or fewer.').nullable().optional(),
    ),
  })
  .strict()
  .refine((v) => v.status !== undefined || v.internalNote !== undefined, { message: 'Provide a status or a note to update.' });
