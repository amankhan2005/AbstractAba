import { GuardianInvitationService } from './guardian-invitation.service.js';
import { channelTransports } from '../notifications/index.js';

/**
 * Composition root for guardian invitations.
 *
 * The email transport is resolved from the SAME registry the notification
 * module uses, so there is one Resend configuration in the system rather than
 * two. When RESEND_API_KEY and RESEND_FROM_EMAIL are set this is the real
 * Resend transport; otherwise it is the logging adapter, whose send() succeeds
 * locally without pretending an email left the building.
 *
 * Note the difference in failure semantics that follows: with the logging
 * adapter an invitation is recorded as SENT (a developer's console is the
 * mailbox), while an unconfigured or failing Resend records FAILED with the
 * reason. That is deliberate — production must never report a delivery it did
 * not achieve, and local development must not be blocked by credentials it
 * does not have.
 */
export const guardianInvitationService = new GuardianInvitationService({
  transport: channelTransports.get('email'),
});

export { GuardianInvitationService } from './guardian-invitation.service.js';
export { toInvitation, derivedStatus } from './guardian-invitation.service.js';
