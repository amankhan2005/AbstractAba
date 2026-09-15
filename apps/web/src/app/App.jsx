import { useCallback, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { fetchResolvedTheme } from '@/api/client';
import { DatePickerProvider } from '@aba1on1/date-picker';
import { useAuthStore, useOrgTimezone } from '@/auth/store';
import { OrganizationTimezoneSync } from '@/auth/OrganizationTimezoneSync.jsx';
import { ThemeProvider } from '@/theme';
import { ToastProvider } from '@/components';
import { router } from './routes';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        const status = error?.response?.status;
        if (status && status >= 400 && status < 500) return false;
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
      staleTime: 15_000,
    },
    mutations: { retry: false },
  },
});

/**
 * Application root. Attempts a silent session restore once on mount, then serves
 * the router inside the theme provider. Once a session exists, loadServerTheme
 * reconciles the authoritative per-user preferences and tenant brand over the
 * pre-paint cache — the reconciliation seam the original App only described.
 */
export function App() {
  const bootstrap = useAuthStore((state) => state.bootstrap);
  const status = useAuthStore((state) => state.status);
  // Every date picker's "Today" is the organization's business day, not the
  // browser's — the same authority the scheduling and session gates use.
  const orgTimeZone = useOrgTimezone();

  useEffect(() => { void bootstrap(); }, [bootstrap]);

  // Only reconcile from the server once authenticated; before that the pre-paint
  // cache stands. Identity is stable per auth status so the provider effect runs
  // exactly when the session appears.
  const loadServerTheme = useCallback(
    () => fetchResolvedTheme(),
    [],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <OrganizationTimezoneSync />
      <ThemeProvider loadServerTheme={status === 'authenticated' ? loadServerTheme : undefined}>
        <ToastProvider>
          <DatePickerProvider timeZone={orgTimeZone}>
            <RouterProvider router={router} />
          </DatePickerProvider>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
