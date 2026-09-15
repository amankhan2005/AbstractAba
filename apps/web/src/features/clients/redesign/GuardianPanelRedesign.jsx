import { useState } from 'react';
import { usePermissions } from '@/auth/permissions';
import { formatFullName, formatDate } from '@/lib/format';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getClient, addGuardian, removeGuardian, inviteGuardian, fetchGuardianInvitations, resendGuardianInvitation, revokeGuardianInvitation } from '@/api/client';
import { useToast } from '@/components';
import { Card, Button, Badge, Icon, Spinner, ErrorState, EmptyState, Modal, Confirm, Field, TextInput, Select } from '@/ui';

/**
 * Guardian management (company side). Lists guardians and their invitation state
 * with delivery/expiry, and the real actions: add guardian, send invitation,
 * resend, revoke. The blueprint has NO family portal — guardian interaction is
 * invitation + signature only — so nothing here exposes one.
 */
const INV_TONE = { PENDING: 'pending', SENT: 'info', DELIVERED: 'info', ACCEPTED: 'approved', COMPLETED: 'approved', EXPIRED: 'denied', REVOKED: 'denied' };
// User-facing parent validity (mirrors the backend activation rule).
function ClientParentValid(g) {
  const has = (v) => typeof v === 'string' && v.trim().length > 0;
  return !!g && has(g.firstName) && has(g.lastName) && has(g.phone) && has(g.email);
}

const REL_OPTS = [{ value: 'PARENT', label: 'Parent' }, { value: 'GUARDIAN', label: 'Legal guardian' }, { value: 'GRANDPARENT', label: 'Grandparent' }, { value: 'OTHER', label: 'Other' }];

export function GuardianPanelRedesign({ clientId }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { permissions: permissions, ready: authReady } = usePermissions();
  const canEdit = permissions.includes('clients.update');

  const client = useQuery({ queryKey: ['client', clientId], queryFn: () => getClient(clientId) });
  const invitations = useQuery({ queryKey: ['guardian-invitations', clientId], queryFn: () => fetchGuardianInvitations(clientId) });

  const [adding, setAdding] = useState(false);
  const [unlinking, setUnlinking] = useState(null);
  const [form, setForm] = useState({ firstName: '', lastName: '', relationship: 'PARENT', phone: '', email: '', isPrimary: false });
  // A VALID parent (backend activation rule, spec Module 2 Part 9) needs a name,
  // a mobile number AND an email. The Add button enforces the same client-side so
  // a parent added here can actually activate the child.
  const parentIsValid = form.firstName.trim() && form.lastName.trim() && form.phone.trim() && form.email.trim();
  const [confirm, setConfirm] = useState(null); // { kind:'revoke', invitationId }
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: typeof v === 'string' ? v : v.target.value }));

  // ['clients'] too: a parent change can move the client's Account between Hold and Active.
  const inval = () => { qc.invalidateQueries({ queryKey: ['client', clientId] }); qc.invalidateQueries({ queryKey: ['clients'] }); qc.invalidateQueries({ queryKey: ['guardian-invitations', clientId] }); };
  const addMut = useMutation({
    mutationFn: () => addGuardian(clientId, { firstName: form.firstName.trim(), lastName: form.lastName.trim(), relationship: form.relationship, ...(form.phone ? { phone: form.phone.trim() } : {}), ...(form.email ? { email: form.email.trim() } : {}), isPrimary: form.isPrimary }),
    onSuccess: () => { inval(); toast.push('Parent added.'); setAdding(false); setForm({ firstName: '', lastName: '', relationship: 'PARENT', phone: '', email: '', isPrimary: false }); },
    onError: () => toast.push('Could not add parent.', 'negative'),
  });
  const inviteMut = useMutation({ mutationFn: (gid) => inviteGuardian(clientId, gid), onSuccess: () => { inval(); toast.push('Invitation sent.'); }, onError: () => toast.push('Could not send invitation.', 'negative') });
  const resendMut = useMutation({ mutationFn: (iid) => resendGuardianInvitation(clientId, iid), onSuccess: () => { inval(); toast.push('Invitation resent.'); }, onError: () => toast.push('Could not resend.', 'negative') });
  const revokeMut = useMutation({ mutationFn: (iid) => revokeGuardianInvitation(clientId, iid), onSuccess: () => { inval(); toast.push('Invitation revoked.'); setConfirm(null); }, onError: () => { toast.push('Could not revoke.', 'negative'); setConfirm(null); } });
  const unlinkMut = useMutation({
    mutationFn: (gid) => removeGuardian(clientId, gid),
    onSuccess: () => { inval(); toast.push('Parent unlinked.'); setUnlinking(null); },
    onError: () => { toast.push('Could not unlink the parent.', 'negative'); },
  });

  if (client.isLoading) return <Spinner />;
  if (client.isError) return <ErrorState onRetry={() => client.refetch()} />;
  const guardians = client.data?.guardians ?? [];
  const invites = invitations.data?.items ?? [];

  return (
    <div className="rx-stack">
      <Card title="Parents" hint="A parent needs a name, mobile and email before this client can be activated"
        action={canEdit && <Button icon={Icon.Plus} onClick={() => setAdding(true)}>Add parent</Button>}>
        {guardians.length === 0 ? (
          <EmptyState icon={Icon.Users} title="No parents on file" body="Add at least one parent (name, mobile and email) before activating this client."
            action={canEdit && <Button icon={Icon.Plus} onClick={() => setAdding(true)}>Add parent</Button>} />
        ) : (
          <div className="rx-list">
            {guardians.map((g, i) => (
              <div className="rx-row" key={g.id || i}>
                <div className="rx-avatar" style={{ width: 34, height: 34 }}>{((g.firstName?.[0] || '') + (g.lastName?.[0] || '')).toUpperCase()}</div>
                <div className="rx-row__main">
                  <div className="rx-row__title">{formatFullName({ firstName: g.firstName, lastName: g.lastName })} {g.isPrimary && <Badge tone="accent">Primary</Badge>}</div>
                  <div className="rx-row__meta">{g.relationship || 'Parent'}{g.phone ? ` · ${g.phone}` : ''}{g.email ? ` · ${g.email}` : ''}{!ClientParentValid(g) ? ' · incomplete' : ''}</div>
                </div>
                {canEdit && g.id && <Button variant="ghost" icon={Icon.Bell} loading={inviteMut.isPending} onClick={() => inviteMut.mutate(g.id)}>Send invitation</Button>}
                {canEdit && g.id && <Button variant="ghost" onClick={() => setUnlinking(g)}>Unlink</Button>}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Invitations" hint="Delivery, expiry and status">
        {invitations.isLoading ? <Spinner /> : invites.length === 0 ? (
          <EmptyState icon={Icon.Inbox} title="No invitations yet" body="Send a guardian an invitation to begin." />
        ) : (
          <div className="rx-list">
            {invites.map((inv) => (
              <div className="rx-row" key={inv.id}>
                <div className="rx-row__main">
                  <div className="rx-row__title">{inv.recipientName || inv.email || 'Parent'}</div>
                  <div className="rx-row__meta">
                    {inv.deliveryStatus ? `Delivery: ${inv.deliveryStatus.toLowerCase()}` : ''}
                    {inv.expiresAt ? ` · Expires ${formatDate(inv.expiresAt)}` : ''}
                  </div>
                </div>
                <Badge tone={INV_TONE[inv.status] || 'pending'}>{(inv.status || 'pending').toLowerCase()}</Badge>
                {canEdit && ['PENDING', 'SENT', 'DELIVERED', 'EXPIRED'].includes(inv.status) && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Button variant="ghost" onClick={() => resendMut.mutate(inv.id)} loading={resendMut.isPending}>Resend</Button>
                    <Button variant="ghost" className="rx-btn--danger" style={{ color: '#fff' }} onClick={() => setConfirm({ invitationId: inv.id })}>Revoke</Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Confirm
        open={Boolean(unlinking)}
        title="Unlink parent?"
        message={unlinking ? `Remove ${unlinking.firstName} ${unlinking.lastName} from this child? This only removes the relationship — the parent record and history are kept. If this is the last valid parent, the client will move off Active.` : ""}
        confirmLabel="Unlink"
        tone="danger"
        busy={unlinkMut.isPending}
        onConfirm={() => unlinking && unlinkMut.mutate(unlinking.id)}
        onCancel={() => setUnlinking(null)}
      />

      <Modal open={adding} onClose={() => setAdding(false)} title="Add parent" description="Add a parent for this child. Name, mobile and email are required to activate the client." variant="drawer"
        footer={<><Button variant="ghost" onClick={() => setAdding(false)} disabled={addMut.isPending}>Cancel</Button>
          <Button onClick={() => addMut.mutate()} loading={addMut.isPending} disabled={!parentIsValid}>Add parent</Button></>}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <Field label="First name" required><TextInput value={form.firstName} onChange={set('firstName')} icon={Icon.User} /></Field>
          <Field label="Last name" required><TextInput value={form.lastName} onChange={set('lastName')} /></Field>
        </div>
        <Field label="Relationship"><Select value={form.relationship} onChange={set('relationship')} options={REL_OPTS} searchable={false} /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <Field label="Mobile number" required><TextInput value={form.phone} onChange={set('phone')} placeholder="(555) 555-5555" /></Field>
          <Field label="Email" required hint="Also used to deliver the invitation"><TextInput type="email" value={form.email} onChange={set('email')} /></Field>
        </div>
        {!parentIsValid && <p className="rx-formfield__hint" style={{ marginTop: 4 }}>Enter a name, mobile number and email to add a parent who can activate this client.</p>}
        <label className="rx-check" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={form.isPrimary} onChange={(e) => setForm((f) => ({ ...f, isPrimary: e.target.checked }))} /> Primary parent
        </label>
      </Modal>

      <Confirm open={!!confirm} title="Revoke invitation" tone="danger" confirmLabel="Revoke" busy={revokeMut.isPending}
        message="The family's link will stop working immediately. You can send a new invitation later."
        onCancel={() => setConfirm(null)} onConfirm={() => confirm && revokeMut.mutate(confirm.invitationId)} />
    </div>
  );
}

export default GuardianPanelRedesign;
