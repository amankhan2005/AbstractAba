import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { createEmailTemplate, deleteEmailTemplate, listClients, listEmailTemplates, updateEmailTemplate } from '@/api/client';
import { usePermissions } from '@/auth/permissions';
import { useToast } from '@/components';
import { Button, Card, Confirm, ErrorState, Field, Icon, Modal, TextInput } from '@/ui';
import { formatDate, formatPersonName } from '@/lib/format';

/**
 * EMAIL TEMPLATES — the company's saved parent/guardian email templates.
 *
 * Persistence: /v1/email-templates (tenant-scoped; reading needs clients.update,
 * managing needs organization.update — the server enforces both). Templates use
 * only the platform's allowlisted variables; the server rejects anything else.
 * Reuse: "Use Template" opens a client's existing Send email composer with the
 * template selected, where it is previewed and sent through the existing path.
 */

export const TEMPLATE_QUERY_KEY = ['email-templates', 'saved'];
export const VARIABLE_LABELS = {
  childFirstName: 'Child first name',
  parentFirstName: 'Parent first name',
  companyName: 'Company name',
  appointmentDate: 'Appointment date',
  appointmentTime: 'Appointment time',
};
const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const LIMITS = { name: 120, subject: 300, body: 8000 };

/** Unsupported {{tokens}} in a text, mirroring the server allowlist. */
export function unsupportedTokens(text, supported) {
  const bad = new Set();
  for (const m of String(text ?? '').matchAll(TOKEN_RE)) if (!supported.includes(m[1])) bad.add(m[1]);
  return [...bad];
}

export function validateTemplate(form, supported) {
  const e = {};
  if (!form.name.trim()) e.name = 'Template name is required.';
  else if (form.name.trim().length > LIMITS.name) e.name = `Template name must be ${LIMITS.name} characters or fewer.`;
  if (!form.subject.trim()) e.subject = 'Subject is required.';
  else if (form.subject.trim().length > LIMITS.subject) e.subject = `Subject must be ${LIMITS.subject} characters or fewer.`;
  if (!form.body.trim()) e.body = 'Email content is required.';
  else if (form.body.trim().length > LIMITS.body) e.body = `Email content must be ${LIMITS.body} characters or fewer.`;
  for (const key of ['subject', 'body']) {
    const bad = unsupportedTokens(form[key], supported);
    if (bad.length && !e[key]) e[key] = `Unsupported variables: ${bad.map((v) => `{{${v}}}`).join(', ')}.`;
  }
  return e;
}

/** Text with {{variables}} rendered as readable chips (never substituted with made-up values). */
export function TokenText({ text }) {
  const parts = [];
  let last = 0;
  for (const m of String(text ?? '').matchAll(TOKEN_RE)) {
    if (m.index > last) parts.push(String(text).slice(last, m.index));
    parts.push(<span key={m.index} className="rx-et__token">{VARIABLE_LABELS[m[1]] ?? m[1]}</span>);
    last = m.index + m[0].length;
  }
  parts.push(String(text ?? '').slice(last));
  return <>{parts}</>;
}

/**
 * Delete (soft-delete on the server) a saved template: drop it from the cache at
 * once, then refetch every email-template query. Shared by this page and the
 * client Send email composer so both behave identically.
 */
export function useDeleteTemplate({ onSettled } = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (tpl) => deleteEmailTemplate(tpl.id),
    onSuccess: async (_r, tpl) => {
      qc.setQueryData(TEMPLATE_QUERY_KEY, (cur) => (cur ? { ...cur, items: cur.items.filter((t) => t.id !== tpl.id) } : cur));
      onSettled?.();
      toast.push(`“${tpl.name}” was deleted.`);
      await qc.invalidateQueries({ queryKey: ['email-templates'] });
    },
    onError: (e) => { onSettled?.(); toast.push(e?.response?.data?.error?.message ?? 'The template could not be deleted.', 'negative'); },
  });
}

export function EmailTemplatesPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { permissions } = usePermissions();
  const canManage = permissions.includes('organization.update');
  const canUse = permissions.includes('clients.update');
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState(null); // { mode: 'create' | 'edit' | 'view', template? }
  const [deleting, setDeleting] = useState(null);
  const [using, setUsing] = useState(null);

  const query = useQuery({ queryKey: TEMPLATE_QUERY_KEY, queryFn: listEmailTemplates, enabled: canUse });
  const supported = query.data?.supportedVariables ?? Object.keys(VARIABLE_LABELS);
  const items = query.data?.items ?? [];
  const term = search.trim().toLowerCase();
  const visible = useMemo(() => (term ? items.filter((t) => `${t.name} ${t.subject}`.toLowerCase().includes(term)) : items), [items, term]);

  const remove = useDeleteTemplate({ onSettled: () => setDeleting(null) });

  const duplicate = useMutation({
    mutationFn: (tpl) => createEmailTemplate({ name: copyName(tpl.name, items), subject: tpl.subject, body: tpl.body }),
    onSuccess: async (created) => { toast.push(`“${created.name}” was created.`); await qc.invalidateQueries({ queryKey: ['email-templates'] }); },
    onError: (e) => toast.push(e?.response?.data?.error?.message ?? 'The template could not be duplicated.', 'negative'),
  });

  return (
    <div className="rx-et">
      <header className="rx-et__head">
        <div>
          <h1 className="rx-et__title">Email Templates</h1>
          <p className="rx-et__subtitle">Save reusable messages for parents and guardians. Use them from any client’s Send email — the recipient and sender are always filled in securely.</p>
        </div>
        {canManage && <Button icon={Icon.Plus} onClick={() => setEditor({ mode: 'create' })}>Create Template</Button>}
      </header>

      {!canUse ? (
        <Card className="rx-et__notice"><span className="rx-st__empty-icon" aria-hidden="true"><Icon.Shield size={22} /></span>
          <div className="rx-st__empty-title">You don’t have access to email templates</div>
          <p className="rx-st__empty-body">Ask your company administrator for access.</p></Card>
      ) : (
        <>
          <div className="rx-et__toolbar">
            <label className="rx-st__search rx-et__search">
              <Icon.Search size={18} aria-hidden="true" />
              <span className="rx-st__sr">Search templates</span>
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by template name or subject" />
            </label>
            {query.isSuccess && <span className="rx-et__count">{items.length} saved template{items.length === 1 ? '' : 's'}</span>}
          </div>

          {query.isLoading ? (
            <div className="rx-et__grid" aria-busy="true" aria-label="Loading templates">{[0, 1, 2].map((i) => <div key={i} className="rx-skel rx-et__skel" />)}</div>
          ) : query.isError ? (
            <Card><ErrorState title="We couldn’t load your templates" onRetry={() => query.refetch()} /></Card>
          ) : items.length === 0 ? (
            <Card className="rx-et__empty">
              <span className="rx-et__empty-icon" aria-hidden="true"><Icon.Doc size={24} /></span>
              <div className="rx-st__empty-title">No saved templates yet</div>
              <p className="rx-st__empty-body">Create a template once and reuse it whenever you email a parent or guardian.</p>
              {canManage && <Button icon={Icon.Plus} onClick={() => setEditor({ mode: 'create' })}>Create Template</Button>}
            </Card>
          ) : visible.length === 0 ? (
            <Card className="rx-et__empty"><div className="rx-st__empty-title">No templates match “{search.trim()}”</div>
              <Button variant="ghost" onClick={() => setSearch('')}>Clear search</Button></Card>
          ) : (
            <ul className="rx-et__grid" aria-label="Saved email templates">
              {visible.map((t) => (
                <li key={t.id} className="rx-et__card">
                  <div className="rx-et__card-head">
                    <span className="rx-et__card-icon" aria-hidden="true"><Icon.Doc size={18} /></span>
                    <div className="rx-et__card-title">
                      <h2 className="rx-et__name">{t.name}</h2>
                      <div className="rx-et__dates">Updated {formatDate(t.updatedAt)} · Created {formatDate(t.createdAt)}</div>
                    </div>
                  </div>
                  <div className="rx-et__subject"><span className="rx-et__k">Subject</span><span><TokenText text={t.subject} /></span></div>
                  <p className="rx-et__excerpt"><TokenText text={t.body} /></p>
                  <div className="rx-et__actions">
                    <Button size="sm" icon={Icon.Arrow} onClick={() => setUsing(t)}>Use Template</Button>
                    {canManage ? (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setEditor({ mode: 'edit', template: t })}>Edit</Button>
                        <Button size="sm" variant="ghost" onClick={() => duplicate.mutate(t)} loading={duplicate.isPending && duplicate.variables?.id === t.id}>Duplicate</Button>
                        <Button size="sm" variant="ghost" className="rx-et__delete" onClick={() => setDeleting(t)} aria-label={`Delete ${t.name}`}><Icon.Trash size={15} /></Button>
                      </>
                    ) : <Button size="sm" variant="ghost" onClick={() => setEditor({ mode: 'view', template: t })}>View</Button>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {editor && <TemplateEditor state={editor} supported={supported} onClose={() => setEditor(null)} />}
      {using && <UseTemplateDialog template={using} onClose={() => setUsing(null)} onChoose={(clientId) => navigate(`/clients/${clientId}?compose=${encodeURIComponent(using.id)}`)} />}
      <Confirm open={Boolean(deleting)} tone="danger" title="Delete Template?" confirmLabel="Delete Template" busy={remove.isPending}
        message={deleting ? `“${deleting.name}” will be removed from your saved templates. Emails already sent are not affected.` : ''}
        onConfirm={() => deleting && remove.mutate(deleting)} onCancel={() => setDeleting(null)} />
    </div>
  );
}

/** "Copy of X", "Copy of X (2)", … — unique among the loaded templates (the server still enforces uniqueness). */
export function copyName(name, items) {
  const taken = new Set(items.map((t) => t.name.trim().toLowerCase()));
  const base = `Copy of ${name}`.slice(0, LIMITS.name);
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base.slice(0, LIMITS.name - 6)} (${i})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}

/**
 * Create / Edit / View a saved template. Exported so the client Send email
 * composer reuses the exact same editor (no second template form).
 * `state`: { mode: 'create' | 'edit' | 'view', template? } — a create may be
 * pre-filled (e.g. "Save as template" from a composed email).
 */
export function TemplateEditor({ state, supported = Object.keys(VARIABLE_LABELS), onClose, onSaved }) {
  const qc = useQueryClient();
  const toast = useToast();
  const readOnly = state.mode === 'view';
  const initial = { name: '', subject: '', body: '', ...(state.template ?? {}) };
  const baseline = state.mode === 'create' ? { name: '', subject: '', body: '' } : initial;
  const [form, setForm] = useState({ name: initial.name ?? '', subject: initial.subject ?? '', body: initial.body ?? '' });
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const bodyRef = useRef(null);
  const [lastField, setLastField] = useState('body');
  const dirty = form.name !== baseline.name || form.subject !== baseline.subject || form.body !== baseline.body;

  const set = (key) => (e) => { setForm((f) => ({ ...f, [key]: e.target.value })); setErrors((cur) => ({ ...cur, [key]: undefined })); };

  const save = useMutation({
    mutationFn: () => {
      const body = { name: form.name.trim(), subject: form.subject.trim(), body: form.body.trim() };
      if (state.mode === 'create') return createEmailTemplate(body);
      const changed = Object.fromEntries(Object.entries(body).filter(([k, v]) => v !== String(initial[k] ?? '').trim()));
      return Object.keys(changed).length ? updateEmailTemplate(initial.id, changed, initial.version) : Promise.resolve(initial);
    },
    onSuccess: async (saved) => {
      // Reflect the saved template immediately, then refetch every template query.
      qc.setQueryData(TEMPLATE_QUERY_KEY, (cur) => {
        if (!cur || !saved?.id) return cur;
        const rest = cur.items.filter((t) => t.id !== saved.id);
        return { ...cur, items: [saved, ...rest] };
      });
      toast.push(state.mode === 'create' ? `“${saved.name}” was saved.` : 'Template changes were saved.');
      await qc.invalidateQueries({ queryKey: ['email-templates'] });
      onSaved?.(saved);
      onClose();
    },
    onError: (err) => {
      const status = err?.response?.status;
      const e = err?.response?.data?.error ?? {};
      if (status === 409 && e.code === 'EMAIL_TEMPLATE_NAME_EXISTS') { setErrors({ name: e.message }); setBanner(null); return; }
      if (status === 409 && e.code === 'VERSION_CONFLICT') { setBanner('This template was changed by someone else. Close and reopen it to see the latest version.'); return; }
      if (status === 422 && e.code === 'EMAIL_UNSUPPORTED_VARIABLE') { setErrors({ body: e.message }); setBanner(null); return; }
      if (status === 422 && e.details?.fieldErrors) {
        setErrors(Object.fromEntries(Object.entries(e.details.fieldErrors).map(([k, v]) => [k, v?.[0]])));
        setBanner('Please correct the highlighted fields.');
        return;
      }
      setBanner(typeof e.message === 'string' && !/^[A-Z_]+-?\d*$/.test(e.message) ? e.message : 'The template could not be saved. Please try again.');
    },
  });

  function submit() {
    const found = validateTemplate(form, supported);
    setErrors(found);
    setBanner(Object.keys(found).length ? 'Please correct the highlighted fields.' : null);
    if (!Object.keys(found).length) save.mutate();
  }

  function insertVariable(v) {
    const token = `{{${v}}}`;
    const key = lastField === 'subject' ? 'subject' : 'body';
    const el = key === 'subject' ? document.getElementById('et-subject') : bodyRef.current;
    setForm((f) => {
      const start = el?.selectionStart ?? f[key].length;
      const end = el?.selectionEnd ?? f[key].length;
      return { ...f, [key]: f[key].slice(0, start) + token + f[key].slice(end) };
    });
    setErrors((cur) => ({ ...cur, [key]: undefined }));
  }

  function requestClose() {
    if (dirty && !readOnly && !save.isSuccess) { setConfirmDiscard(true); return; }
    onClose();
  }

  const title = state.mode === 'create' ? 'Create Template' : state.mode === 'edit' ? 'Edit Template' : initial.name;
  const usedVars = [...new Set([...`${form.subject} ${form.body}`.matchAll(TOKEN_RE)].map((m) => m[1]))];

  return (
    <>
      <Modal open onClose={confirmDiscard ? undefined : requestClose} variant="drawer" size="xl" title={title}
        description={readOnly ? 'Saved template (read-only).' : 'Write once, reuse for any client. Variables are filled in with each client’s details when the email is previewed and sent.'}
        footer={readOnly ? <Button variant="ghost" onClick={onClose}>Close</Button> : (
          <>
            <span className="rx-et__foot-note">{dirty ? 'Unsaved changes' : state.mode === 'edit' ? 'No changes yet' : ''}</span>
            <Button variant="ghost" onClick={requestClose} disabled={save.isPending}>Cancel</Button>
            <Button icon={Icon.Check} loading={save.isPending} onClick={submit}>Save Template</Button>
          </>
        )}>
        <div className="rx-et__editor">
          <div className="rx-et__editor-form">
            {banner && <div className="rx-sf__banner" role="alert"><Icon.Bell size={16} aria-hidden="true" />{banner}</div>}
            <Field label="Template Name" htmlFor="et-name" required={!readOnly} error={errors.name} hint={readOnly ? undefined : 'Only your team sees this name.'}>
              <TextInput id="et-name" value={form.name} onChange={set('name')} readOnly={readOnly} maxLength={LIMITS.name} error={errors.name} aria-invalid={Boolean(errors.name)} placeholder="For example: Session reminder" />
            </Field>
            <Field label="Subject" htmlFor="et-subject" required={!readOnly} error={errors.subject} hint={readOnly ? undefined : `${form.subject.length} / ${LIMITS.subject} characters`}>
              <TextInput id="et-subject" value={form.subject} onChange={set('subject')} onFocus={() => setLastField('subject')} readOnly={readOnly} maxLength={LIMITS.subject} error={errors.subject} aria-invalid={Boolean(errors.subject)} placeholder="For example: Upcoming session for {{childFirstName}}" />
            </Field>
            {!readOnly && (
              <div className="rx-et__vars" role="group" aria-label="Insert a variable">
                <div className="rx-et__vars-label"><Icon.Sparkle size={14} aria-hidden="true" /> Insert a variable into the {lastField === 'subject' ? 'subject' : 'email content'}</div>
                <div className="rx-et__vars-list">
                  {supported.map((v) => (
                    <button key={v} type="button" className={`rx-et__var${usedVars.includes(v) ? ' rx-et__var--used' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => insertVariable(v)}>
                      <Icon.Plus size={12} aria-hidden="true" />{VARIABLE_LABELS[v] ?? v}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <Field label="Email Content" htmlFor="et-body" required={!readOnly} error={errors.body} hint={`${form.body.length.toLocaleString()} / ${LIMITS.body.toLocaleString()} characters`}>
              <textarea id="et-body" ref={bodyRef} className={`rx-et__textarea${errors.body ? ' rx-input--error' : ''}`} rows={14} value={form.body}
                onChange={set('body')} onFocus={() => setLastField('body')} readOnly={readOnly} maxLength={LIMITS.body} aria-invalid={Boolean(errors.body)}
                placeholder={'Hello {{parentFirstName}},\n\nWrite your message here…'} />
            </Field>
          </div>
          <section className="rx-et__preview" aria-label="Template preview">
            <div className="rx-et__preview-head">Preview <span>Variables are shown by name</span></div>
            <div className="rx-et__mail">
              <div className="rx-et__mail-from">
                <span className="rx-et__mail-avatar" aria-hidden="true"><Icon.Building size={15} /></span>
                <span><strong>Your company</strong><small>To: parent or guardian on file</small></span>
              </div>
              <div className="rx-et__preview-subject"><TokenText text={form.subject || 'Subject'} /></div>
              <div className="rx-et__preview-body"><TokenText text={form.body || 'Email content'} /></div>
            </div>
          </section>
        </div>
      </Modal>
      <Confirm open={confirmDiscard} tone="danger" title="Discard changes?" message="Your changes to this template have not been saved."
        confirmLabel="Discard" onConfirm={() => { setConfirmDiscard(false); onClose(); }} onCancel={() => setConfirmDiscard(false)} />
    </>
  );
}

function UseTemplateDialog({ template, onClose, onChoose }) {
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => { const id = setTimeout(() => setTerm(search.trim()), 300); return () => clearTimeout(id); }, [search]);
  const clients = useQuery({ queryKey: ['clients', 'use-template', term], queryFn: () => listClients({ limit: 20, ...(term ? { search: term } : {}) }) });
  const rows = clients.data?.items ?? [];
  return (
    <Modal open onClose={onClose} size="md" title="Use Template" description={`Choose the client to email with “${template.name}”. You can review and edit the message before sending.`}
      footer={<Button variant="ghost" onClick={onClose}>Cancel</Button>}>
      <label className="rx-st__search">
        <Icon.Search size={18} aria-hidden="true" />
        <span className="rx-st__sr">Search clients</span>
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or client number" autoFocus />
      </label>
      <ul className="rx-et__clients" aria-label="Clients">
        {clients.isLoading ? <li className="rx-et__muted">Loading clients…</li>
          : clients.isError ? <li className="rx-et__muted">Clients couldn’t be loaded.</li>
            : rows.length === 0 ? <li className="rx-et__muted">No clients found.</li>
              : rows.map((c) => (
                <li key={c.id}>
                  <button type="button" className="rx-et__client" onClick={() => onChoose(c.id)}>
                    <span className="rx-et__client-name">{formatPersonName([c.firstName, c.lastName].filter(Boolean).join(' ')) || 'Client'}</span>
                    <span className="rx-et__muted">{c.clientNumber}</span>
                    <Icon.Arrow size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
      </ul>
    </Modal>
  );
}

export default EmailTemplatesPage;
