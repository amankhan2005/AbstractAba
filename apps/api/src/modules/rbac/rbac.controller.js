import { AppError } from '../../common/errors/AppError.js';
import { sendSuccess } from '../../common/http/responder.js';
import { toResolvedList } from './authorization.service.js';

/**
 * Read access to the authorization model, ported from the original RbacController.
 * Enforcement lives in the guard; these endpoints let a client build a
 * permission-aware UI without hardcoding rules the server owns.
 */
export class RbacController {
  constructor(authorization) {
    this.authorization = authorization;
  }

  /** The full catalogue — reference metadata, identical for every caller. */
  catalogue = (_req, res) => {
    sendSuccess(res, this.authorization.catalogue());
  };

  /** The caller's own effective permissions, resolved from their token. */
  myPermissions = (req, res) => {
    const principal = RbacController.requirePrincipal(req);
    const effective = this.authorization.resolveEffectivePermissions(principal);
    sendSuccess(res, {
      isPlatformOperator: !!principal.isPlatformOperator,
      permissions: toResolvedList(effective),
    });
  };

  /** The permissions a system role holds, enriched with descriptions. */
  rolePermissions = (req, res) => {
    const roleKey = req.params.roleKey;
    const permissions = this.authorization.rolePermissions(roleKey);
    if (permissions === null) {
      throw new AppError('ROLE_NOT_FOUND', { status: 404, message: 'Role not found', context: { roleKey } });
    }
    sendSuccess(res, {
      roleKey,
      permissions: permissions.map((p) => ({
        key: p.key,
        scope: p.scope,
        description: p.key.replace(/\./g, ' ').replace(/_/g, ' '),
      })),
    });
  };

  static requirePrincipal(req) {
    if (!req.principal) throw AppError.unauthorized('AUTH-401', 'Authentication required');
    return req.principal;
  }
}
