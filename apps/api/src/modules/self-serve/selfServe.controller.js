import { sendCreated } from '../../common/http/responder.js';

/**
 * Public self-serve signup controller. Unauthenticated by design (this is the
 * entry point BR-3 requires). It reads only the validated body and the request
 * IP (for agreement provenance); it never accepts a tenant id, actor, or state.
 */
export class SelfServeController {
  constructor(service) {
    this.service = service;
  }

  signup = async (req, res) => {
    const requestIp = req.ip ?? req.socket?.remoteAddress ?? null;
    const result = await this.service.signup({ input: req.body, requestIp });
    sendCreated(res, result, `/api/v1/public/signup/${result.organizationId}`);
  };
}
