import { useMemo, useState } from 'react';
import { usePermissions } from '@/auth/permissions';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addGuardian, archiveClient, getClient, assignCareTeam, removeCareTeam, listStaff } from '@/api/client';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { InsurancePanel } from './InsurancePanel';
import { GuardianInviteCell } from './GuardianInviteCell';
import { fetchGuardianInvitations } from '@/api/client';
import { formatDate, formatFullName } from '@/lib/format';
import { Button, Card, LoadingState, ErrorState, EmptyState } from '@/components';

const RELATIONSHIPS = ['PARENT', 'LEGAL_GUARDIAN', 'FOSTER_PARENT', 'RELATIVE', 'SELF', 'OTHER'];
// User-facing care-team roles (spec Module 1.5 / 4.2): exactly BCBA, RBT, Manager.
// "Therapist" is retired from the selector; the legacy enum value survives in the
// backend for historical rows but is never offered as a new choice.
const CARE_TEAM_ROLES = ['BCBA', 'RBT', 'MANAGER'];

/** Human labels — an enum name is never shown to a user. */
const CARE_TEAM_ROLE_LABEL = {
  MANAGER: 'Manager',
  BCBA: 'BCBA',
  RBT: 'RBT',
  THERAPIST: 'Therapist', // legacy display only, for historical rows
};

/**
 * Which canonical RBAC role keys may hold each care-team position (spec Module 4
 * Parts 8/12). Role truth is roleKeys, never the free-text discipline. MANAGER
 * maps to the managerial keys that exist in the system.
 */
const ROLE_KEY_FOR = {
  BCBA: ['bcba'],
  RBT: ['rbt'],
  MANAGER: ['manager', 'clinical_manager', 'org_admin', 'owner'],
};

/**
 * Full client record: demographics, guardians (with an inline add form),
 * contacts, and intake. Edit and archive are shown only to principals with the
 * matching permission; the server enforces the same regardless. Archive is a
 * soft, cascading action — never a destructive delete.
 */
export function ClientDetailPage() {
  const { clientId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { permissions: permissions, ready: authReady } = usePermissions();
  const canUpdate = permissions.includes('clients.update');
  const canArchive = permissions.includes('clients.archive');

  // Outstanding and past information requests, so the guardian row can show
  // whether the family has been asked and whether the email actually landed.
  const invitationsQuery = useQuery({
    queryKey: ['guardian-invitations', clientId],
    queryFn: () => fetchGuardianInvitations(clientId),
    enabled: Boolean(clientId) && permissions.includes('clients.read'),
  });

  const query = useQuery({ queryKey: ['client', clientId], queryFn: () => getClient(clientId) });

  const [guardian, setGuardian] = useState({ firstName: '', lastName: '', relationship: 'PARENT', isPrimary: false });
  const [showGuardian, setShowGuardian] = useState(false);

  const addGuardianMutation = useMutation({
    mutationFn: () => addGuardian(clientId, {
      firstName: guardian.firstName.trim(),
      lastName: guardian.lastName.trim(),
      relationship: guardian.relationship,
      isPrimary: guardian.isPrimary,
    }),
    onSuccess: async () => {
      setGuardian({ firstName: '', lastName: '', relationship: 'PARENT', isPrimary: false });
      setShowGuardian(false);
      await queryClient.invalidateQueries({ queryKey: ['client', clientId] });
    },
  });

  const [assignment, setAssignment] = useState({ staffProfileId: '', role: 'BCBA', isPrimary: false });
  const [showAssign, setShowAssign] = useState(false);
  // Removing someone from a care team revokes their access to this child's
  // record, so it gets a confirmation rather than a bare click.
  const [confirmRemove, setConfirmRemove] = useState(null);
  const staffQuery = useQuery({
    queryKey: ['staff', 'active'],
    queryFn: () => listStaff({ status: 'ACTIVE', limit: 100 }),
    enabled: canUpdate,
  });

  const assignMutation = useMutation({
    mutationFn: () => assignCareTeam(clientId, {
      staffProfileId: assignment.staffProfileId,
      role: assignment.role,
      isPrimary: assignment.isPrimary,
    }),
    onSuccess: async () => {
      setAssignment({ staffProfileId: '', role: 'BCBA', isPrimary: false });
      setShowAssign(false);
      await queryClient.invalidateQueries({ queryKey: ['client', clientId] });
    },
  });

  const removeAssignmentMutation = useMutation({
    mutationFn: (assignmentId) => removeCareTeam(clientId, assignmentId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['client', clientId] });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: () => archiveClient(clientId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['clients'] });
      await queryClient.invalidateQueries({ queryKey: ['client', clientId] });
    },
  });

  if (query.isLoading) return <LoadingState label="Loading client…" />;
  if (query.isError) return <ErrorState message="Could not load the client." onRetry={() => query.refetch()} />;

  const { client, guardians, contacts, intake, careTeam = [] } = query.data;
  // Only staff eligible for the role being assigned. The backend already
  // refuses a wrong-role, inactive or cross-tenant assignment; filtering here
  // means the user never picks someone the server will reject, which is a
  // better experience than a 422 after the fact. It is NOT the control — the
  // control is in clients.service.assignCareTeam.
  const staffOptions = useMemo(() => {
    const all = staffQuery.data?.items ?? [];
    return all.filter((s) => {
      if (s.status !== 'ACTIVE') return false;
      // Someone already holding this exact role on this child is not eligible
      // again — the backend rejects the duplicate with ASSIGNMENT_EXISTS.
      if (careTeam.some((a) => a.staffProfileId === s.id && a.role === assignment.role)) return false;
      // Offer only people who actually hold the role being assigned. The API
      // now returns each staff member's RBAC role keys; before it did, this
      // list showed the whole roster for every role and a user discovered the
      // mismatch as a rejection AFTER choosing a name.
      //
      // An absent roleKeys array means an older API build — fall through to
      // showing the person rather than emptying the dropdown, since the
      // backend remains the control either way.
      const required = ROLE_KEY_FOR[assignment.role] ?? [];
      const keys = Array.isArray(s.roleKeys) ? s.roleKeys.map((k) => String(k).toLowerCase()) : [];
      return keys.some((k) => required.includes(k));
    });
  }, [staffQuery.data, careTeam, assignment.role]);

  return (
    <div className="ui-stack">
      <div className="ui-row" style={{ justifyContent: 'space-between' }}>
        <h1>{formatFullName(client)}</h1>
        <div className="ui-row">
          {canUpdate ? <Link className="ui-button ui-button--ghost" to={`/clients/${clientId}/edit`}>Edit</Link> : null}
          {canArchive && client.status !== 'ARCHIVED' ? (
            <Button variant="ghost" onClick={() => archiveMutation.mutate()} disabled={archiveMutation.isPending}>
              {archiveMutation.isPending ? 'Archiving…' : 'Archive'}
            </Button>
          ) : null}
        </div>
      </div>

      <Card>
        <h2>Demographics</h2>
        <dl className="ui-fields">
          <div className="ui-field"><dt>Client #</dt><dd>{client.clientNumber}</dd></div>
          <div className="ui-field"><dt>Status</dt><dd>{client.status}</dd></div>
          <div className="ui-field"><dt>Date of birth</dt><dd>{client.dateOfBirth ? (formatDate(client.dateOfBirth) || '—') : '—'}</dd></div>
          <div className="ui-field"><dt>Email</dt><dd>{client.email ?? '—'}</dd></div>
          <div className="ui-field"><dt>Phone</dt><dd>{client.phone ?? '—'}</dd></div>
          <div className="ui-field"><dt>SSN</dt><dd>{client.ssn ?? '—'}</dd></div>
        </dl>
      </Card>

      {/*
        Insurance sits directly beneath demographics and above everything
        clinical, because blueprint 6.2 makes it the gate on all of it:
        "Nothing further can proceed until insurance is verified, and the
        pipeline says so." Putting it here is the pipeline saying so.
      */}
      <InsurancePanel
        clientId={clientId}
        canEdit={canUpdate}
        canVerify={permissions.includes('clients.verify_insurance')}
      />

      <Card>
        <div className="ui-row" style={{ justifyContent: 'space-between' }}>
          <h2>Guardians</h2>
          {canUpdate ? (
            <Button variant="ghost" onClick={() => setShowGuardian((v) => !v)}>{showGuardian ? 'Close' : 'Add guardian'}</Button>
          ) : null}
        </div>
        {showGuardian ? (
          <form
            onSubmit={(e) => { e.preventDefault(); addGuardianMutation.mutate(); }}
            className="ui-stack"
          >
            <div className="ui-fields">
              <label className="field"><span>First name</span><input className="input" value={guardian.firstName} onChange={(e) => setGuardian((g) => ({ ...g, firstName: e.target.value }))} required /></label>
              <label className="field"><span>Last name</span><input className="input" value={guardian.lastName} onChange={(e) => setGuardian((g) => ({ ...g, lastName: e.target.value }))} required /></label>
              <label className="field"><span>Relationship</span>
                <select className="input" value={guardian.relationship} onChange={(e) => setGuardian((g) => ({ ...g, relationship: e.target.value }))}>
                  {RELATIONSHIPS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
              <label className="field"><span>Primary</span>
                <input type="checkbox" checked={guardian.isPrimary} onChange={(e) => setGuardian((g) => ({ ...g, isPrimary: e.target.checked }))} />
              </label>
            </div>
            {addGuardianMutation.isError ? <p className="form-error" role="alert">Could not add the guardian.</p> : null}
            <div><button type="submit" className="ui-button" disabled={addGuardianMutation.isPending}>{addGuardianMutation.isPending ? 'Adding…' : 'Add guardian'}</button></div>
          </form>
        ) : null}
        {guardians.length === 0 ? <EmptyState message="No guardians recorded." /> : (
          <table className="table">
            <thead><tr><th>Name</th><th>Relationship</th><th>Primary</th><th>Information request</th></tr></thead>
            <tbody>
              {guardians.map((g) => (
                <tr key={g.id}>
                  <td>{formatFullName(g)}</td>
                  <td>{g.relationship}</td>
                  <td>{g.isPrimary ? 'Yes' : '—'}</td>
                  <td>
                    <GuardianInviteCell
                      clientId={clientId}
                      guardian={g}
                      invitations={invitationsQuery.data?.items ?? []}
                      canUpdate={canUpdate}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card>
        <div className="ui-row" style={{ justifyContent: 'space-between' }}>
          <h2>Care team</h2>
          {canUpdate ? (
            <Button variant="ghost" onClick={() => setShowAssign((v) => !v)}>{showAssign ? 'Close' : 'Assign staff'}</Button>
          ) : null}
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          The child’s standing team. This is separate from the staff chosen on each individual appointment.
        </p>
        {showAssign ? (
          <form
            onSubmit={(e) => { e.preventDefault(); assignMutation.mutate(); }}
            className="ui-stack"
          >
            <div className="ui-fields">
              <label className="field"><span>Role</span>
                <select className="input" value={assignment.role} onChange={(e) => setAssignment((a) => ({ ...a, role: e.target.value }))}>
                  {CARE_TEAM_ROLES.map((r) => <option key={r} value={r}>{CARE_TEAM_ROLE_LABEL[r] ?? r}</option>)}
                </select>
              </label>
              <label className="field"><span>Staff member</span>
                <select className="input" value={assignment.staffProfileId} onChange={(e) => setAssignment((a) => ({ ...a, staffProfileId: e.target.value }))} required>
                  <option value="" disabled>Select a staff member…</option>
                  {staffOptions.map((s) => (
                    <option key={s.id} value={s.id}>{formatFullName(s)}{s.title ? ` (${s.title})` : ''}</option>
                  ))}
                </select>
              </label>
              <label className="field"><span>Primary</span>
                <input type="checkbox" checked={assignment.isPrimary} onChange={(e) => setAssignment((a) => ({ ...a, isPrimary: e.target.checked }))} />
              </label>
            </div>
            {staffQuery.isLoading ? <p className="muted">Loading staff…</p> : null}
            {!staffQuery.isLoading && staffOptions.length === 0 ? (
              <p className="muted">
                Nobody on the team currently holds this role, or everyone eligible is already assigned.
              </p>
            ) : null}
            {assignMutation.isError ? <p className="form-error" role="alert">Could not assign that staff member. They may already hold that role, or be inactive.</p> : null}
            <div><button type="submit" className="ui-button" disabled={assignMutation.isPending || !assignment.staffProfileId}>{assignMutation.isPending ? 'Assigning…' : 'Assign to care team'}</button></div>
          </form>
        ) : null}
        {careTeam.length === 0 ? <EmptyState message="No care team assigned yet." /> : (
          <table className="table">
            <thead><tr><th>Role</th><th>Staff</th><th>Primary</th>{canUpdate ? <th aria-label="Actions" /> : null}</tr></thead>
            <tbody>
              {careTeam.map((a) => (
                <tr key={a.id}>
                  <td>{CARE_TEAM_ROLE_LABEL[a.role] ?? a.role}</td>
                  <td>{a.staffName ?? a.staffProfileId}</td>
                  <td>{a.isPrimary ? 'Yes' : '—'}</td>
                  {canUpdate ? (
                    <td>
                      <Button variant="ghost" onClick={() => setConfirmRemove(a)} disabled={removeAssignmentMutation.isPending}>Remove</Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card>
        <h2>Contacts</h2>
        {contacts.length === 0 ? <EmptyState message="No contacts recorded." /> : (
          <table className="table">
            <thead><tr><th>Name</th><th>Type</th><th>Phone</th></tr></thead>
            <tbody>
              {contacts.map((k) => (
                <tr key={k.id}><td>{k.name}</td><td>{k.contactType}</td><td>{k.phone ?? '—'}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card>
        <h2>Intake</h2>
        {intake ? (
          <dl className="ui-fields">
            <div className="ui-field"><dt>Status</dt><dd>{intake.status}</dd></div>
            <div className="ui-field"><dt>Referral source</dt><dd>{intake.referralSource ?? '—'}</dd></div>
            <div className="ui-field"><dt>Payer</dt><dd>{intake.insurance?.payerName ?? '—'}</dd></div>
            <div className="ui-field"><dt>Member ID</dt><dd>{intake.insurance?.memberId ?? '—'}</dd></div>
          </dl>
        ) : <EmptyState message="No intake form yet." />}
      </Card>
    
      <ConfirmDialog
        open={Boolean(confirmRemove)}
        title="Remove from care team?"
        message={confirmRemove
          ? `${confirmRemove.staffName ?? 'This staff member'} will no longer have access to this child’s record or appear on their team.`
          : ''}
        confirmLabel="Remove"
        tone="danger"
        busy={removeAssignmentMutation.isPending}
        onConfirm={() => {
          if (!confirmRemove) return;
          removeAssignmentMutation.mutate(confirmRemove.id, {
            onSuccess: () => setConfirmRemove(null),
          });
        }}
        onCancel={() => setConfirmRemove(null)}
      />
</div>
  );
}
