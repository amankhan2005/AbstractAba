import { AppError } from '../../common/errors/AppError.js';
import { sendCreated, sendSuccess } from '../../common/http/responder.js';
import { onboardingError } from './onboarding.errors.js';

/**
 * Onboarding endpoints, all platform-scoped. Onboarding is an operator activity:
 * it happens before the clinic has anyone who could perform it, and involves
 * commercial and legal facts the clinic does not administer. Ported from the
 * original controller ({data} envelope, If-Match version).
 */
export class OnboardingController {
  constructor(service) {
    this.service = service;
  }

  provision = async (req, res) => {
    const principal = OnboardingController.requirePrincipal(req);
    sendSuccess(res, await this.service.provision({ organizationId: req.params.id, actorUserId: principal.userId }));
  };

  checklist = async (req, res) => {
    sendSuccess(res, await this.service.checklist(req.params.id));
  };

  recordAgreement = async (req, res) => {
    const principal = OnboardingController.requirePrincipal(req);
    const b = req.body;
    const agreement = await this.service.recordAgreement({
      organizationId: req.params.id,
      type: b.type, version: b.version,
      executedByName: b.executedByName, executedByTitle: b.executedByTitle,
      executedAt: b.executedAt, executedIp: req.ip ?? null, documentRef: b.documentRef,
      actorUserId: principal.userId,
    });
    sendCreated(res, agreement);
  };

  listAgreements = async (req, res) => {
    sendSuccess(res, await this.service.listAgreements(req.params.id));
  };

  countersignAgreement = async (req, res) => {
    const principal = OnboardingController.requirePrincipal(req);
    sendSuccess(res, await this.service.countersignAgreement({
      organizationId: req.params.id, agreementId: req.params.agreementId, actorUserId: principal.userId,
    }));
  };

  activate = async (req, res) => {
    const principal = OnboardingController.requirePrincipal(req);
    const organization = await this.service.activate({
      organizationId: req.params.id, actorUserId: principal.userId,
      expectedVersion: OnboardingController.requireVersion(req),
    });
    sendSuccess(res, { id: organization.id, state: organization.state, version: organization.version });
  };

  beginOffboarding = async (req, res) => {
    const principal = OnboardingController.requirePrincipal(req);
    const result = await this.service.beginOffboarding({
      organizationId: req.params.id, actorUserId: principal.userId,
      expectedVersion: OnboardingController.requireVersion(req), reason: req.body.reason,
    });
    sendSuccess(res, {
      state: result.organization.state, version: result.organization.version,
      export: { id: result.export.id, state: result.export.state },
    });
  };

  completeExport = async (req, res) => {
    const completed = await this.service.completeExport({
      organizationId: req.params.id, exportId: req.body.exportId, artifactRef: req.body.artifactRef,
    });
    // The artifact reference is never returned: downloads are short-lived signed links.
    sendSuccess(res, { id: completed.id, state: completed.state, availableAt: completed.availableAt, expiresAt: completed.expiresAt });
  };

  latestExport = async (req, res) => {
    const latest = await this.service.latestExport(req.params.id);
    if (!latest) { sendSuccess(res, null); return; }
    sendSuccess(res, {
      id: latest.id, state: latest.state, requestedAt: latest.requestedAt,
      availableAt: latest.availableAt, expiresAt: latest.expiresAt, failure: latest.failure,
    });
  };

  approveDestruction = async (req, res) => {
    const principal = OnboardingController.requirePrincipal(req);
    const organization = await this.service.approveDestruction({
      organizationId: req.params.id, requestedByUserId: req.body.requestedByUserId,
      approvedByUserId: principal.userId, expectedVersion: OnboardingController.requireVersion(req),
    });
    sendSuccess(res, { id: organization.id, state: organization.state, version: organization.version });
  };

  static requirePrincipal(req) {
    if (!req.principal) throw AppError.unauthorized('AUTH-401', 'Authentication required');
    return req.principal;
  }

  static requireVersion(req) {
    const header = req.get('if-match');
    if (header === undefined || !/^\d+$/.test(header)) {
      throw AppError.validation('Supply the version you read in an If-Match header.', [{ path: 'headers.if-match', message: 'Required' }]);
    }
    return Number.parseInt(header, 10);
  }
}
