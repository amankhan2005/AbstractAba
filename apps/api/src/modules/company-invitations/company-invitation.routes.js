import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { sendSuccess, sendCreated } from '../../common/http/responder.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePlatformOperator } from '../../middleware/requirePlatformOperator.js';
import { createOrganizationSchema } from '../organization/organization.schemas.js';
import { setRefreshCookie } from '../auth/refreshCookie.js';
import { formatDate } from '../../utils/format.js';
import { renderBrandedEmail } from '../../common/email/layout.js';
import { PLATFORM_BRAND } from '@aba1on1/schemas';

const PRODUCT_NAME = PLATFORM_BRAND.productName;

// ---- schemas ----
export const inviteCompanySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  contactName: z.string().trim().min(2).max(200).optional(),
  companyName: z.string().trim().min(2).max(200).optional(),
});

export const invitationTokenParamsSchema = z.object({
  token: z.string().trim().min(20).max(200),
});

export const invitationIdParamsSchema = z.object({ invitationId: z.string().trim().min(1) });

// The onboarding submission reuses the organization creation schema verbatim,
// except primaryContactEmail is optional (it defaults to the invited email).
// It also collects the owner's password: this single submission creates both
// the organization and the owner's login — there is no separate accept step.
export const onboardingSubmitSchema = createOrganizationSchema.extend({
  primaryContactEmail: z.string().trim().toLowerCase().email().max(254).optional(),
  password: z.string().min(10).max(200),
  // Explicit acceptance of the business-associate agreement. `accepted` must be
  // the literal true — an unchecked box fails validation with a clear message
  // and the organization is never created or activated. The version is echoed
  // for the record but the server pins the authoritative version (see
  // ONBOARDING_AGREEMENT); the owner supplies the title under which they sign.
  agreement: z
    .object({
      accepted: z.literal(true),
      acceptedByTitle: z.string().trim().min(2).max(200),
      version: z.string().trim().min(1).max(50).optional(),
    })
    .strict(),
});

/** Routes for the company-invitation flow. */
export function createCompanyInvitationRouters(service) {
  // Operator-facing (platform console)
  const platform = Router();
  platform.use(authenticate, requirePlatformOperator);

  platform.post(
    '/',
    validate(inviteCompanySchema, 'body'),
    asyncHandler(async (req, res) => {
      const invitation = await service.invite({ ...req.body, invitedByUserId: req.principal.userId });
      sendCreated(res, invitation);
    }),
  );

  platform.get(
    '/',
    asyncHandler(async (req, res) => {
      const items = await service.list({ status: req.query.status });
      sendSuccess(res, items);
    }),
  );

  platform.post(
    '/:invitationId/resend',
    validate(invitationIdParamsSchema, 'params'),
    asyncHandler(async (req, res) => {
      const invitation = await service.resend(req.params.invitationId, req.principal.userId);
      sendSuccess(res, invitation);
    }),
  );

  platform.post(
    '/:invitationId/revoke',
    validate(invitationIdParamsSchema, 'params'),
    asyncHandler(async (req, res) => {
      const invitation = await service.revoke(req.params.invitationId);
      sendSuccess(res, invitation);
    }),
  );

  // Public (no auth): preview + accept by token
  const publicRouter = Router();
  publicRouter.get(
    '/:token',
    validate(invitationTokenParamsSchema, 'params'),
    asyncHandler(async (req, res) => {
      const preview = await service.preview(req.params.token);
      sendSuccess(res, preview);
    }),
  );
  publicRouter.post(
    '/:token/logo-upload-signature',
    validate(invitationTokenParamsSchema, 'params'),
    asyncHandler(async (req, res) => {
      const signature = await service.logoUploadSignature(req.params.token);
      sendSuccess(res, signature);
    }),
  );
  publicRouter.post(
    '/:token/accept',
    validate(invitationTokenParamsSchema, 'params'),
    validate(onboardingSubmitSchema, 'body'),
    asyncHandler(async (req, res) => {
      const result = await service.accept(req.params.token, req.body, {
        requestIp: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      });
      // Auto-login: when a session was established, set the hardened rotating
      // refresh cookie (exactly as sign-in does) and return the access token +
      // user + active tenant so the SPA lands directly in the Company Panel. The
      // refresh token itself is never placed in the JSON body — the cookie is
      // the only transport. When session is null the account is still created;
      // the client shows "Please sign in".
      const session = result.session;
      if (session?.refreshToken) setRefreshCookie(res, session.refreshToken);
      sendCreated(res, {
        organizationId: result.organizationId,
        state: result.state,
        session: session
          ? {
              status: 'ESTABLISHED',
              accessToken: session.accessToken,
              activeTenantId: session.activeTenantId,
              user: session.user,
            }
          : { status: 'SIGN_IN_REQUIRED' },
      });
    }),
  );

  return { platform, public: publicRouter };
}

/**
 * The delivery job handler. Reuses the existing channel transport to "send" the
 * invitation (the platform's configured transport is a logging transport; no
 * separate email system is introduced). The email body contains the onboarding
 * link, expiry, and instructions — never PHI, never secrets beyond the one-time
 * link token the recipient needs.
 */
export function createCompanyInvitationDeliveryHandler({ transports, webAppUrl }) {
  // The job worker invokes handlers as handler(payload, { job }) — the payload
  // is the FIRST argument. (Reading `.payload` off it — the previous bug — gave
  // undefined and threw on every attempt, so the job dead-lettered even though
  // it was correctly registered.) This matches the notification/era/staff
  // handlers' documented signature.
  return async (payload) => {
    const { email, token, expiresAt, companyName, contactName } = payload;
    const base = (webAppUrl ?? 'http://localhost:3000').replace(/\/+$/, '');
    const link = `${base}/onboarding/${token}`;
    // Title-case the greeting name; fall back cleanly so the body never renders
    // "Hello undefined". companyName is likewise optional at invite time.
    const titleCase = (s) => s.trim().replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const firstName = contactName ? titleCase(contactName).split(' ')[0] : 'there';
    const company = companyName ? titleCase(companyName) : 'your company';
    const subject = companyName
      ? `Welcome to ${titleCase(companyName)} — Complete Your Setup`
      : `Welcome to ${PRODUCT_NAME} — Complete Your Setup`;
    // Deliver through the configured off-platform email transport. The view
    // carries only the subject and the onboarding link — no PHI, no secrets. If
    // no email transport is registered the job throws, so the failure is visible
    // and retried by the worker rather than silently swallowed.
    if (!transports?.has?.('email')) {
      throw new Error('No email transport registered; cannot deliver company invitation.');
    }
    const transport = transports.get('email');
    const html = renderBrandedEmail({
      preheader: `Complete your ${company} setup on ${PRODUCT_NAME}.`,
      heading: `Welcome to ${PRODUCT_NAME}`,
      intro: [
        `Hello ${firstName},`,
        `Your company account for ${company} has been created. Complete your setup using the secure button below.`,
      ],
      cta: { label: 'Complete your setup', url: link },
      noticeTitle: 'About this link',
      notice: [
        `This invitation is secure, temporary and single-use. It expires ${formatDate(expiresAt)}.`,
        "If you didn't expect this, you can safely ignore this email.",
      ],
    });
    await transport.send({
      recipientUserId: null,
      recipientEmail: email,
      view: {
        subject,
        link,
        html,
        body:
          `Hello ${firstName},\n\n` +
          `Welcome to ${company}.\n\n` +
          `Your company account has been created on ${PRODUCT_NAME}.\n\n` +
          `Please complete your setup using the secure link below.\n\n` +
          `Complete Your Onboarding:\n${link}\n\n` +
          `Your invitation link is secure, temporary and single-use. It expires ${formatDate(expiresAt)}.\n` +
          `If you didn't expect this, you can ignore this email.`,
      },
    });
  };
}
