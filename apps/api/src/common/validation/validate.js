import { AppError } from '../errors/AppError.js';

/**
 * Express middleware that validates req[part] against a Zod schema and replaces
 * it with the parsed value. Keeps controllers free of parsing noise.
 * @param {import('zod').ZodTypeAny} schema
 * @param {'body'|'query'|'params'} [part]
 */
export const validate = (schema, part = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[part]);
  if (!result.success) {
    return next(AppError.validation('Request validation failed', result.error.flatten()));
  }
  req[part] = result.data;
  return next();
};
