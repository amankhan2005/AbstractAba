import { z } from 'zod';

/** Query for the in-app notification list. */
export const notificationListQuery = z
  .object({
    unreadOnly: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

/**
 * A preference update names the off-platform channels the user mutes for a type.
 * in_app is intentionally not accepted; mandatory types are refused by the service.
 */
export const updatePreferenceBody = z
  .object({ disabledChannels: z.array(z.enum(['email', 'sms'])).max(2) })
  .strict();

export const notificationTypeParams = z.object({ type: z.string().trim().min(1).max(100) });
export const notificationIdParams = z.object({ id: z.string().uuid() });
