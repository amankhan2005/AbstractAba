import { isOffPlatformChannel } from './notification.tokens.js';

/**
 * The Phase 1 email/SMS adapter: logs the SafeOffPlatformView and reports
 * success. Real vendor adapters implement the same port and register in its
 * place with no change to any caller. The message type carries only
 * { subject, link } — a transport structurally cannot receive PHI.
 */
export class LoggingChannelTransport {
  constructor(channel, logger) {
    this.channel = channel;
    this.logger = logger;
  }
  send(message) {
    this.logger?.info?.(
      { channel: this.channel, recipient: message.recipientUserId, subject: message.view.subject, link: message.view.link },
      'notification delivered via logging transport',
    );
    return Promise.resolve({ ok: true });
  }
}

/** Maps each off-platform channel to its transport. */
export class ChannelTransportRegistry {
  constructor(transports) {
    this.transports = transports; // Map<channel, transport>
  }
  has(channel) { return this.transports.has(channel); }
  get(channel) {
    if (!isOffPlatformChannel(channel)) throw new Error(`Channel "${channel}" is not an off-platform transport.`);
    const t = this.transports.get(channel);
    if (t === undefined) throw new Error(`No transport registered for channel "${channel}".`);
    return t;
  }
}
