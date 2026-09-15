import { useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { createSession, listAppointments, listPlans, listClients } from '@/api/client';
import { useToast } from '@/components';
import { PageHeader, Card, Button, Icon, Badge, Stepper, WizardPanel, Field, Textarea, Select, Spinner } from '@/ui';
import { formatDate, formatFullName, formatTime } from '@/lib/format';

/**
 * New session — the entry point to capture. It creates a DRAFT session from a
 * scheduled appointment (already scoped server-side to the caller's own
 * appointments) via the real createSession endpoint, then hands off to the
 * session detail page where the lifecycle runs.
 *
 * Two spec fixes live here:
 *  • §6/§7/§32 — appointments are shown as "Child — MM/DD/YYYY • h:mm AM" with
 *    NO UUID, and date-only appointments never invent a clock time. The label
 *    is searchable (child / date / time) because Select filters on it.
 *  • §8/§14/§15 — the treatment plan is OPTIONAL. The RBT is never blocked when
 *    no plan exists; a friendly fallback replaces the picker and the session is
 *    created plan-less. The empty plan id is omitted from the payload, which is
 *    the exact POST /api/v1/sessions 422 this removes.
 */
const STEPS = [{ id: 'ctx', label: 'Appointment' }, { id: 'plan', label: 'Treatment plan' }, { id: 'review', label: 'Review & create' }];

function apptTimeLabel(a) {
  // Date-only appointment: show the date only — never a fabricated midnight (§32).
  if (!a?.startAt || a.timeSet === false) return '';
  const t = (v) => formatTime(v);
  return a.endAt ? `${t(a.startAt)} – ${t(a.endAt)}` : t(a.startAt);
}

export function SessionCreateRedesign() {
  const navigate = useNavigate();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [appointmentId, setAppointmentId] = useState('');
  const [treatmentPlanId, setTreatmentPlanId] = useState('');
  const [narrative, setNarrative] = useState('');
  const [errors, setErrors] = useState({});

  // Only schedulable appointments (upcoming/scheduled) are offered. The backend
  // already scopes these to the authenticated clinician's own appointments.
  const appts = useQuery({ queryKey: ['appointments', 'schedulable'], queryFn: () => listAppointments({ status: 'SCHEDULED' }) });
  const plans = useQuery({ queryKey: ['plans', 'active'], queryFn: () => listPlans({ status: 'ACTIVE' }) });
  // Resolve child display names so appointments read as names, not client UUIDs.
  const clients = useQuery({ queryKey: ['clients', 'name-map'], queryFn: () => listClients({ limit: 100 }) });

  const apptItems = appts.data?.items ?? [];
  const planItems = plans.data?.items ?? plans.data ?? [];
  const hasPlans = planItems.length > 0;

  const nameById = useMemo(() => {
    const map = new Map();
    for (const c of clients.data?.items ?? []) {
      const nm = formatFullName({ firstName: c.firstName, middleName: c.middleName, lastName: c.lastName })
        || c.preferredName || c.clientNumber || '';
      if (nm) map.set(c.id, nm);
    }
    return map;
  }, [clients.data]);

  const childName = (a) => a?.clientName || nameById.get(a?.clientId) || 'Client';
  const apptLabel = (a) => {
    const date = a?.startAt ? formatDate(a.startAt) : 'Unscheduled';
    const time = apptTimeLabel(a);
    return `${childName(a)} — ${date}${time ? ` • ${time}` : ''}`;
  };

  const apptOpts = apptItems.map((a) => ({ value: a.id, label: apptLabel(a) }));
  const planOpts = planItems.map((p) => ({ value: p.id, label: p.title || p.name || 'Treatment plan', badge: { tone: 'accent', text: p.status || 'ACTIVE' } }));
  const chosenAppt = apptItems.find((a) => a.id === appointmentId);
  const chosenPlan = planItems.find((p) => p.id === treatmentPlanId);

  const create = useMutation({
    // Omit treatmentPlanId entirely when none is chosen — the plan is optional
    // and an empty value must never be sent (§15/§17).
    mutationFn: () => createSession({
      appointmentId,
      ...(treatmentPlanId ? { treatmentPlanId } : {}),
      ...(narrative.trim() ? { narrative: narrative.trim() } : {}),
    }),
    onSuccess: (created) => { toast.push('Session created — ready to capture.'); navigate(`/sessions/${created.id}`); },
    onError: (err) => setErrors({ submit: err?.response?.data?.error?.message && !/^[A-Z]+-\d+$/.test(err.response.data.error.message) ? err.response.data.error.message : 'Could not create the session. Check the appointment and try again.' }),
  });

  function next() {
    // The appointment is required; the treatment plan is NOT (§8/§14).
    if (step === 0 && !appointmentId) { setErrors({ appointmentId: 'Choose the appointment for this session.' }); return; }
    setErrors({}); setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }
  const back = () => setStep((s) => Math.max(s - 1, 0));

  return (
    <>
      <PageHeader title="New session" subtitle="Start a session from a scheduled appointment. You’ll capture data on the next screen." />
      <Card>
        <Stepper steps={STEPS} current={step} />
        <AnimatePresence mode="wait">
          {step === 0 && (
            <WizardPanel key="ctx">
              <Field label="Appointment" required error={errors.appointmentId} hint="Search by child, date or time">
                {(appts.isLoading || clients.isLoading) ? <Spinner /> : <Select value={appointmentId} onChange={setAppointmentId} options={apptOpts} placeholder="Select an appointment…" emptyText="No scheduled appointments" />}
              </Field>
              {chosenAppt && (
                <div className="rx-list" style={{ marginTop: 8 }}>
                  <div className="rx-row"><Icon.Calendar size={18} /><div className="rx-row__main"><div className="rx-row__title">{childName(chosenAppt)}</div><div className="rx-row__meta">{chosenAppt.startAt ? formatDate(chosenAppt.startAt) : '—'}{apptTimeLabel(chosenAppt) ? ` • ${apptTimeLabel(chosenAppt)}` : ''}</div></div><Badge status={chosenAppt.status} /></div>
                </div>
              )}
            </WizardPanel>
          )}
          {step === 1 && (
            <WizardPanel key="plan">
              {hasPlans ? (
                <Field label="Treatment plan" hint="Optional — you can start and document without one">
                  {plans.isLoading ? <Spinner /> : <Select value={treatmentPlanId} onChange={setTreatmentPlanId} options={planOpts} placeholder="Select a plan…" clearable emptyText="No active plans" />}
                </Field>
              ) : (
                <div className="rx-alert" style={{ color: 'var(--color-state-info)', background: 'var(--color-state-info-surface)' }}>
                  <Icon.Clipboard size={18} />
                  <span>No treatment plan is currently available for this session. You can still start and document today’s session activity on the next screen.</span>
                </div>
              )}
              <Field label="Opening note" hint="Optional — full documentation happens during capture">
                <Textarea value={narrative} onChange={(e) => setNarrative(e.target.value)} placeholder="Anything to note before you start…" />
              </Field>
            </WizardPanel>
          )}
          {step === 2 && (
            <WizardPanel key="review">
              <div className="rx-list">
                <div className="rx-row"><div className="rx-row__main"><div className="rx-row__meta">Child</div><div className="rx-row__title">{childName(chosenAppt)}</div></div></div>
                <div className="rx-row"><div className="rx-row__main"><div className="rx-row__meta">Appointment</div><div className="rx-row__title">{chosenAppt?.startAt ? formatDate(chosenAppt.startAt) : '—'}{apptTimeLabel(chosenAppt) ? ` • ${apptTimeLabel(chosenAppt)}` : ''}</div></div></div>
                <div className="rx-row"><div className="rx-row__main"><div className="rx-row__meta">Treatment plan</div><div className="rx-row__title">{chosenPlan?.title || chosenPlan?.name || 'None — document during the session'}</div></div></div>
                <div className="rx-row"><div className="rx-row__main"><div className="rx-row__meta">Opening note</div><div className="rx-row__title">{narrative.trim() || '—'}</div></div></div>
              </div>
              <div className="rx-alert" style={{ marginTop: 14, color: 'var(--color-state-info)', background: 'var(--color-state-info-surface)' }}>
                <Icon.Clock size={18} /><span>This creates a DRAFT session. You’ll clock in, capture data, sign and submit on the next screen.</span>
              </div>
              {errors.submit && <p className="rx-formfield__err" style={{ marginTop: 12 }}>{errors.submit}</p>}
            </WizardPanel>
          )}
        </AnimatePresence>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
          <Button variant="ghost" onClick={step === 0 ? () => navigate('/sessions') : back}>{step === 0 ? 'Cancel' : 'Back'}</Button>
          {step < 2 ? <Button onClick={next} icon={Icon.Arrow}>Continue</Button>
            : <Button onClick={() => create.mutate()} loading={create.isPending} icon={Icon.Check}>Create & start capture</Button>}
        </div>
      </Card>
    </>
  );
}

export default SessionCreateRedesign;
