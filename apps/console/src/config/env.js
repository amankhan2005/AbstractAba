import { z } from 'zod';

/**
 * Client environment configuration.
 * Only VITE_-prefixed variables are exposed to the browser.
 */
const clientEnvSchema = z.object({
  VITE_API_BASE_URL: z
    .string()
    .min(1)
    .default('/api/v1'),

  VITE_APP_ENV: z
    .enum(['development', 'staging', 'production'])
    .default('development'),
});

function loadClientEnv() {
  const result = clientEnvSchema.safeParse({
    VITE_API_BASE_URL:
      import.meta.env.VITE_API_BASE_URL ??
      '/api/v1',

    VITE_APP_ENV:
      import.meta.env.VITE_APP_ENV ??
      'development',
  });

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');

    throw new Error(
      `Invalid client environment configuration: ${issues}`
    );
  }

  return Object.freeze(result.data);
}

export const clientEnv = loadClientEnv();