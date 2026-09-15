import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { getClient, listPlans, getPlan, updatePlan } from '@/api/client';
import { useToast } from '@/components';
import { PageHeader, Card, Badge, Button, Icon, Tabs, Spinner, ErrorState, EmptyState, DataTable } from '@/ui';
import { AssignmentPanel } from './AssignmentPanel.jsx';
import { MedicalPanel } from './MedicalPanel.jsx';
import { ProgressPanel } from './ProgressPanel.jsx';
import { formatFullName, formatDate, statusLabel } from '@/lib/format';

/**
 * BCBA CLINICAL child view — the BCBA is the clinical PLANNING authority, not a
 * second Company admin (blueprint Part 3). This page is deliberately NOT the
 * Company child editor:
 *   - Medical/clinical information is READ-ONLY (Company owns medical admin).
 *   - Care team is READ-ONLY (no assign/replace — Company owns the care team).
 *   - No child editor, no guardian/insurance/authorization admin, no payroll.
 *   - The BCBA's real work — treatment plan, goals, weekly plan, progress — is
 *     surfaced and reuses the existing /plans editor (no duplicated logic).
 * The backend already redacts compensation and guardian contact for this role,
 * so nothing sensitive is fetched to be hidden here.
 */
const TABS = [
  { id: 'summary', label: 'Clinical summary', icon: Icon.Grid },
  { id: 'medical', label: 'Medical', icon: Icon.Shield },
  { id: 'plan', label: 'Treatment plan', icon: Icon.Doc },
  { id: 'careteam', label: 'Care team', icon: Icon.Users },
  { id: 'progress', label: 'Progress', icon: Icon.Trend },
];

function InfoRow({ label, value }) {
  return <div className="rx-row"><div className="rx-row__main"><div className="rx-row__meta">{label}</div><div className="rx-row__title">{value ?? '—'}</div></div></div>;
}

export function BcbaChildView() {
  const { clientId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState('summary');
  const client = useQuery({ queryKey: ['client', clientId], queryFn: () => getClient(clientId) });
  const plans = useQuery({ queryKey: ['plans', 'client', clientId], queryFn: () => listPlans({ clientId }) });

  // Activate a DRAFT plan (DRAFT → ACTIVE) using the existing lifecycle: fetch
  // the plan for its current version, then updatePlan with an If-Match. This is
  // the deliberate publish step that makes the plan visible to the assigned RBT —
  // no global status forcing, no new endpoint.
  const activate = useMutation({
    mutationFn: async (planId) => {
      const { plan } = await getPlan(planId);
      return updatePlan(planId, { status: 'ACTIVE' }, plan.version);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plans', 'client', clientId] });
      toast.push('Plan activated — the assigned RBT can now see it.');
    },
    onError: (e) => toast.push(e?.response?.data?.error?.message ?? 'Could not activate the plan.', 'negative'),
  });

  if (client.isLoading) return <Spinner />;
  if (client.isError) return <ErrorState onRetry={() => client.refetch()} />;

  const detail = client.data ?? {};
  const c = detail.client ?? detail;
  const careTeam = detail.careTeam ?? [];
  const guardians = detail.guardians ?? []; // contact already stripped by the server for BCBA
  const active = (a) => (a.status ?? 'ACTIVE') === 'ACTIVE';
  const rbt = careTeam.find((m) => m.role === 'RBT' && active(m));
  const planItems = plans.data?.items ?? [];
  const activePlan = planItems.find((p) => p.status === 'ACTIVE') ?? planItems[0];
  const planStatus = activePlan ? (activePlan.status || 'Draft') : 'No plan yet';

  const fullName = formatFullName({ firstName: c.firstName, lastName: c.lastName }) || 'Not provided';

  return (
    <>
      <PageHeader
        eyebrow="Client"
        title={fullName}
        subtitle={<span>Assigned RBT: {rbt ? rbt.staffName || 'Assigned' : 'Not assigned'} · Treatment plan: {activePlan ? statusLabel(planStatus) : 'Not created yet'}</span>}
        actions={<Badge status={c.status} />}
      />
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      <div style={{ marginTop: 20 }}>
        {tab === 'summary' && (
          <div className="rx-cols-2">
            <Card title="Child details">
              <div className="rx-list">
                <InfoRow label="Full name" value={fullName} />
                <InfoRow label="Client number" value={c.clientNumber || 'Not provided'} />
                <InfoRow label="Date of birth" value={c.dateOfBirth ? (formatDate(c.dateOfBirth) || 'Not provided') : 'Not provided'} />
                <InfoRow label="Account status" value={<Badge status={c.status} />} />
              </div>
            </Card>
            <Card title="Medical summary" hint="Read-only · maintained by your organization">
              {/* Company owns medical administration; the BCBA reads it. There is
                  no medical-condition CRUD here by design. */}
              <div className="rx-list">
                <InfoRow label="Intake status" value={(c.intakeWorkflowStatus || 'Not started').replace(/_/g, ' ')} />
                <InfoRow label="Guardians on file" value={guardians.length > 0 ? guardians.map((g) => `${formatFullName({ firstName: g.firstName, lastName: g.lastName })}${g.relationship ? ` (${g.relationship})` : ''}`).join(', ') : 'No medical information added yet.'} />
              </div>
            </Card>
          </div>
        )}
        {tab === 'plan' && (
          <Card
            title="Treatment plans"
            hint="Goals, programs and targets for this client"
            action={<Button variant="subtle" icon={Icon.Plus} onClick={() => navigate(`/plans/new?clientId=${clientId}`)}>New treatment plan</Button>}
          >
            {plans.isLoading && <Spinner />}
            {plans.isError && <ErrorState onRetry={() => plans.refetch()} />}

            {plans.isSuccess && planItems.length === 0 && (
              <EmptyState
                icon={Icon.Doc}
                title="No treatment plan yet"
                body="Create a treatment plan to define goals, programs and the weekly plan for the assigned RBT."
                action={<Button icon={Icon.Plus} onClick={() => navigate(`/plans/new?clientId=${clientId}`)}>Create treatment plan</Button>}
              />
            )}

            {plans.isSuccess && planItems.length > 0 && (
              <div className="rx-stack">
                {activePlan && (
                  <div className="rx-activeplan">
                    <div className="rx-activeplan__label">
                      {activePlan.status === 'ACTIVE' ? 'Active treatment plan' : 'Latest treatment plan'}
                    </div>
                    <div className="rx-activeplan__row">
                      <div className="rx-activeplan__title">{activePlan.title || 'Treatment plan'}</div>
                      <Badge status={activePlan.status}>{statusLabel(activePlan.status)}</Badge>
                    </div>
                    {activePlan.updatedAt && (
                      <div className="rx-activeplan__meta">Updated {formatDate(activePlan.updatedAt)}</div>
                    )}
                    <div className="rx-activeplan__actions">
                      <Button size="sm" variant="ghost" icon={Icon.Eye} onClick={() => navigate(`/plans/${activePlan.id}`)}>View</Button>
                      <Button size="sm" variant="ghost" icon={Icon.Doc} onClick={() => navigate(`/plans/${activePlan.id}/edit`)}>Edit</Button>
                      {activePlan.status === 'DRAFT' && (
                        <Button size="sm" variant="subtle" icon={Icon.Check} loading={activate.isPending} onClick={() => activate.mutate(activePlan.id)}>Activate</Button>
                      )}
                    </div>
                  </div>
                )}

                <DataTable
                  query={plans}
                  columns={[
                    { key: 'name', header: 'Plan', render: (r) => r.title || r.name || 'Treatment plan' },
                    { key: 'status', header: 'Status', render: (r) => <Badge status={r.status}>{statusLabel(r.status)}</Badge> },
                    { key: 'updated', header: 'Updated', render: (r) => (r.updatedAt ? formatDate(r.updatedAt) : '—') },
                    { key: 'open', header: '', render: (r) => (
                      <span style={{ display: 'inline-flex', gap: 6 }}>
                        {r.status === 'DRAFT' && (
                          <Button size="sm" variant="subtle" icon={Icon.Check} loading={activate.isPending} onClick={() => activate.mutate(r.id)}>Activate</Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => navigate(`/plans/${r.id}`)}>Open</Button>
                      </span>
                    ) },
                  ]}
                  empty={null}
                />
              </div>
            )}
          </Card>
        )}
        {tab === 'careteam' && <AssignmentPanel clientId={clientId} />}
        {tab === 'medical' && <MedicalPanel clientId={clientId} />}
        {tab === 'progress' && <ProgressPanel clientId={clientId} />}
      </div>
    </>
  );
}

export default BcbaChildView;
