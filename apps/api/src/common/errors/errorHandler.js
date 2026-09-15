import { AppError } from './AppError.js';
import { TenantContextError } from '../../tenancy/tenantContext.js';
import { logger } from '../../config/logger.js';

/** Express not-found terminator. */
export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'GEN-404', message: 'Route not found' } });
}

/**
 * Centralised error handler. One place decides the wire shape of an error, so
 * no route leaks a stack trace or an internal message.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  // A missing tenant context reaching the wire is a server-side isolation
  // defect, never the client's fault — surface as 500 but log loudly.
  if (err instanceof TenantContextError) {
    logger.error({ err: err.message, path: req.path }, 'tenant context violation');
    return res.status(500).json({ error: { code: 'TENANCY-500', message: 'Internal isolation error' } });
  }

  if (err instanceof AppError) {
    if (err.status >= 500) logger.error({ code: err.code, err: err.message }, 'app error');
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
  }

  // Mongoose duplicate key → conflict. Return only the offending field NAMES,
  // never their values: a unique index can sit on a token hash or email, and
  // echoing err.keyValue would disclose it to the caller.
  if (err && err.code === 11000) {
    const fields = err.keyValue ? Object.keys(err.keyValue) : (err.keyPattern ? Object.keys(err.keyPattern) : []);
    return res.status(409).json({ error: { code: 'GEN-409', message: 'Duplicate key', ...(fields.length ? { details: { fields } } : {}) } });
  }
  if (err && err.name === 'ValidationError') {
    return res.status(422).json({ error: { code: 'VALIDATION_FAILED', message: err.message } });
  }

  // Client request errors from body parsing (malformed JSON, payload too large)
  // carry a 4xx status; they are the caller's fault, not an internal error.
  const clientStatus =
    typeof err?.status === 'number' ? err.status
    : typeof err?.statusCode === 'number' ? err.statusCode
    : undefined;
  if (clientStatus !== undefined && clientStatus >= 400 && clientStatus < 500) {
    const malformed = err instanceof SyntaxError || err?.type === 'entity.parse.failed';
    return res.status(clientStatus).json({
      error: { code: `GEN-${clientStatus}`, message: malformed ? 'Malformed request body' : 'Bad request' },
    });
  }

  logger.error({ err: err?.stack ?? String(err), path: req.path }, 'unhandled error');
  return res.status(500).json({ error: { code: 'GEN-500', message: 'Internal server error' } });
}
