/**
 * Resolves which channels a notification is delivered on for one recipient.
 * Mandatory safety is structural: a mandatory type returns all declared channels
 * and never reads the preference, so nothing can suppress it. For an optional
 * type, muted off-platform channels are removed — but in_app is always kept.
 * Ported verbatim from the original.
 */
export function resolveDeliveryChannels(descriptor, preference) {
  if (descriptor.mandatory) return [...descriptor.channels];
  const disabled = new Set(preference?.disabledChannels ?? []);
  return descriptor.channels.filter((channel) => channel === 'in_app' || !disabled.has(channel));
}
