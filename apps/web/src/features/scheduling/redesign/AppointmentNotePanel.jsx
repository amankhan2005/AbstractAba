import { useId, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getAppointmentNote, saveAppointmentNote, deleteAppointmentNote, listClients } from '@/api/client';
import { Button, Icon, Select, Confirm } from '@/ui';
import { useAuthStore, useOrgTimezone } from '@/auth/store';
import { useBusinessDate } from '@/lib/useBusinessDate';
import { formatFullName } from '@/lib/format';

/** An RBT with no BCBA/admin role never sees Appointment Notes (the server also refuses). */
export function isRbtOnlyPrincipal(roles = []) {
  return roles.includes('rbt') && !roles.some((r) => ['bcba', 'org_admin', 'owner'].includes(r));
}

/**
 * APPOINTMENT NOTE — the BCBA's note for an appointment on the CURRENT business
 * date. The server resolves the date (organization timezone) and returns only
 * today's note; this component never sends or chooses a date.
 *
 * Renders, in order of precedence:
 *   RBT-only user            nothing, and no request is made
 *   no current-day note      BCBA: an "Add appointment note" action only
 *                            reader: nothing (or `missingFallback`)
 *   a current-day note       the note content, with its own selected client
 *                            when one was chosen, and Edit for the BCBA
 *   creating / editing       a simple editor: the note text, then
 *                            Client (Optional), then Cancel + Add Note —
 *                            or, when editing, Cancel + Save Changes + Delete
 *
 * The client is the NOTE's optional field: it starts EMPTY when creating, is
 * the note's saved client when editing, and is never taken from the
 * appointment.
 */
export function AppointmentNotePanel({ appointmentId, missingFallback = null }) {
  const roles = useAuthStore((s) => s.principal?.roles) ?? [];
  const rbtOnly = isRbtOnlyPrincipal(roles);
  const qc = useQueryClient();
  const formId = useId();
  const [mode, setMode] = useState('view'); // 'view' | 'create' | 'edit'
  const [text, setText] = useState('');
  const [clientId, setClientId] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Cache per CURRENT business date (org timezone): at midnight the key
  // changes (even on a screen left open), so yesterday's note is never served
  // as today's. The server still resolves the date itself.
  const businessDate = useBusinessDate(useOrgTimezone());
  const key = ['appointment-note', appointmentId, businessDate];
  const note = useQuery({
    queryKey: key,
    queryFn: () => getAppointmentNote(appointmentId),
    enabled: Boolean(appointmentId) && !rbtOnly,
    retry: false,
  });
  const clients = useQuery({
    queryKey: ['clients', 'opts'],
    queryFn: () => listClients({}),
    enabled: !rbtOnly && mode !== 'view',
  });

  const data = note.data;
  const refreshOverview = () => qc.invalidateQueries({ queryKey: ['appointment-notes-overview'] });

  const save = useMutation({
    mutationFn: () => saveAppointmentNote(appointmentId, { note: text, clientId: clientId || null }),
    onSuccess: (saved) => {
      qc.setQueryData(['appointment-note', appointmentId, saved?.businessDate ?? businessDate], saved);
      refreshOverview();
      setMode('view');
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteAppointmentNote(appointmentId),
    onSuccess: async () => { setConfirmDelete(false); setMode('view'); await note.refetch(); refreshOverview(); },
  });

  const clientOptions = useMemo(() => {
    const opts = (clients.data?.items ?? []).map((c) => ({ value: c.id, label: formatFullName(c) || 'Client' }));
    // When editing, the note's OWN saved client stays selectable. Nothing else
    // (in particular not the appointment's client) is injected.
    if (mode === 'edit' && data?.clientId && data?.clientName && !opts.some((o) => o.value === data.clientId)) {
      opts.unshift({ value: data.clientId, label: data.clientName });
    }
    return opts;
  }, [clients.data, data, mode]);

  if (rbtOnly || !appointmentId || note.isLoading || note.isError || !data) return null;

  const canEdit = data.canEdit === true;
  const startCreate = () => { save.reset(); setText(''); setClientId(''); setMode('create'); };
  const startEdit = () => { save.reset(); setText(data.note ?? ''); setClientId(data.clientId ?? ''); setMode('edit'); };
  const cancel = () => { save.reset(); setMode('view'); };

  if (mode === 'view') {
    if (!data.exists) {
      if (!canEdit) return missingFallback;
      return (
        <div className="rx-apptnote-add">
          <Button variant="ghost" icon={Icon.Plus} onClick={startCreate}>Add appointment note</Button>
        </div>
      );
    }
    return (
      <section className="rx-apptnote" aria-label="Appointment Note">
        <header className="rx-apptnote__head">
          <div className="rx-apptnote__heading">
            <span className="rx-apptnote__icon" aria-hidden="true"><Icon.Clipboard size={16} /></span>
            <h3 className="rx-apptnote__title">Appointment Note</h3>
          </div>
          {canEdit && <Button variant="ghost" onClick={startEdit}>Edit</Button>}
        </header>
        {data.clientName && (
          <div className="rx-apptnote__client"><span className="rx-apptnote__client-k">Client</span><span className="rx-apptnote__client-v">{data.clientName}</span></div>
        )}
        <div className="rx-apptnote__content">
          <div className="rx-apptnote__body">{data.note}</div>
        </div>
      </section>
    );
  }

  const editing = mode === 'edit';
  const canSave = text.trim() !== '' && (!editing || text !== (data.note ?? '') || clientId !== (data.clientId ?? ''));

  return (
    <section className="rx-apptnote" aria-label="Appointment Note">
      <header className="rx-apptnote__head">
        <div className="rx-apptnote__heading">
          <span className="rx-apptnote__icon" aria-hidden="true"><Icon.Clipboard size={16} /></span>
          <h3 className="rx-apptnote__title">Appointment Note</h3>
        </div>
      </header>
      <div className="rx-apptnote__content">
        <div className="rx-apptnote__editor">
          <textarea
            id={`${formId}-note`}
            className="rx-apptnote__textarea"
            rows={6}
            value={text}
            aria-label="Appointment note"
            placeholder="Write the appointment note..."
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
          <div className="rx-apptnote__field">
            <div className="rx-apptnote__label" id={`${formId}-client`}>Client <span className="rx-apptnote__optional">(Optional)</span></div>
            {/* portal: the note card clips its children (rounded corners), so the
                menu renders in <body>, aligned to this field, flipping above it
                near the bottom of the screen and following scroll/resize. */}
            <Select
              portal
              value={clientId}
              onChange={(v) => setClientId(v || '')}
              options={clientOptions}
              placeholder="Select client"
              loading={clients.isLoading}
              clearable
              emptyText="No clients found"
            />
          </div>
          {(save.isError || remove.isError) && (
            <div className="rx-apptnote__error" role="alert">
              {(save.error || remove.error)?.response?.data?.error?.message || 'The note could not be saved. Please try again.'}
            </div>
          )}
          <div className="rx-apptnote__actions">
            <Button variant="ghost" onClick={cancel} disabled={save.isPending || remove.isPending}>Cancel</Button>
            <Button icon={Icon.Check} onClick={() => save.mutate()} loading={save.isPending} disabled={!canSave}>
              {editing ? 'Save Changes' : 'Add Note'}
            </Button>
            {editing && (
              <Button variant="ghost" className="rx-apptnote__delete" icon={Icon.Trash} onClick={() => setConfirmDelete(true)} disabled={save.isPending}>Delete</Button>
            )}
          </div>
        </div>
      </div>
      <Confirm
        open={confirmDelete}
        title="Delete appointment note?"
        message="This note will be removed."
        confirmLabel="Delete"
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setConfirmDelete(false)}
      />
    </section>
  );
}

export default AppointmentNotePanel;
