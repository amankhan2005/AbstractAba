import { useMutation, useQueryClient } from '@tanstack/react-query';
import { inviteGuardian, resendGuardianInvitation } from '@/api/client';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';

/**
 * The clinic-side control for one guardian's information request.
 *
 * DELIVERY HONESTY is the whole point of this component. The API returns the
 * ACTUAL transport outcome, and this renders it — a failed send says so, with
 * the reason, and offers a retry. The blueprint requirement is that a family
 * never appears to have been contacted when the email bounced, because the
 * consequence is a clinic waiting weeks on a form nobody received.
 *
 * The link itself is never displayed or returned to the browser: it is a
 * bearer credential for the family's inbox, and putting it on a staff screen
 * would make it copyable by anyone who can see that screen.
 */

const STATUS_VIEW = {
  COMPLETED: { label: 'Details received', tone: 'success' },
  SENT: { label: 'Request sent', tone: 'info' },
  PENDING: { label: 'Sending…', tone: 'info' },
  FAILED: { label: 'Could not send', tone: 'danger' },
  EXPIRED: { label: 'Link expired', tone: 'warning' },
  REVOKED: { label: 'Cancelled', tone: 'muted' },
};

export function GuardianInviteCell({ clientId, guardian, invitations, canUpdate }) {
  const qc = useQueryClient();
  const toast = useToast();

  // The most recent request for THIS guardian. Older superseded ones stay in
  // the list for the audit trail but are not what the row is about.
  const latest = invitations
    .filter((i) => i.guardianId === guardian.id)
    .sort((a, b) => new Date(b.expiresAt ?? 0) - new Date(a.expiresAt ?? 0))[0] ?? null;

  const refresh = () => qc.invalidateQueries({ queryKey: ['guardian-invitations', clientId] });

  const onSettled = (result) => {
    refresh();
    // Report what actually happened, not what was attempted.
    if (result?.status === 'FAILED') {
      toast.push('We couldn’t send that email. Check the address and try again.');
    } else {
      toast.push('Information request sent.');
    }
  };

  const inviteMut = useMutation({
    mutationFn: () => inviteGuardian(clientId, guardian.id),
    onSuccess: onSettled,
    onError: () => { refresh(); toast.push('We couldn’t send that request. Please try again.'); },
  });

  const resendMut = useMutation({
    mutationFn: () => resendGuardianInvitation(clientId, latest.id),
    onSuccess: onSettled,
    onError: () => { refresh(); toast.push('We couldn’t resend that request. Please try again.'); },
  });

  const busy = inviteMut.isPending || resendMut.isPending;

  if (!guardian.email) {
    return <span className="ui-muted">Add an email address first</span>;
  }

  if (!latest) {
    if (!canUpdate) return <span className="ui-muted">Not requested</span>;
    return (
      <Button variant="ghost" onClick={() => inviteMut.mutate()} disabled={busy}>
        {busy ? 'Sending…' : 'Request details'}
      </Button>
    );
  }

  const view = STATUS_VIEW[latest.status] ?? STATUS_VIEW.PENDING;
  // A completed request is finished; re-asking a family who already replied is
  // the kind of thing that erodes their trust in the clinic.
  const canRetry = canUpdate && ['FAILED', 'EXPIRED', 'SENT', 'REVOKED'].includes(latest.status);

  return (
    <div className="guardian-invite">
      <span className={`ui-badge ui-badge--${view.tone}`}>{view.label}</span>
      {latest.status === 'FAILED' && latest.deliveryError ? (
        <span className="guardian-invite__error" title={latest.deliveryError}>
          The email didn’t go through.
        </span>
      ) : null}
      {canRetry ? (
        <Button variant="ghost" onClick={() => resendMut.mutate()} disabled={busy}>
          {busy ? 'Sending…' : latest.status === 'SENT' ? 'Send again' : 'Try again'}
        </Button>
      ) : null}
    </div>
  );
}
