/**
 * The ONLY data the browser is allowed to send for a parent email: the template
 * id and the edited subject/body. Recipient (`to`), sender (`fromEmail`/
 * `fromName`), `tenantId`, `organizationId`, and `companyId` are resolved
 * server-side and must never be sent from the client — this helper structurally
 * guarantees that by whitelisting the three editable fields.
 */
export function buildEmailPayload({ templateId, subject, body }) {
  return { templateId, subject, body };
}

export default buildEmailPayload;
