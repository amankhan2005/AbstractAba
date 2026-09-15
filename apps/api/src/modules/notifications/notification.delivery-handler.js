/**
 * The `notification.deliver` job handler. Loads the notification, builds a
 * SafeOffPlatformView from its subject and link — never its body — and hands
 * that to the channel transport, so PHI cannot reach an off-platform channel.
 * Records the outcome and, on failure, throws so the job runner applies retry,
 * backoff and dead-lettering. Idempotent. Ported from the original; adapted to
 * the MERN handler signature (payload, { job }) — already inside withTenant.
 */
export function createNotificationDeliveryHandler(deps) {
  return async (payload, { job }) => {
    const tenantId = job.tenantId;
    if (tenantId === null || tenantId === undefined) return; // deliveries are always tenant-scoped

    const notification = await deps.repository.getNotification(tenantId, payload.notificationId);
    if (notification === null) {
      await deps.repository.updateDeliveryStatus(tenantId, payload.deliveryId, 'failed', 'notification no longer exists');
      return;
    }

    const transport = deps.transports.get(payload.channel);
    const result = await transport.send({
      channel: payload.channel,
      recipientUserId: notification.recipientUserId,
      // Subject and link only — the body never leaves the platform.
      view: { subject: notification.subject, link: notification.link },
    });

    await deps.repository.updateDeliveryStatus(
      tenantId, payload.deliveryId,
      result.ok ? 'sent' : 'failed',
      result.ok ? null : (result.error ?? 'delivery failed'),
    );
    if (!result.ok) throw new Error(`notification delivery failed on ${payload.channel}`);
  };
}
