/**
 * Resolves a role-based audience to concrete, de-duplicated recipients.
 * Relationship-based audiences are contributed by clinical modules later through
 * this same port. Ported from the original.
 */
export class RoleBasedAudienceResolver {
  constructor(reader) {
    this.reader = reader; // RoleMembershipReader: findRecipientsByRoles(tenantId, roleKeys)
  }
  async resolve(spec, tenantId) {
    if (!spec.roles || spec.roles.length === 0) return [];
    const recipients = await this.reader.findRecipientsByRoles(tenantId, spec.roles);
    const seen = new Set();
    const unique = [];
    for (const r of recipients) {
      if (!seen.has(r.userId)) { seen.add(r.userId); unique.push(r); }
    }
    return unique;
  }
}
