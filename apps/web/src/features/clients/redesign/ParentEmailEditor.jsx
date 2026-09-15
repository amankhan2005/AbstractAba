import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { fetchParentEmailTemplates, listEmailTemplates, previewParentEmail, sendParentEmail } from '@/api/client';
import { usePermissions } from '@/auth/permissions';
import { useToast } from '@/components';
import { Button, Icon, Modal, Confirm, Field, TextInput, Spinner, ErrorState } from '@/ui';
import { formatDate } from '@/lib/format';
import { TEMPLATE_QUERY_KEY, TemplateEditor, TokenText, VARIABLE_LABELS, useDeleteTemplate } from '@/features/email-templates/EmailTemplatesPage.jsx';
import { EmailComposerFullscreen } from './EmailComposerFullscreen.jsx';
import { buildEmailPayload } from './emailPayload.js';

const STEPS = [
  { id: 'pick', label: 'Choose template' },
  { id: 'edit', label: 'Write' },
  { id: 'confirm', label: 'Review & send' },
];
const BODY_LIMIT = 8000;

/**
 * Send a parent/guardian email from the child dashboard.
 *
 *   1. Choose — the company's SAVED templates (/v1/email-templates) and the
 *      platform's built-in templates. Managers (organization.update) can create,
 *      edit and delete saved templates right here, using the same editor and API
 *      as Settings → Email Templates (no second template system).
 *   2. Write  — edit the subject/message for this send, with a live preview
 *      rendered by the server; "Save as template" keeps it for reuse.
 *   3. Review & send — recipient and sender are resolved on the server.
 *
 * Only { templateId, subject, body } is ever sent (buildEmailPayload). "Expand"
 * opens the full-page split composer; switching keeps subject/body/preview.
 */
export function ParentEmailEditor({ clientId, onClose, initialTemplateId = null }) {
  const toast = useToast();
  const { permissions } = usePermissions();
  const canManage = permissions.includes('organization.update');
  const templates = useQuery({ queryKey: ['email-templates', clientId], queryFn: () => fetchParentEmailTemplates(clientId) });
  // The company's saved templates — sent through the same preview/send contract.
  const saved = useQuery({ queryKey: TEMPLATE_QUERY_KEY, queryFn: listEmailTemplates, retry: false });
  const savedTemplates = (saved.data?.items ?? []).map((t) => ({ ...t, saved: true, supportedVariables: saved.data?.supportedVariables ?? [] }));
  const builtIn = templates.data ?? [];
  const [templateId, setTemplateId] = useState(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [step, setStep] = useState('pick'); // pick | edit | confirm
  const [expanded, setExpanded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [search, setSearch] = useState('');
  const [templateEditor, setTemplateEditor] = useState(null); // { mode, template? }
  const [deleting, setDeleting] = useState(null);
  const bodyRef = useRef(null);
  const remove = useDeleteTemplate({ onSettled: () => setDeleting(null) });

  const allTemplates = [...savedTemplates, ...builtIn];
  const chosen = allTemplates.find((t) => t.id === templateId) ?? null;
  const variables = chosen?.supportedVariables ?? saved.data?.supportedVariables ?? [];

  // Live preview from the backend (debounced), so it matches the real send.
  const preview = useMutation({ mutationFn: () => previewParentEmail(clientId, buildEmailPayload({ templateId, subject, body })) });
  useEffect(() => {
    if ((step !== 'edit' && !expanded) || !templateId) return;
    const h = setTimeout(() => preview.mutate(), 350);
    return () => clearTimeout(h);
  }, [subject, body, templateId, step, expanded]); // eslint-disable-line

  const send = useMutation({
    mutationFn: () => sendParentEmail(clientId, buildEmailPayload({ templateId, subject, body })),
    onSuccess: (res) => { toast.push(res.status === 'SENT' ? 'Email sent.' : 'Email could not be delivered.', res.status === 'SENT' ? 'positive' : 'negative'); if (res.status === 'SENT') onClose(); },
    onError: (e) => toast.push(e?.response?.data?.error?.message ?? 'Your message could not be sent. Please try again.', 'negative'),
  });

  function openTemplate(t) {
    setTemplateId(t.id); setSubject(t.subject); setBody(t.body); setStep('edit'); setDirty(false);
  }
  // "Use Template" from Email Templates: open the chosen saved template directly.
  const [autoOpened, setAutoOpened] = useState(false);
  useEffect(() => {
    if (!initialTemplateId || autoOpened) return;
    const match = allTemplates.find((t) => t.id === initialTemplateId);
    if (match) { setAutoOpened(true); openTemplate(match); }
    else if (saved.isFetched && templates.isFetched) setAutoOpened(true);
  }, [initialTemplateId, autoOpened, saved.isFetched, templates.isFetched, savedTemplates.length]); // eslint-disable-line

  // Insert at the caret in the message (end of text when it has no focus yet).
  function insertVar(v) {
    const token = `{{${v}}}`;
    const el = bodyRef.current;
    setBody((b) => {
      const start = el && document.activeElement === el ? el.selectionStart : b.length;
      const end = el && document.activeElement === el ? el.selectionEnd : b.length;
      return b.slice(0, start) + token + b.slice(end);
    });
    setDirty(true);
  }
  function changeSubject(v) { setSubject(v); setDirty(true); }
  function changeBody(v) { setBody(v); setDirty(true); }

  // Closing the whole editor: guard unsaved edits (unless the send succeeded).
  function requestClose() {
    if (dirty && !send.isSuccess) { setConfirmDiscard(true); return; }
    onClose();
  }
  // Leaving full-screen back to the drawer keeps state — no data loss, no guard.
  function collapse() { setExpanded(false); setStep('edit'); }

  const term = search.trim().toLowerCase();
  const matches = (t) => !term || `${t.name} ${t.subject ?? ''} ${t.description ?? ''} ${t.category ?? ''}`.toLowerCase().includes(term);
  const visibleSaved = useMemo(() => savedTemplates.filter(matches), [saved.data, term]); // eslint-disable-line
  const visibleBuiltIn = useMemo(() => builtIn.filter(matches), [templates.data, term]); // eslint-disable-line

  const d = preview.data;
  const canSend = Boolean(subject.trim() && body.trim());
  const nestedOpen = Boolean(templateEditor || deleting || confirmDiscard);

  const discardDialog = confirmDiscard && (
    <Confirm open title="Discard this draft?" message="Your edits to this email haven't been sent. Discard them?" confirmLabel="Discard" tone="danger"
      onConfirm={() => { setConfirmDiscard(false); onClose(); }} onCancel={() => setConfirmDiscard(false)} />
  );

  // ---- FULL-SCREEN split composer -----------------------------------------
  if (expanded) {
    return (
      <>
        <EmailComposerFullscreen
          templateName={chosen?.name}
          subject={subject}
          body={body}
          variables={variables}
          preview={preview}
          sending={send.isPending}
          canSend={canSend}
          onSubjectChange={changeSubject}
          onBodyChange={changeBody}
          onInsertVar={insertVar}
          onSend={() => send.mutate()}
          onBack={collapse}
          onClose={requestClose}
        />
        {discardDialog}
      </>
    );
  }

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const recipientText = d ? (d.recipient?.available ? `${d.recipient.name || 'Guardian'} <${d.recipient.email}>` : 'Guardian email not available') : null;

  return (
    <>
      <Modal open onClose={nestedOpen ? undefined : requestClose} variant="drawer" size="xl"
        title={step === 'pick' ? 'Send email' : chosen?.name || 'Compose email'}
        description={step === 'pick' ? 'Choose a template to start. You can edit the message before it is sent.' : 'Recipient and sender are filled in securely by the server.'}
        footer={step === 'pick' ? <Button variant="ghost" onClick={requestClose}>Cancel</Button> : (
          <>
            <Button variant="ghost" icon={Icon.Return} onClick={() => setStep(step === 'confirm' ? 'edit' : 'pick')} disabled={send.isPending}>Back</Button>
            {step === 'edit'
              ? <Button icon={Icon.Arrow} onClick={() => setStep('confirm')} disabled={!canSend}>Review &amp; send</Button>
              : <Button icon={Icon.Check} loading={send.isPending} onClick={() => send.mutate()}>Send email</Button>}
          </>
        )}>
        <ol className="rx-pe__steps" aria-label="Progress">
          {STEPS.map((s, i) => (
            <li key={s.id} className={`rx-pe__step rx-pe__step--${i < stepIndex ? 'done' : i === stepIndex ? 'current' : 'todo'}`} aria-current={i === stepIndex ? 'step' : undefined}>
              <span className="rx-pe__step-dot" aria-hidden="true">{i < stepIndex ? <Icon.Check size={12} /> : i + 1}</span>{s.label}
            </li>
          ))}
        </ol>

        {step === 'pick' && (
          <div className="rx-pe__library">
            <div className="rx-pe__toolbar">
              <label className="rx-st__search rx-pe__search">
                <Icon.Search size={18} aria-hidden="true" />
                <span className="rx-st__sr">Search templates</span>
                <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search templates" />
              </label>
              {canManage && <Button size="sm" icon={Icon.Plus} onClick={() => setTemplateEditor({ mode: 'create' })}>Create Template</Button>}
            </div>

            {templates.isLoading || saved.isLoading ? (
              <div className="rx-pe__list" aria-busy="true" aria-label="Loading templates">{[0, 1, 2, 3].map((i) => <div key={i} className="rx-skel rx-pe__skel" />)}</div>
            ) : templates.isError ? (
              <ErrorState title="We couldn’t load the templates" onRetry={() => templates.refetch()} />
            ) : (
              <>
                <section className="rx-pe__group" aria-label="Saved templates">
                  <div className="rx-pe__group-head">
                    <h3 className="rx-pe__group-title">Saved templates <span className="rx-pe__count">{savedTemplates.length}</span></h3>
                    <Link className="rx-pe__manage" to="/settings/email-templates">Manage templates <Icon.Arrow size={13} aria-hidden="true" /></Link>
                  </div>
                  {saved.isError ? (
                    <div className="rx-pe__note">Saved templates couldn’t be loaded. <button type="button" className="rx-pe__linkbtn" onClick={() => saved.refetch()}>Try again</button></div>
                  ) : savedTemplates.length === 0 ? (
                    <div className="rx-pe__empty">
                      <span className="rx-pe__empty-icon" aria-hidden="true"><Icon.Doc size={20} /></span>
                      <div><strong>No saved templates yet</strong><p>{canManage ? 'Create one to reuse it whenever you email a parent or guardian.' : 'Your company administrator can create reusable templates.'}</p></div>
                      {canManage && <Button size="sm" variant="subtle" icon={Icon.Plus} onClick={() => setTemplateEditor({ mode: 'create' })}>Create Template</Button>}
                    </div>
                  ) : visibleSaved.length === 0 ? (
                    <div className="rx-pe__note">No saved templates match “{search.trim()}”.</div>
                  ) : (
                    <ul className="rx-pe__list">
                      {visibleSaved.map((t) => (
                        <TemplateOption key={t.id} t={t} tone="violet" description={<TokenText text={t.subject} />}
                          meta={t.updatedAt ? `Updated ${formatDate(t.updatedAt)}` : null} onOpen={openTemplate}
                          onEdit={canManage ? () => setTemplateEditor({ mode: 'edit', template: t }) : null}
                          onDelete={canManage ? () => setDeleting(t) : null} />
                      ))}
                    </ul>
                  )}
                </section>

                <section className="rx-pe__group" aria-label="Built-in templates">
                  <div className="rx-pe__group-head">
                    <h3 className="rx-pe__group-title">Built-in templates <span className="rx-pe__count">{builtIn.length}</span></h3>
                  </div>
                  {visibleBuiltIn.length === 0 ? (
                    <div className="rx-pe__note">{builtIn.length === 0 ? 'No built-in templates are available.' : `No built-in templates match “${search.trim()}”.`}</div>
                  ) : (
                    <ul className="rx-pe__list">
                      {visibleBuiltIn.map((t) => <TemplateOption key={t.id} t={t} tag={t.category} tone="blue" description={t.description} onOpen={openTemplate} />)}
                    </ul>
                  )}
                </section>
              </>
            )}
          </div>
        )}

        {step === 'edit' && (
          <div className="rx-pe__compose">
            <div className="rx-pe__compose-form">
              <div className="rx-pe__compose-tools">
                {chosen?.saved ? <span className="rx-pe__tag rx-pe__tag--violet">Saved template</span> : chosen ? <span className="rx-pe__tag rx-pe__tag--blue">Built-in template</span> : null}
                <span className="rx-pe__spacer" />
                {canManage && (
                  <Button variant="ghost" size="sm" icon={Icon.Doc} disabled={!canSend}
                    onClick={() => setTemplateEditor({ mode: 'create', template: { name: '', subject, body } })}>Save as template</Button>
                )}
                <Button variant="ghost" size="sm" icon={Icon.Maximize} onClick={() => setExpanded(true)}>Expand</Button>
              </div>
              <Field label="Subject" required><TextInput value={subject} maxLength={300} onChange={(e) => changeSubject(e.target.value)} /></Field>
              {variables.length > 0 && (
                <div className="rx-et__vars" role="group" aria-label="Insert a variable">
                  <div className="rx-et__vars-label"><Icon.Sparkle size={14} aria-hidden="true" /> Insert a variable into the message</div>
                  <div className="rx-et__vars-list">
                    {variables.map((v) => (
                      <button key={v} type="button" className="rx-et__var" onMouseDown={(e) => e.preventDefault()} onClick={() => insertVar(v)}>
                        <Icon.Plus size={12} aria-hidden="true" />{VARIABLE_LABELS[v] ?? v}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <Field label="Message" required hint={`${body.length.toLocaleString()} / ${BODY_LIMIT.toLocaleString()} characters`}>
                <textarea ref={bodyRef} className="rx-et__textarea" rows={12} maxLength={BODY_LIMIT} value={body} onChange={(e) => changeBody(e.target.value)} />
              </Field>
            </div>
            <aside className="rx-pe__preview" aria-label="Live preview">
              <div className="rx-et__preview-head">Live preview <span>Rendered by the server</span></div>
              <div className="rx-et__mail">
                {preview.isPending && !d ? <div className="rx-pe__preview-state"><Spinner /></div> : preview.isError ? (
                  <p className="rx-formfield__err rx-pe__preview-state">{preview.error?.response?.data?.error?.message ?? 'Preview unavailable.'}</p>
                ) : d ? (
                  <>
                    <div className="rx-et__mail-from">
                      <span className="rx-et__mail-avatar" aria-hidden="true"><Icon.Building size={15} /></span>
                      <span><strong>{d.sender?.name}</strong><small className={d.recipient?.available ? undefined : 'rx-pe__warn'}>To: {recipientText}</small></span>
                    </div>
                    <div className="rx-et__preview-subject">{d.subject}</div>
                    <div className="rx-et__preview-body">{d.bodyText}</div>
                    {d.unavailableVariables?.length > 0 && (
                      <p className="rx-pe__unavailable">Not available for this client: {d.unavailableVariables.map((v) => VARIABLE_LABELS[v] ?? v).join(', ')} (shown as “Not available”)</p>
                    )}
                  </>
                ) : <p className="rx-pe__preview-state rx-row__meta">Start typing to preview.</p>}
              </div>
            </aside>
          </div>
        )}

        {step === 'confirm' && (
          <div className="rx-pe__review">
            <div className="rx-pe__review-banner"><Icon.Shield size={18} aria-hidden="true" /><span>Recipient and sender are resolved on the server. Check the message before sending.</span></div>
            {d ? (
              <div className="rx-et__mail rx-pe__review-mail">
                <dl className="rx-pe__review-rows">
                  <div><dt>To</dt><dd className={d.recipient?.available ? undefined : 'rx-pe__warn'}>{recipientText}</dd></div>
                  <div><dt>From</dt><dd>{d.sender?.name} (company sender)</dd></div>
                  <div><dt>Subject</dt><dd>{d.subject}</dd></div>
                </dl>
                <div className="rx-et__preview-body">{d.bodyText}</div>
              </div>
            ) : <Spinner />}
          </div>
        )}
      </Modal>

      {templateEditor && (
        <TemplateEditor state={templateEditor} supported={saved.data?.supportedVariables ?? Object.keys(VARIABLE_LABELS)}
          onClose={() => setTemplateEditor(null)}
          onSaved={(tpl) => {
            // Editing the template currently being composed refreshes the draft only when it has no edits of its own.
            if (tpl?.id && tpl.id === templateId && !dirty) { setSubject(tpl.subject); setBody(tpl.body); }
          }} />
      )}
      <Confirm open={Boolean(deleting)} tone="danger" title="Delete Template?" confirmLabel="Delete Template" busy={remove.isPending}
        message={deleting ? `“${deleting.name}” will be removed from your saved templates. Emails already sent are not affected.` : ''}
        onConfirm={() => deleting && remove.mutate(deleting)} onCancel={() => setDeleting(null)} />
      {discardDialog}
    </>
  );
}

function TemplateOption({ t, tag, tone, description, meta, onOpen, onEdit, onDelete }) {
  return (
    <li className={`rx-pe__option rx-pe__option--${tone}`}>
      <button type="button" className="rx-pe__option-main" onClick={() => onOpen(t)}>
        <span className="rx-pe__option-icon" aria-hidden="true"><Icon.Doc size={17} /></span>
        <span className="rx-pe__option-text">
          <span className="rx-pe__option-name">{t.name}</span>
          {description && <span className="rx-pe__option-desc">{description}</span>}
          {meta && <span className="rx-pe__option-meta">{meta}</span>}
        </span>
        {tag && <span className={`rx-pe__tag rx-pe__tag--${tone}`}>{tag}</span>}
        <span className="rx-pe__option-use">Use <Icon.Arrow size={14} aria-hidden="true" /></span>
      </button>
      {(onEdit || onDelete) && (
        <span className="rx-pe__option-actions">
          {onEdit && <button type="button" className="rx-pe__icon-btn" onClick={onEdit} aria-label={`Edit ${t.name}`}><Icon.Clipboard size={15} /></button>}
          {onDelete && <button type="button" className="rx-pe__icon-btn rx-pe__icon-btn--danger" onClick={onDelete} aria-label={`Delete ${t.name}`}><Icon.Trash size={15} /></button>}
        </span>
      )}
    </li>
  );
}

export default ParentEmailEditor;
