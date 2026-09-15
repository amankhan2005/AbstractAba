/**
 * Shared notification vocabulary, ported from @aba1on1/schemas. A
 * SafeOffPlatformView is deliberately just { subject, link } — there is no field
 * for a body, so protected health information cannot travel off-platform.
 */
export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'sms'];
export const NOTIFICATION_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
export const OFF_PLATFORM_CHANNELS = ['email', 'sms'];

export function isOffPlatformChannel(channel) {
  return channel !== 'in_app';
}
