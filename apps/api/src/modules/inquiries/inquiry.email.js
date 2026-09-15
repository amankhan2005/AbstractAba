import { PLATFORM_BRAND } from '@aba1on1/schemas';
import { renderBrandedEmail, formatDate } from '../../common/email/layout.js';

/**
 * Inquiry email deliveries. They run on the existing job worker and go out
 * through the shared channel transport (Resend when configured, the logging
 * transport in development) — no second email system and no credentials here.
 * All user-supplied values are escaped by renderBrandedEmail.
 */
export const CONFIRMATION_TEXT = `Thank you for contacting ${PLATFORM_BRAND.productName}. We’ve received your inquiry and our team will connect with you soon.`;

function emailTransport(transports) {
  if (!transports?.has?.('email')) throw new Error('No email transport is registered; the inquiry email cannot be delivered.');
  return transports.get('email');
}

/** Notification to the Abstract ABA team (info@abstractaba.com unless overridden). */
export function createInquiryTeamNotificationHandler({ transports, notifyEmail = PLATFORM_BRAND.supportEmail, consoleUrl = '' }) {
  return async (payload) => {
    const transport = emailTransport(transports);
    const link = consoleUrl ? `${consoleUrl.replace(/\/+$/, '')}/inquiries` : null;
    const submitted = payload.submittedAt ? new Date(payload.submittedAt) : null;
    const rows = [
      { label: 'Name', value: payload.name },
      { label: 'Organization', value: payload.organization },
      { label: 'Email', value: payload.email },
      { label: 'Phone', value: payload.phone || 'Not provided' },
      { label: 'Subject', value: payload.subject },
      { label: 'Submitted', value: submitted ? `${formatDate(submitted)} ${submitted.toISOString().slice(11, 16)} UTC` : '' },
    ];
    const message = String(payload.message ?? '');
    const subject = `New website inquiry: ${payload.subject}`;
    const html = renderBrandedEmail({
      preheader: `${payload.name} from ${payload.organization} sent a website inquiry.`,
      heading: 'New website inquiry',
      intro: `${payload.name} from ${payload.organization} contacted ${PLATFORM_BRAND.productName} through the website contact form.`,
      cta: link ? { label: 'Open Inquiries', url: link } : null,
      infoRows: rows,
      noticeTitle: 'Message',
      notice: message.split(/\n+/).filter((line) => line.trim() !== ''),
      footerNote: `Sent by the ${PLATFORM_BRAND.productName} website contact form.`,
    });
    const body = [
      'New website inquiry',
      '',
      ...rows.map((r) => `${r.label}: ${r.value}`),
      '',
      'Message:',
      message,
      ...(link ? ['', `Open Inquiries: ${link}`] : []),
    ].join('\n');
    await transport.send({ recipientUserId: null, recipientEmail: notifyEmail, view: { subject, link, html, body } });
  };
}

/** Confirmation to the person who submitted the inquiry. */
export function createInquiryConfirmationHandler({ transports }) {
  return async (payload) => {
    if (!payload?.email) return;
    const transport = emailTransport(transports);
    const firstName = String(payload.name ?? '').trim().split(/\s+/)[0] || 'there';
    const subject = `We’ve received your inquiry | ${PLATFORM_BRAND.productName}`;
    const html = renderBrandedEmail({
      preheader: CONFIRMATION_TEXT,
      heading: 'Thank you for contacting us',
      intro: [`Hello ${firstName},`, CONFIRMATION_TEXT],
      infoRows: [{ label: 'Subject', value: payload.subject }],
      noticeTitle: 'Need to add something?',
      notice: `Write to us at ${PLATFORM_BRAND.supportEmail} and mention the subject above.`,
    });
    const body = [
      `Hello ${firstName},`,
      '',
      CONFIRMATION_TEXT,
      '',
      `Subject: ${payload.subject}`,
      '',
      `Need to add something? Write to us at ${PLATFORM_BRAND.supportEmail}.`,
      '',
      `${PLATFORM_BRAND.productName} · Product of ${PLATFORM_BRAND.providerName}`,
    ].join('\n');
    await transport.send({ recipientUserId: null, recipientEmail: payload.email, view: { subject, link: null, html, body } });
  };
}
