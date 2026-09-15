import { motion } from 'framer-motion';
import { useAuthStore } from '@/auth/store';
import { Button, Card } from '@/components';

/**
 * Shown when the signed-in user's company has been deactivated by platform
 * support. It is a friendly, non-technical full-page message — never a raw 401 /
 * 403, a tenant/organization code, or a stack trace. It is a UX layer only: the
 * backend independently blocks the company's protected actions, so this screen
 * cannot be the security boundary. When the company is activated again, the next
 * session check clears this state and the normal panel returns.
 */
export function CompanyUnavailablePage() {
  const signOut = useAuthStore((s) => s.signOut);
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '2rem', background: 'var(--surface-muted, #f6f5fb)' }}>
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.24, ease: 'easeOut' }}
        style={{ width: '100%', maxWidth: 460 }}
      >
        <Card>
          <h1 style={{ marginTop: 0 }}>Your company account is currently unavailable.</h1>
          <p className="muted">Please contact platform support for assistance.</p>
          <div style={{ marginTop: '1.25rem' }}>
            <Button onClick={() => signOut()}>Sign out</Button>
          </div>
        </Card>
      </motion.div>
    </div>
  );
}

export default CompanyUnavailablePage;
