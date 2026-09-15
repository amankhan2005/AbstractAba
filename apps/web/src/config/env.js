import { z } from 'zod';

/**
 * Client environment configuration. Only VITE_-prefixed variables reach the
 * browser bundle, and everything that does is public by definition.
 */
const clientEnvSchema = z.object({
  VITE_API_BASE_URL: z.string().min(1).default('/api'),
  VITE_APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
});

function loadClientEnv() {
  const result = clientEnvSchema.safeParse(import.meta.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid client environment configuration: ${issues}`);
  }
  return Object.freeze(result.data);
}

export const clientEnv = loadClientEnv();
