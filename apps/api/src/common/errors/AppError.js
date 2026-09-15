/**
 * Domain error carrying a stable machine code, an HTTP status, and optional
 * structured detail. Ported from the original API's error model: the second
 * argument is an OPTIONS OBJECT, never a bare string.
 */
export class AppError extends Error {
  /**
   * @param {string} code  stable error code, e.g. 'AUTH-401'
   * @param {{ message?: string, status?: number, details?: unknown, context?: unknown, cause?: unknown }} [opts]
   */
  constructor(code, opts = {}) {
    super(opts.message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.status = opts.status ?? 400;
    this.details = opts.details;
    this.context = opts.context;
    if (opts.cause) this.cause = opts.cause;
  }

  static unauthorized(code = 'AUTH-401', message = 'Authentication required') {
    return new AppError(code, { status: 401, message });
  }
  static forbidden(code = 'AUTH-403', message = 'Not permitted') {
    return new AppError(code, { status: 403, message });
  }
  static notFound(code = 'GEN-404', message = 'Not found') {
    return new AppError(code, { status: 404, message });
  }
  static conflict(code = 'GEN-409', message = 'Conflict') {
    return new AppError(code, { status: 409, message });
  }
  static validation(message = 'Validation failed', details) {
    return new AppError('VALIDATION_FAILED', { status: 422, message, details });
  }
}
