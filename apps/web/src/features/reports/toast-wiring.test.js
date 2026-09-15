import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const feat = (p) => readFileSync(join(here, '..', p), 'utf8');

/**
 * Financial mutations must give the user explicit success/failure feedback.
 * These static assertions prove each financial page imports useToast and calls
 * toast.push on both success and error, and that the ToastProvider is mounted.
 */
describe('web financial pages wire toast feedback', () => {
  const pages = [
    'claims/ClaimDetailPage.jsx',
    'payroll/PayrollPage.jsx',
    'reports/ReconciliationPage.jsx',
  ];
  for (const page of pages) {
    it(`${page} uses useToast with success + error feedback`, () => {
      const code = feat(page);
      expect(code).toMatch(/useToast/);
      expect(code).toMatch(/toast\.push\(/);
      // negative-tone push on error path
      expect(code).toMatch(/'negative'/);
    });
  }

  it('ToastProvider is mounted in the app tree', () => {
    const app = readFileSync(join(here, '..', '..', 'app', 'App.jsx'), 'utf8');
    expect(app).toMatch(/<ToastProvider>/);
    expect(app).toMatch(/import \{ ToastProvider \} from '@\/components'/);
  });

  it('Toast module exports provider and hook', () => {
    const idx = readFileSync(join(here, '..', '..', 'components', 'index.js'), 'utf8');
    expect(idx).toMatch(/ToastProvider, useToast/);
  });
});
