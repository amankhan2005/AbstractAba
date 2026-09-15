import { Resend } from 'resend';

/**
 * A real email transport backed by Resend, implementing the same port as
 * LoggingChannelTransport: send(message) where message carries
 * { recipientEmail, view: { subject, link, body, html } }. It carries only a
 * subject and an onboarding link — structurally no PHI.
 *
 * Configuration is explicit and validated. If Resend is not configured, send()
 * throws a clear error rather than silently pretending to deliver — the job
 * then fails and retries through the existing worker, and the failure is
 * visible instead of a false success.
 */
export class ResendEmailTransport {
  constructor(config, { client = null } = {}) {
    this.channel = 'email';
    this.config = config; // { apiKey, fromEmail, fromName }
    this._client = client;
  }

  isConfigured() {
    return Boolean(this.config?.apiKey && this.config?.fromEmail);
  }

  client() {
    if (!this.isConfigured()) {
      throw new Error(
        'Resend is not configured: set RESEND_API_KEY and RESEND_FROM_EMAIL to send email.',
      );
    }
    if (!this._client) {
      this._client = new Resend(this.config.apiKey);
    }
    return this._client;
  }

  from() {
    const { fromName, fromEmail } = this.config;
    return fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  }

  async send(message) {
    const to = message.recipientEmail;
    if (!to) throw new Error('ResendEmailTransport.send requires message.recipientEmail');
    const { subject, link, body, html } = message.view ?? {};
    const text = body ?? (link ? `Open this link: ${link}` : subject);
    const htmlBody = html ?? (link
      ? `<p>${subject}</p><p><a href="${link}">${link}</a></p>`
      : `<p>${subject}</p>`);

    const { data, error } = await this.client().emails.send({
      from: this.from(),
      to,
      subject,
      text,
      html: htmlBody,
    });
    // Resend returns { data, error } — surface a real failure, never fake success.
    if (error) {
      throw new Error(`Resend delivery failed: ${error.message ?? String(error)}`);
    }
    return { ok: true, messageId: data?.id ?? null };
  }
}
