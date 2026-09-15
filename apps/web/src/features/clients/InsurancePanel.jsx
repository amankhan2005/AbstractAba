import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchCoverage, createCoverage, verifyCoverage } from '@/api/client';
import { Card } from '@/components/Card';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ErrorState, EmptyState, LoadingState } from '@/components/StateViews';
import { useToast } from '@/components/Toast';

/**
 * Insurance coverage for one client — blueprint §6.2 / §6.9.
 *
 * This panel exists because the scheduling gate was enforced with no way to
 * clear it: coverage could not be recorded or verified from anywhere in the
 * product, so every booking was refused and the clinic had no path forward.
 *
 * The panel leads with the ELIGIBILITY ANSWER rather than the record list,
 * because §6.2's requirement is that "the pipeline says so" — a user needs to
 * know whether services can be scheduled before they need the plan details.
 * Saying it here, in advance, is also why the user never has to discover the
 * gate through a 422 after filling in a booking form.
 */

/** Status presentation. Every state gets plain language and a visible reason. */
const STATUS_VIEW = {
  VERIFIED: { label: 'Insurance verified', tone: 'success' },
  PRIVATE_PAY: { label: 'Private pay — no insurer to verify', tone: 'success' },
  PENDING: { label: 'Verification in progress', tone: 'warning' },
  UNVERIFIED: { label: 'Verification required', tone: 'warning' },
  NEEDS_CORRECTION: { label: 'Insurance details need attention', tone: 'warning' },
  FAILED: { label: 'Insurer could not confirm coverage', tone: 'danger' },
  EXPIRED: { label: 'Needs checking again', tone: 'danger' },
  NO_COVERAGE: { label: 'No insurance on file', tone: 'warning' },
};

const view = (status) => STATUS_VIEW[status] ?? { label: 'Verification required', tone: 'warning' };

const BLANK = {
  payerName: '', planName: '', memberId: '', groupNumber: '',
  benefitOrder: 'PRIMARY', fundingSource: 'COMMERCIAL',
  subscriberRelationship: 'PARENT', subscriberName: '',
};

export function InsurancePanel({ clientId, canEdit = false, canVerify = false }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(BLANK);
  const [verifying, setVerifying] = useState(null);

  const query = useQuery({
    queryKey: ['coverage', clientId],
    queryFn: () => fetchCoverage(clientId),
    enabled: Boolean(clientId),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['coverage', clientId] });
    // Eligibility changes what can be scheduled, so the schedule is stale too.
    qc.invalidateQueries({ queryKey: ['appointments'] });
  };

  const addMut = useMutation({
    mutationFn: () => createCoverage(clientId, clean(form)),
    onSuccess: () => {
      setAdding(false);
      setForm(BLANK);
      invalidate();
      toast.push('Insurance details saved. Verification is still required.');
    },
    onError: (err) => toast.push(friendly(err)),
  });

  const verifyMut = useMutation({
    mutationFn: ({ coverageId, status, note }) => verifyCoverage(clientId, coverageId, { status, ...(note ? { note } : {}) }),
    onSuccess: (_d, vars) => {
      setVerifying(null);
      invalidate();
      toast.push(vars.status === 'VERIFIED'
        ? 'Insurance verified. Services can now be scheduled.'
        : 'Verification result recorded.');
    },
    onError: (err) => toast.push(friendly(err)),
  });

  if (query.isPending) return <LoadingState label="Loading insurance details…" />;
  if (query.isError) {
    return (
      <ErrorState
        message="We couldn’t load the insurance details."
        onRetry={() => query.refetch()}
      />
    );
  }

  const { items, status } = query.data;
  const gate = status ? view(status.status) : view('NO_COVERAGE');

  return (
    <Card>
      <div className="ins-head">
        <div>
          <h2 className="ins-title">Insurance</h2>
          <p className={`ui-badge ui-badge--${gate.tone}`}>{gate.label}</p>
          {status?.reason ? <p className="ins-reason">{status.reason}</p> : null}
        </div>
        {canEdit && !adding ? (
          <Button onClick={() => setAdding(true)}>Add insurance</Button>
        ) : null}
      </div>

      {adding ? (
        <form className="ins-form" onSubmit={(e) => { e.preventDefault(); addMut.mutate(); }}>
          <Field label="Insurance company" required value={form.payerName} onChange={(v) => setForm({ ...form, payerName: v })} />
          <Field label="Plan name" value={form.planName} onChange={(v) => setForm({ ...form, planName: v })} />
          <Field label="Member ID" required value={form.memberId} onChange={(v) => setForm({ ...form, memberId: v })} />
          <Field label="Group number" value={form.groupNumber} onChange={(v) => setForm({ ...form, groupNumber: v })} />
          <Select
            label="Coverage order" value={form.benefitOrder}
            onChange={(v) => setForm({ ...form, benefitOrder: v })}
            options={[['PRIMARY', 'Primary'], ['SECONDARY', 'Secondary'], ['TERTIARY', 'Tertiary']]}
          />
          <Select
            label="Funding source" value={form.fundingSource}
            onChange={(v) => setForm({ ...form, fundingSource: v })}
            options={[['COMMERCIAL', 'Commercial'], ['MEDICAID', 'Medicaid'], ['SCHOOL_DISTRICT', 'School district'], ['REGIONAL_CENTRE', 'Regional centre'], ['SINGLE_CASE_AGREEMENT', 'Single-case agreement'], ['PRIVATE_PAY', 'Private pay']]}
          />
          <Select
            label="Policy holder" value={form.subscriberRelationship}
            onChange={(v) => setForm({ ...form, subscriberRelationship: v })}
            options={[['PARENT', 'Parent'], ['GUARDIAN', 'Guardian'], ['SELF', 'The child'], ['SPOUSE', 'Spouse'], ['OTHER', 'Someone else']]}
          />
          <Field label="Policy holder name" value={form.subscriberName} onChange={(v) => setForm({ ...form, subscriberName: v })} />

          <div className="ins-form__actions">
            <Button variant="ghost" type="button" onClick={() => { setAdding(false); setForm(BLANK); }} disabled={addMut.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={addMut.isPending || !form.payerName.trim() || !form.memberId.trim()}>
              {addMut.isPending ? 'Saving…' : 'Save insurance'}
            </Button>
          </div>
        </form>
      ) : null}

      {items.length === 0 && !adding ? (
        <EmptyState
          message={canEdit
            ? 'No insurance on file. Add the family’s insurance details, then record a verification before services can be scheduled.'
            : 'No insurance details have been added for this child yet.'}
        />
      ) : null}

      {items.length > 0 ? (
        <ul className="ins-list">
          {items.map((c) => {
            const v = view(c.verificationStatus);
            return (
              <li key={c.id} className="ins-item">
                <div className="ins-item__main">
                  <strong>{c.payerName}</strong>
                  {c.planName ? <span className="ins-item__plan"> · {c.planName}</span> : null}
                  <div className="ins-item__meta">
                    Member {c.memberId}
                    {c.groupNumber ? ` · Group ${c.groupNumber}` : ''}
                    {` · ${c.benefitOrder === 'PRIMARY' ? 'Primary' : c.benefitOrder === 'SECONDARY' ? 'Secondary' : 'Tertiary'}`}
                  </div>
                  {c.verificationFailureReason ? (
                    <p className="ins-item__problem">{c.verificationFailureReason}</p>
                  ) : null}
                </div>
                <div className="ins-item__side">
                  <span className={`ui-badge ui-badge--${v.tone}`}>{v.label}</span>
                  {canVerify ? (
                    <Button variant="ghost" onClick={() => setVerifying(c)}>
                      Record verification
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      <ConfirmDialog
        open={Boolean(verifying)}
        title="Record insurance verification"
        message={verifying
          ? `Confirm that you checked coverage with ${verifying.payerName} and it is active for this child. This is what allows services to be scheduled.`
          : ''}
        confirmLabel="Coverage is active"
        busy={verifyMut.isPending}
        onConfirm={() => {
          if (!verifying) return;
          verifyMut.mutate({ coverageId: verifying.id, status: 'VERIFIED' });
        }}
        onCancel={() => setVerifying(null)}
      />
    </Card>
  );
}

/** Strips empty optional strings — the API rejects them rather than storing "". */
function clean(form) {
  return Object.fromEntries(
    Object.entries(form).filter(([, v]) => typeof v !== 'string' || v.trim() !== ''),
  );
}

/**
 * Turns an API failure into something a receptionist can act on. The server
 * already sends plain-language messages for business-rule failures; this is the
 * fallback so a network error never renders as "Request failed with status
 * code 500".
 */
function friendly(err) {
  const serverMessage = err?.response?.data?.error?.message;
  if (serverMessage && !/^[A-Z]+-\d+$/.test(serverMessage)) return serverMessage;
  if (err?.response?.status === 403) return 'You don’t have permission to do that.';
  return 'We couldn’t save that. Please check the details and try again.';
}

function Field({ label, value, onChange, required = false }) {
  return (
    <label className="ins-field">
      <span>{label}{required ? ' *' : ''}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} required={required} />
    </label>
  );
}

function Select({ label, value, onChange, options }) {
  return (
    <label className="ins-field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}
