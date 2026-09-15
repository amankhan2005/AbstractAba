/**
 * Minimal structured logger. Swappable for pino in production; kept dependency-
 * free here so the foundation runs with a lean install.
 */
function emit(level, obj, msg) {
  const line =
    typeof obj === 'string'
      ? { level, msg: obj }
      : { level, ...obj, ...(msg ? { msg } : {}) };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(`${JSON.stringify({ time: new Date().toISOString(), ...line })}\n`);
}

export const logger = {
  info: (obj, msg) => emit('info', obj, msg),
  warn: (obj, msg) => emit('warn', obj, msg),
  error: (obj, msg) => emit('error', obj, msg),
  debug: (obj, msg) => {
    if (process.env.NODE_ENV !== 'production') emit('debug', obj, msg);
  },
};
