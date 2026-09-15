/**
 * Staff welcome / login email — delivered through the existing job worker +
 * channel transport (no separate email system). The delivery job carries the
 * one-time temporary password the new staff member needs to sign in for the
 * first time; it is never persisted on the User in plaintext, never returned in
 * an API response, and never logged. The member is required to change it on
 * first login (mustChangePassword). No PHI is present.
 */

export const STAFF_WELCOME_EMAIL_JOB = 'staff.welcome_email.deliver';

import { renderBrandedEmail } from '../../common/email/layout.js';
import { PLATFORM_BRAND } from '@aba1on1/schemas';

const PRODUCT_NAME = PLATFORM_BRAND.productName;

const ROLE_LABELS = { bcba: 'BCBA', rbt: 'RBT' };

function roleLabel(roleKey) {
  return ROLE_LABELS[String(roleKey ?? '').toLowerCase()] ?? 'Staff';
}

function firstNameOf(fullName) {
  const cleaned = String(fullName ?? '').trim().replace(/\s+/g, ' ');
  return cleaned ? cleaned.split(' ')[0] : 'there';
}

/**
 * Build the delivery handler. The worker invokes handlers as handler(payload) —
 * the payload is the FIRST argument (matches the company-invitation handler).
 * payload: { email, temporaryPassword, fullName, roleKey }.
 */
export function createStaffWelcomeEmailHandler({ transports, webAppUrl }) {
  return async (payload) => {
    const { email, temporaryPassword, fullName, roleKey } = payload;
    if (!email || !temporaryPassword) {
      throw new Error('staff welcome email requires a recipient email and temporary password');
    }
    if (!transports?.has?.('email')) {
      // Fail loudly so the worker retries and the failure is visible — never a
      // silent false success.
      throw new Error('No email transport registered; cannot deliver staff welcome email.');
    }
    const base = (webAppUrl ?? 'http://localhost:3000').replace(/\/+$/, '');
    const loginUrl = `${base}/login`;
    const role = roleLabel(roleKey);
    const subject = `Welcome to ${PRODUCT_NAME} — Your Staff Account Is Ready`;
    const body =
      `Congratulations, ${firstNameOf(fullName)}!\n\n` +
      `Your ${PRODUCT_NAME} staff account has been created.\n\n` +
      `Login Email:\n${email}\n\n` +
      `Temporary Password:\n${temporaryPassword}\n\n` +
      `Role:\n${role}\n\n` +
      `Login:\n${loginUrl}\n\n` +
      `Use the temporary password to sign in. You will be required to change your ` +
      `password after your first login.\n\n` +
      `If you did not expect this email, please contact your administrator.`;
    const html = renderBrandedEmail({
      preheader: `Your ${PRODUCT_NAME} staff account is ready — sign in with your temporary password.`,
      heading: `Welcome to ${PRODUCT_NAME}, ${firstNameOf(fullName)}`,
      intro: ['Your staff account has been created. Use the temporary password below to sign in for the first time.'],
      cta: { label: `Sign in to ${PRODUCT_NAME}`, url: loginUrl },
      infoRows: [
        { label: 'Role', value: role },
        { label: 'Login email', value: email },
        { label: 'Temporary password', value: temporaryPassword },
      ],
      noticeTitle: 'Keep your account secure',
      notice: [
        'You will be asked to create a new password right after your first login.',
        'If you did not expect this email, please contact your administrator.',
      ],
    });

    const transport = transports.get('email');
    await transport.send({
      recipientUserId: null,
      recipientEmail: email,
      to: email,
      subject,
      text: body,
      view: { subject, body, html },
    });
  };
}
