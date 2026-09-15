import { SUPPORTED_EMAIL_VARIABLES, unsupportedVariablesIn } from './parent-email.templates.js';
import { clientsError } from './clients.errors.js';

/**
 * Saved parent-email templates (company-owned, reusable). Extends the existing
 * parent-email system: the same variable allowlist is enforced on save, and the
 * existing preview/send path renders and delivers them (recipient and sender
 * stay server-resolved). Tenant comes from the caller's context only.
 */
export class EmailTemplatesService {
  constructor(deps) {
    this.deps = deps;
  }

  _assertVariables({ subject, body }) {
    const unsupported = [...new Set([...unsupportedVariablesIn(subject), ...unsupportedVariablesIn(body)])];
    if (unsupported.length) {
      throw clientsError('EMAIL_UNSUPPORTED_VARIABLE', {
        message: `These variables are not supported: ${unsupported.map((v) => `{{${v}}}`).join(', ')}.`,
        details: { unsupported, supported: SUPPORTED_EMAIL_VARIABLES },
      });
    }
  }

  async list({ tenantId }) {
    return { items: await this.deps.repository.list(tenantId), supportedVariables: SUPPORTED_EMAIL_VARIABLES };
  }

  async get({ tenantId, templateId }) {
    const tpl = await this.deps.repository.findById(tenantId, templateId);
    if (!tpl) throw clientsError('EMAIL_TEMPLATE_NOT_FOUND');
    return tpl;
  }

  async create({ tenantId, actorUserId, input }) {
    this._assertVariables(input);
    return this.deps.repository.create(tenantId, { ...input, actorUserId });
  }

  async update({ tenantId, actorUserId, templateId, expectedVersion, input }) {
    const current = await this.get({ tenantId, templateId });
    this._assertVariables({ subject: input.subject ?? current.subject, body: input.body ?? current.body });
    return this.deps.repository.update(tenantId, templateId, input, expectedVersion, actorUserId);
  }

  async remove({ tenantId, actorUserId, templateId }) {
    return this.deps.repository.softDelete(tenantId, templateId, actorUserId);
  }
}
