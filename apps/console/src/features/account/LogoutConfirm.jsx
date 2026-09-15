import { useRef, useState } from 'react';
import { useAuthStore } from '@/auth/store';
import { ConfirmDialog, useToast } from '@/components';

/**
 * "Log out?" confirmation — the single logout entry point for the console (the
 * account menu and My account both use it). Runs the existing auth-store
 * signOut (server revoke + local session clear); a second click while it runs
 * is ignored, and a failure keeps the dialog open with a toast.
 */
export function LogoutConfirm({ open, onClose }) {
  const signOut = useAuthStore((s) => s.signOut);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  async function logOut() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await signOut();
      // The route guard redirects to /login once the store is unauthenticated.
    } catch {
      toast.push('We couldn’t log you out. Please try again.', 'negative');
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      open={open}
      title="Log out?"
      message="Are you sure you want to log out?"
      cancelLabel="Cancel"
      confirmLabel="Log out"
      busyLabel="Logging out…"
      tone="danger"
      busy={busy}
      onConfirm={logOut}
      onClose={() => { if (!inFlight.current) onClose(); }}
    />
  );
}

export default LogoutConfirm;
