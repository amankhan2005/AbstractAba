import { orgError } from './organization.errors.js';
import { assertSlugAcceptable } from './organization.slug.js';
import { assertTransitionAllowed, maySignIn } from './organization.state-machine.js';

/**
 * Organization lifecycle and profile operations, ported from the original
 * OrganizationService. The service holds the rules; the repository holds data
 * access. It never touches Mongoose, a request, or a response — so the same
 * rules can later be invoked from a job or scheduled task.
 */
export class OrganizationService {
  /**
   * @param {{ repository: import('./organization.repository.js').OrganizationRepository,
   *           newId: () => string, destructionGraceDays: number,
   *           defaultBranding: { tradingName: string, logoUrl: string|null, accent: string } }} deps
   */
  constructor(deps) {
    this.repo = deps.repository;
    this.newId = deps.newId;
    this.destructionGraceDays = deps.destructionGraceDays;
    this.defaultBranding = deps.defaultBranding;
  }

  /** Creates an organization in PROVISIONING (never usable at creation). */
  async create(input) {
    const slug = input.slug.trim().toLowerCase();
    assertSlugAcceptable(slug);
    // Checked for a clear message; the unique index is the real guarantee under
    // concurrency.
    if (await this.repo.slugExists(slug)) {
      throw orgError('SLUG_TAKEN', { context: { slug } });
    }
    return this.repo.create({ ...input, slug, id: this.newId() });
  }

  async getById(organizationId) {
    const organization = await this.repo.findById(organizationId);
    if (!organization) {
      // Never distinguishes "does not exist" from "belongs to another tenant".
      throw orgError('TENANT_RESOURCE_NOT_FOUND');
    }
    return organization;
  }

  list(query) {
    return this.repo.list(query);
  }

  /** Performs a lifecycle transition with optimistic concurrency. */
  async transition(input) {
    const organization = await this.getById(input.organizationId);

    assertTransitionAllowed({
      organization,
      target: input.toState,
      ...(input.destruction
        ? {
            destruction: {
              requestedByUserId: input.destruction.requestedByUserId,
              approvedByUserId: input.actorUserId,
              exportCompleted: input.destruction.exportCompleted,
              graceElapsed: this.hasGraceElapsed(organization),
            },
          }
        : {}),
    });

    return this.repo.applyTransition({
      organizationId: organization.id,
      expectedVersion: input.expectedVersion,
      fromState: organization.state,
      toState: input.toState,
      reason: input.reason.trim(),
      actorUserId: input.actorUserId,
      transitionId: this.newId(),
    });
  }

  /** Whether the offboarding→destruction grace window has elapsed. */
  hasGraceElapsed(organization, now = new Date()) {
    if (!organization.offboardingAt) return false;
    const graceDays = organization.destructionGraceDays ?? this.destructionGraceDays;
    const elapsedMs = now.getTime() - new Date(organization.offboardingAt).getTime();
    return elapsedMs >= graceDays * 24 * 60 * 60 * 1000;
  }

  async getProfile(tenantId) {
    return OrganizationService.toProfile(await this.getById(tenantId));
  }

  async updateProfile(input) {
    const organization = await this.getById(input.tenantId);
    // Suspended/offboarding orgs are read-only to their own users.
    if (organization.state !== 'ACTIVE') {
      throw orgError('ORGANIZATION_NOT_ACTIVE', { context: { state: organization.state } });
    }
    const updated = await this.repo.updateProfile({
      organizationId: input.tenantId,
      expectedVersion: input.expectedVersion,
      actorUserId: input.actorUserId,
      changes: input.changes,
    });
    return OrganizationService.toProfile(updated);
  }

  /**
   * Login-screen branding by host. An unknown host returns the platform default
   * in exactly the same shape as a known one, so customers cannot be enumerated.
   */
  async getBrandingForHost(host) {
    const organization = await this.repo.findByHost(host.trim().toLowerCase());
    if (!organization || organization.state === 'DESTROYED') {
      return this.defaultBranding;
    }
    return {
      tradingName: organization.tradingName,
      logoUrl: null,
      accent: this.defaultBranding.accent,
    };
  }

  /** Organizations a user may switch between (active membership + sign-in-permitted state). */
  async listMembershipsForUser(userId) {
    const memberships = await this.repo.listMembershipsForUser(userId);
    return memberships.filter(
      (m) => m.status === 'ACTIVE' && maySignIn(m.organizationState),
    );
  }

  /** Resolves a switch target; the token is re-issued server-side, never asserted by the client. */
  async resolveSwitchTarget({ principal, targetOrganizationId }) {
    const memberships = await this.listMembershipsForUser(principal.userId);
    const target = memberships.find((m) => m.organizationId === targetOrganizationId);
    if (!target) {
      throw orgError('NO_ACTIVE_MEMBERSHIP', { context: { organizationId: targetOrganizationId } });
    }
    return target;
  }

  summariseUsage(tenantId) {
    return this.repo.summariseUsage(tenantId);
  }

  static toProfile(o) {
    return {
      id: o.id,
      slug: o.slug,
      tradingName: o.tradingName,
      legalName: o.legalName,
      state: o.state,
      countryCode: o.countryCode,
      stateCode: o.stateCode,
      serviceStates: Array.isArray(o.serviceStates) ? o.serviceStates : [],
      timezone: o.timezone,
      locale: o.locale,
      primaryContactName: o.primaryContactName,
      primaryContactEmail: o.primaryContactEmail,
      contactPhone: o.contactPhone ?? null,
      contactEmail: o.contactEmail ?? null,
      websiteUrl: o.websiteUrl ?? null,
      addressLine1: o.addressLine1 ?? null,
      addressLine2: o.addressLine2 ?? null,
      city: o.city ?? null,
      postalCode: o.postalCode ?? null,
      version: o.version,
    };
  }
}
