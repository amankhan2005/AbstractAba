import { useState } from 'react';
import { usePermissions } from '@/auth/permissions';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { listCareTeam, assignCareTeam, removeCareTeam, updateAssignment, endAssignment, messageCareTeam, listStaff } from '@/api/client';
import { useToast } from '@/components';
import { Card, Button, Badge, Icon, Select, Spinner, ErrorState, EmptyState, Confirm, Field, TextInput, DateInput, Modal } from '@/ui';
import { formatDate, formatFullName } from '@/lib/format';

/**
 * Care team / assignment (Phase 3). Assign a BCBA/RBT with weekly hours, hourly
 * pay rate and effective dates; edit or end an assignment. The BACKEND is
 * authoritative — it refuses a wrong-role, inactive or cross-tenant staff member,
 * enforces child weekly-hours capacity, validates the rate, and appends to rate
 * history on a rate change. Pay rate is shown only to roles that may read it.
 */
// User-facing care-team roles (spec Modules 1.5 / 4.2): exactly BCBA, RBT,
// Manager. "Therapist" is retired from the selector — the legacy enum value is
// kept in the backend (models/enums.js CARE_TEAM_ROLE) so historical THERAPIST
// assignments still validate, but it is never offered as a new choice.
// "Clinical manager" is relabelled to "Manager" while the internal MANAGER key
// is unchanged.
export const ROLE_OPTS = [
  { value: 'BCBA', label: 'BCBA' },
  { value: 'RBT', label: 'RBT' },
  { value: 'MANAGER', label: 'Manager' },
];

// Canonical role truth for the eligibility filter (spec Module 4 Parts 8/12/13).
// A care-team seat maps to the RBAC role keys the staff DTO already carries
// (staff.roleKeys, resolved server-side through membership). We NEVER filter on
// the free-text `discipline`. MANAGER maps to the managerial keys that actually
// exist in the system (owner/org_admin) plus manager/clinical_manager if present.
// Multi-role is handled naturally: a staff member is eligible for a seat if ANY
// of their roleKeys is in the seat's set.
export const CARE_TEAM_ROLE_TO_ROLEKEYS = {
  BCBA: ['bcba'],
  RBT: ['rbt'],
  MANAGER: ['manager', 'clinical_manager', 'org_admin', 'owner'],
};

export function isStaffEligibleForRole(staff, role) {
  if (!role) return true;
  const wanted = CARE_TEAM_ROLE_TO_ROLEKEYS[role] ?? [];
  const keys = Array.isArray(staff?.roleKeys) ? staff.roleKeys.map((k) => String(k).toLowerCase()) : [];
  return keys.some((k) => wanted.includes(k));
}
/** Written as a JS string: a JSX attribute string does not process escapes, which is how "\u2026" once rendered literally. */
export const STAFF_PLACEHOLDER = 'Select an active staff member';

/**
 * Selector options for a care-team seat: ACTIVE staff eligible for the role,
 * labelled with the real full name ("John Michael Smith"). The option VALUE is
 * the staffProfile id the assignment persists; it is never shown. A record
 * without any name is left out rather than displayed as an id.
 */
export function staffOptionsForRole(staffList = [], role) {
  return staffList
    .filter((s) => (s.status ?? 'ACTIVE') === 'ACTIVE' && isStaffEligibleForRole(s, role))
    .map((s) => ({ value: s.id, label: formatFullName(s), badge: { tone: 'accent', text: role } }))
    .filter((o) => o.label);
}

const fmtDate = (d) => (d ? formatDate(d) : null);
function initials(a = '', b = '') { return ((a[0] || '') + (b[0] || '')).toUpperCase() || '—'; }

export function AssignmentPanel({ clientId }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { permissions: permissions, ready: authReady } = usePermissions();
  // Care-team MUTATION is a Company/Admin capability (blueprint: "Company
  // controls WHO works with the child"). A BCBA/RBT reaches this same tab to
  // VIEW the roster, but must not be offered assign/replace/remove controls —
  // the backend rejects the call regardless (clients.care_team.manage), and the
  // UI must not present an action the role cannot take.
  const canManageCareTeam = permissions.includes('clients.care_team.manage');
  const [drawer, setDrawer] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [confirmEnd, setConfirmEnd] = useState(null);
  const [messaging, setMessaging] = useState(false);

  const team = useQuery({ queryKey: ['care-team', clientId], queryFn: () => listCareTeam(clientId) });
  // The server's page cap (100), not the default 25 — a larger roster must not
  // silently drop eligible staff from the selector.
  const staff = useQuery({ queryKey: ['staff', 'active'], queryFn: () => listStaff({ status: 'ACTIVE', limit: 100 }) });
  const members = Array.isArray(team.data) ? team.data : (team.data?.items ?? []);

  const invalidate = () => { qc.invalidateQueries({ queryKey: ['care-team', clientId] }); qc.invalidateQueries({ queryKey: ['client', clientId] }); };
  const remove = useMutation({
    mutationFn: (assignmentId) => removeCareTeam(clientId, assignmentId),
    onSuccess: () => { invalidate(); setConfirmRemove(null); toast.push('Removed from care team.'); },
    onError: (e) => { setConfirmRemove(null); toast.push(e?.response?.data?.error?.message ?? 'Could not remove.', 'negative'); },
  });
  const end = useMutation({
    mutationFn: (assignmentId) => endAssignment(clientId, assignmentId),
    onSuccess: () => { invalidate(); setConfirmEnd(null); toast.push('Assignment ended.'); },
    onError: (e) => { setConfirmEnd(null); toast.push(e?.response?.data?.error?.message ?? 'Could not end the assignment.', 'negative'); },
  });

  const totalAssigned = members.filter((m) => (m.status ?? 'ACTIVE') === 'ACTIVE').reduce((s, m) => s + (m.weeklyAssignedHours || 0), 0);

  return (
    <>
      <Card title="Current care team" hint={totalAssigned ? `${totalAssigned} hrs/week assigned` : undefined}
        action={<span style={{ display: 'inline-flex', gap: 8 }}>
          {permissions.includes('clients.update') && members.some((m) => (m.status ?? 'ACTIVE') === 'ACTIVE') && <Button variant="ghost" icon={Icon.Bell} onClick={() => setMessaging(true)}>Message</Button>}
          {canManageCareTeam && <Button variant="subtle" icon={Icon.Plus} onClick={() => setDrawer({})}>Assign staff</Button>}
        </span>}>
        {team.isLoading ? <Spinner /> : team.isError ? <ErrorState onRetry={() => team.refetch()} />
          : members.length === 0 ? <EmptyState icon={Icon.Users} title="No one assigned yet" body={canManageCareTeam ? 'Assign a BCBA and RBT to begin sessions.' : 'The company has not assigned a care team yet.'} />
          : (
            <div style={{ display: 'grid', gap: 12 }}>
              <AnimatePresence>
                {members.map((m, i) => {
                  const ended = (m.status ?? 'ACTIVE') === 'ENDED';
                  return (
                    <motion.div key={m.id || i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -12 }}
                      style={{ padding: 14, border: '1px solid var(--rx-line)', borderRadius: 12, opacity: ended ? 0.6 : 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div className="rx-avatar" style={{ width: 40, height: 40 }}>{initials(m.staffName?.split(', ')[1], m.staffName?.split(', ')[0])}</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600 }}>{m.staffName || 'Staff member'}</div>
                          <div className="rx-row__meta">{m.staffTitle || m.role}{m.isPrimary ? ' \u00b7 primary' : ''}</div>
                        </div>
                        <Badge tone="accent">{m.role}</Badge>
                        {ended ? <Badge status="ENDED">Ended</Badge> : canManageCareTeam ? (
                          <span style={{ display: 'inline-flex', gap: 4 }}>
                            <Button variant="ghost" onClick={() => setDrawer({ assignment: m })} aria-label="Edit"><Icon.Clipboard size={16} /></Button>
                            <Button variant="ghost" onClick={() => setConfirmEnd(m)} aria-label="End">End</Button>
                            <Button variant="ghost" onClick={() => setConfirmRemove(m)} aria-label="Remove"><Icon.Logout size={16} /></Button>
                          </span>
                        ) : null}
                      </div>
                      <div style={{ display: 'flex', gap: 20, marginTop: 10, flexWrap: 'wrap', fontSize: '.85rem', color: 'var(--rx-ink-soft)' }}>
                        <span><span style={{ color: 'var(--rx-ink-faint)' }}>Weekly </span>{m.weeklyAssignedHours != null ? `${m.weeklyAssignedHours} hrs` : 'Not set'}</span>
                        <span><span style={{ color: 'var(--rx-ink-faint)' }}>Effective </span>{m.effectiveStartDate || m.effectiveEndDate ? `${fmtDate(m.effectiveStartDate) || '\u2014'} \u2192 ${fmtDate(m.effectiveEndDate) || '\u2014'}` : 'Not set'}</span>
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          )}
      </Card>

      {drawer && <AssignmentDrawer clientId={clientId} assignment={drawer.assignment} staffList={staff.data?.items ?? []} staffLoading={staff.isLoading}
        onClose={() => setDrawer(null)} onDone={() => { invalidate(); setDrawer(null); }} />}

      {messaging && <CareTeamMessageDrawer clientId={clientId}
        members={members.filter((m) => (m.status ?? 'ACTIVE') === 'ACTIVE')}
        onClose={() => setMessaging(false)} />}

      <Confirm open={!!confirmRemove} title="Remove from care team" tone="danger"
        message={confirmRemove ? `Remove ${confirmRemove.staffName} from this child's care team? This deletes the assignment.` : ''}
        confirmLabel="Remove" busy={remove.isPending} onCancel={() => setConfirmRemove(null)} onConfirm={() => remove.mutate(confirmRemove.id)} />
      <Confirm open={!!confirmEnd} title="End assignment"
        message={confirmEnd ? `End ${confirmEnd.staffName}'s assignment? The record is kept for history and payroll.` : ''}
        confirmLabel="End assignment" busy={end.isPending} onCancel={() => setConfirmEnd(null)} onConfirm={() => end.mutate(confirmEnd.id)} />
    </>
  );
}

function AssignmentDrawer({ clientId, assignment, staffList, staffLoading, onClose, onDone }) {
  const toast = useToast();
  const isEdit = Boolean(assignment);
  const [role, setRole] = useState(assignment?.role || 'BCBA');
  const [staffProfileId, setStaffProfileId] = useState(assignment?.staffProfileId || '');
  const [form, setForm] = useState({
    weeklyAssignedHours: assignment?.weeklyAssignedHours ?? '',
    effectiveStartDate: assignment?.effectiveStartDate ? String(assignment.effectiveStartDate).slice(0, 10) : '',
    effectiveEndDate: assignment?.effectiveEndDate ? String(assignment.effectiveEndDate).slice(0, 10) : '',
  });
  const [err, setErr] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // Eligibility uses canonical role data (staff.roleKeys), never the legacy
  // free-text discipline (spec Module 4 Parts 8/12/13). Multi-role staff appear
  // in every seat their roleKeys qualify for.
  const staffOpts = staffOptionsForRole(staffList, role);

  const save = useMutation({
    mutationFn: () => {
      if (isEdit) {
        const body = {};
        if (String(form.weeklyAssignedHours).trim() !== '') body.weeklyAssignedHours = Number(form.weeklyAssignedHours);
        if (form.effectiveEndDate) body.effectiveEndDate = form.effectiveEndDate;
        return updateAssignment(clientId, assignment.id, body);
      }
      const body = { staffProfileId, role, isPrimary: false };
      if (String(form.weeklyAssignedHours).trim() !== '') body.weeklyAssignedHours = Number(form.weeklyAssignedHours);
      if (form.effectiveStartDate) body.effectiveStartDate = form.effectiveStartDate;
      if (form.effectiveEndDate) body.effectiveEndDate = form.effectiveEndDate;
      return assignCareTeam(clientId, body);
    },
    onSuccess: () => { toast.push(isEdit ? 'Assignment updated.' : 'Staff assigned.'); onDone(); },
    onError: (e) => setErr(e?.response?.data?.error?.message ?? 'Could not save the assignment.'),
  });

  function submit() {
    setErr('');
    if (!isEdit && !staffProfileId) { setErr('Choose a staff member.'); return; }
    if (form.effectiveStartDate && form.effectiveEndDate && form.effectiveEndDate < form.effectiveStartDate) { setErr('The end date must be on or after the start date.'); return; }
    save.mutate();
  }

  return (
    <Modal open onClose={onClose} variant="drawer" title={isEdit ? `Edit ${assignment.role} assignment` : 'Assign staff'}
      description="Capacity and eligibility are validated on the server. Pay rate is set on the staff profile."
      footer={<><Button variant="ghost" onClick={onClose} disabled={save.isPending}>Cancel</Button><Button onClick={submit} loading={save.isPending} icon={Icon.Check}>{isEdit ? 'Save changes' : 'Confirm assignment'}</Button></>}>
      {!isEdit && (
        <>
          <Field label="Role"><Select value={role} onChange={(v) => { setRole(v); setStaffProfileId(''); }} options={ROLE_OPTS} searchable={false} /></Field>
          <Field label="Staff member" required><Select value={staffProfileId} onChange={setStaffProfileId} options={staffOpts} loading={staffLoading} placeholder={STAFF_PLACEHOLDER} emptyText="No eligible staff" /></Field>
        </>
      )}
      <Field label="Weekly assigned hours" hint="Counts toward the child's approved weekly capacity">
        <TextInput type="number" min="0" max="168" value={form.weeklyAssignedHours} onChange={set('weeklyAssignedHours')} icon={Icon.Clock} />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Field label="Start date" hint="MM/DD/YYYY"><DateInput value={form.effectiveStartDate} onChange={set('effectiveStartDate')} aria-label="Assignment start date" /></Field>
        <Field label="End date" hint="MM/DD/YYYY"><DateInput value={form.effectiveEndDate} onChange={set('effectiveEndDate')} aria-label="Assignment end date" /></Field>
      </div>
      {err && <p className="rx-formfield__err">{err}</p>}
    </Modal>
  );
}

function CareTeamMessageDrawer({ clientId, members, onClose }) {
  const toast = useToast();
  const [selected, setSelected] = useState(() => members.map((m) => m.id)); // default: all
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState(false);
  const [err, setErr] = useState('');

  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const chosen = members.filter((m) => selected.includes(m.id));

  const send = useMutation({
    mutationFn: () => messageCareTeam(clientId, {
      message: message.trim(),
      ...(subject.trim() ? { subject: subject.trim() } : {}),
      // send the assignment ids as the narrowing member list
      ...(selected.length && selected.length !== members.length ? { memberIds: selected } : {}),
    }),
    onSuccess: (res) => { toast.push(`Message sent to ${res.recipientCount} care-team member${res.recipientCount === 1 ? '' : 's'}.`); onClose(); },
    onError: (e) => setErr(e?.response?.data?.error?.message ?? 'Your message could not be sent. Please try again.'),
  });

  function submit() {
    setErr('');
    if (!message.trim()) { setErr('Enter a message.'); return; }
    if (selected.length === 0) { setErr('Select at least one recipient.'); return; }
    send.mutate();
  }

  return (
    <Modal open onClose={onClose} variant="drawer" title="Message care team"
      description="Recipients and the company sender are resolved on the server; you choose who and what to say."
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={send.isPending}>Cancel</Button>
        {preview
          ? <Button icon={Icon.Check} loading={send.isPending} onClick={submit}>Send</Button>
          : <Button icon={Icon.Arrow} onClick={() => { if (!message.trim()) { setErr('Enter a message.'); return; } setErr(''); setPreview(true); }}>Preview</Button>}
      </>}>
      {!preview ? (
        <>
          <Field label="Recipients" hint="Assigned BCBA/RBT — re-checked on the server at send time">
            <div style={{ display: 'grid', gap: 8 }}>
              {members.map((m) => (
                <label key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', border: '1px solid var(--rx-line)', borderRadius: 10, cursor: 'pointer' }}>
                  <input type="checkbox" checked={selected.includes(m.id)} onChange={() => toggle(m.id)} />
                  <span style={{ flex: 1 }}>{m.staffName || 'Staff member'}</span>
                  <Badge tone="accent">{m.role}</Badge>
                </label>
              ))}
            </div>
          </Field>
          <Field label="Subject (optional)"><TextInput value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Schedule change" /></Field>
          <Field label="Message" required><textarea className="rx-input" rows={5} value={message} onChange={(e) => setMessage(e.target.value)} style={{ width: '100%', resize: 'vertical' }} /></Field>
        </>
      ) : (
        <div className="rx-list">
          <div className="rx-alert" style={{ marginBottom: 12 }}><Icon.Bell size={18} /><span>Sent as an in-app notification and email (via the company sender) to the selected care team.</span></div>
          <div className="rx-row"><div className="rx-row__main"><div className="rx-row__meta">To</div><div className="rx-row__title">{chosen.map((m) => `${m.staffName} (${m.role})`).join(', ') || '—'}</div></div></div>
          {subject.trim() && <div className="rx-row"><div className="rx-row__main"><div className="rx-row__meta">Subject</div><div className="rx-row__title">{subject}</div></div></div>}
          <div className="rx-row"><div className="rx-row__main"><div className="rx-row__meta">Message</div><div className="rx-row__title" style={{ whiteSpace: 'pre-wrap' }}>{message}</div></div></div>
        </div>
      )}
      {err && <p className="rx-formfield__err">{err}</p>}
    </Modal>
  );
}

export default AssignmentPanel;
