import { sealPhi, openPhi } from '../../utils/phi.js';
import { organizationService } from '../organization/index.js';
import { notificationService, channelTransports } from '../notifications/index.js';
import { ClientsService } from './clients.service.js';
import { clientsRepository } from './clients.repository.js';
import { createClientsRouter } from './clients.routes.js';
import { EmailTemplatesService } from './email-templates.service.js';
import { emailTemplatesRepository } from './email-templates.repository.js';
import { createEmailTemplatesRouter } from './email-templates.routes.js';

/**
 * Composition root for the clients module. The service reads organization state
 * through a narrow port (for the ACTIVE gate) and seals/opens PHI through the
 * shared seam (utils/phi.js) — so the key strategy stays in one place and can
 * become per-tenant later without touching this module.
 */
export const emailTemplatesService = new EmailTemplatesService({ repository: emailTemplatesRepository });
export const emailTemplatesRouter = createEmailTemplatesRouter(emailTemplatesService);

export const clientsService = new ClientsService({
  repository: clientsRepository,
  // Saved company templates are sendable through the same preview/send path.
  emailTemplates: { findById: (tenantId, id) => emailTemplatesRepository.findById(tenantId, id) },
  organizations: { getById: (id) => organizationService.getById(id) },
  phi: { seal: sealPhi, open: openPhi },
  notifications: { dispatch: (type, ctx) => notificationService.dispatch(type, ctx) },
  email: { send: (message) => channelTransports.get('email').send(message) },
});

export const clientsRouter = createClientsRouter(clientsService);

export { ClientsService } from './clients.service.js';
export { ClientsController } from './clients.controller.js';
export { clientsRepository } from './clients.repository.js';
