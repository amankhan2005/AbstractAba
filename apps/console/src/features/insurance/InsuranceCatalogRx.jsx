import { useMemo, useState } from 'react';
import {
  useInsuranceCatalog,
  useCreateInsuranceCatalog,
  useUpdateInsuranceCatalog,
  useDeleteInsuranceCatalog,
  useUploadInsuranceCatalogLogo,
} from '@/api/queries';
import { US_STATES, usStateName } from '@aba1on1/schemas';
import {
  LoadingState, ErrorState, EmptyState, Modal, ConfirmDialog, useToast, PageHeader, Card, StatCard,
  Badge, Avatar, Icon, SearchInput, FilterTabs, Pagination, Field,
} from '@/components';
import { formatDate } from '@/lib/format';

/**
 * Insurance master catalog (spec Module 5.1-5.6) — the Super Admin surface.
 * Curate the state-specific global insurance companies that companies pick from
 * when recording client coverage: name, the US states an insurer is available
 * in (full names, from the ONE canonical source in @aba1on1/schemas), a logo,
 * and an active flag. Logos upload through the platform endpoint; states are
 * multi-select. Delete is soft (a coverage record may reference an entry).
 */
const BLANK = { name: '', states: [], logoUrl: '', active: true, notes: '' };
const PAGE_SIZE = 15;
const STATE_PREVIEW = 3;
const STATUS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'inactive', label: 'Inactive' },
];

function StatesCell({ states }) {
  const list = (states || []).map(usStateName);
  if (list.length === 0) return <span className="rxc-muted">No states selected</span>;
  const extra = list.length - STATE_PREVIEW;
  return (
    <span title={list.join(', ')}>
      {list.slice(0, STATE_PREVIEW).join(', ')}
      {extra > 0 ? <span className="rxc-chip rxc-chip--more" style={{ marginLeft: 6 }}>+{extra} more</span> : null}
    </span>
  );
}

export function InsuranceCatalogRx() {
  const { data, isLoading, isError, refetch } = useInsuranceCatalog();
  const create = useCreateInsuranceCatalog();
  const update = useUpdateInsuranceCatalog();
  const remove = useDeleteInsuranceCatalog();
  const uploadLogo = useUploadInsuranceCatalogLogo();
  const toast = useToast();
  const [editing, setEditing] = useState(null); // null | {} (new) | entry (edit)
  const [deleting, setDeleting] = useState(null);
  const [togglingId, setTogglingId] = useState(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [stateFilter, setStateFilter] = useState('');
  const [page, setPage] = useState(0);

  const items = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  const activeCount = items.filter((e) => e.active).length;
  const statesCovered = useMemo(() => new Set(items.filter((e) => e.active).flatMap((e) => e.states || [])).size, [items]);
  const term = search.trim().toLowerCase();
  const rows = items
    .filter((e) => status === 'all' || (status === 'active' ? e.active : !e.active))
    .filter((e) => !stateFilter || (e.states || []).includes(stateFilter))
    .filter((e) => !term || (e.name || '').toLowerCase().includes(term));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const shown = rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  async function doDelete() {
    const id = deleting?.id;
    if (!id) { setDeleting(null); return; }
    try { await remove.mutateAsync(id); toast.push(`${deleting.name} deleted from the catalog.`); }
    catch (e) { toast.push(e?.response?.data?.error?.message ?? 'The insurance company couldn’t be deleted.', 'negative'); }
    setDeleting(null);
  }

  async function toggleActive(entry) {
    if (togglingId) return;
    setTogglingId(entry.id);
    try {
      await update.mutateAsync({ id: entry.id, body: { active: !entry.active } });
      toast.push(entry.active ? `${entry.name} deactivated.` : `${entry.name} activated.`);
    } catch (e) {
      toast.push(e?.response?.data?.error?.message ?? 'The status couldn’t be updated.', 'negative');
    } finally {
      setTogglingId(null);
    }
  }

  const addButton = (
    <button type="button" className="rxc-btn rxc-btn--primary" onClick={() => setEditing({})}>
      <Icon name="plus" size={17} /><span>Add insurance company</span>
    </button>
  );

  return (
    <section>
      <PageHeader
        eyebrow="Business"
        title="Insurance catalog"
        description="State-specific insurance companies that companies can choose from when recording client coverage."
        actions={addButton}
      />

      {!isLoading && !isError ? (
        <div className="rxc-grid rxc-grid--stats" style={{ marginBottom: 20 }}>
          <StatCard icon="shield" tone="blue" label="Insurance companies" value={items.length} />
          <StatCard icon="checkCircle" tone="green" label="Active" value={activeCount} hint="Offered to companies" />
          <StatCard icon="power" tone="slate" label="Inactive" value={items.length - activeCount} hint="Hidden from companies" />
          <StatCard icon="mapPin" tone="violet" label="States covered" value={statesCovered} hint="By at least one active insurer" />
        </div>
      ) : null}

      <Card flush>
        {isLoading ? <LoadingState label="Loading insurance catalog…" />
          : isError ? <ErrorState message="The insurance catalog couldn’t be loaded." onRetry={refetch} />
          : items.length === 0 ? (
            <EmptyState icon="shield" title="No insurance companies in the catalog yet"
              message="Add the first insurer and the states it serves. Companies in those states can then select it." />
          ) : (
            <>
              <div className="rxc-toolbar">
                <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(0); }} placeholder="Search insurance companies" label="Search insurance companies" />
                <FilterTabs label="Filter by status" value={status} onChange={(k) => { setStatus(k); setPage(0); }}
                  options={STATUS_FILTERS.map((f) => ({ ...f, count: f.key === 'all' ? items.length : f.key === 'active' ? activeCount : items.length - activeCount }))} />
                <span className="rxc-toolbar__spacer" />
                <label className="sr-only" htmlFor="insurance-state-filter">Filter by state</label>
                <select id="insurance-state-filter" className="rxc-select" value={stateFilter} onChange={(e) => { setStateFilter(e.target.value); setPage(0); }}>
                  <option value="">All states</option>
                  {US_STATES.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
                </select>
              </div>
              {rows.length === 0 ? (
                <EmptyState icon="search" title="No matching insurance companies" message="Try a different search, status or state."
                  action={<button type="button" className="rxc-btn rxc-btn--secondary rxc-btn--sm" onClick={() => { setSearch(''); setStatus('all'); setStateFilter(''); }}>Clear filters</button>} />
              ) : (
                <>
                  <div className="rxc-table-wrap">
                    <table className="rxc-table rxc-table--stack">
                      <caption className="sr-only">Insurance catalog</caption>
                      <thead>
                        <tr>
                          <th scope="col">Insurance company</th>
                          <th scope="col">States available</th>
                          <th scope="col">Status</th>
                          <th scope="col">Updated</th>
                          <th scope="col"><span className="sr-only">Actions</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((e) => (
                          <tr key={e.id}>
                            <td data-primary>
                              <div className="rxc-entity">
                                <Avatar name={e.name} src={e.logoUrl} size="md" square />
                                <span className="rxc-entity__text">
                                  <span className="rxc-entity__name">{e.name}</span>
                                  {e.notes ? <span className="rxc-entity__sub">{e.notes}</span> : null}
                                </span>
                              </div>
                            </td>
                            <td data-label="States"><StatesCell states={e.states} /></td>
                            <td data-label="Status"><Badge tone={e.active ? 'ok' : 'neutral'}>{e.active ? 'Active' : 'Inactive'}</Badge></td>
                            <td data-label="Updated" className="is-muted rxc-nowrap">{formatDate(e.updatedAt ?? e.createdAt) || '—'}</td>
                            <td className="is-actions">
                              <div className="rxc-actions">
                                <button type="button" className="rxc-btn rxc-btn--secondary rxc-btn--sm" onClick={() => setEditing(e)} aria-label={`Edit ${e.name}`}>
                                  <Icon name="edit" size={14} /><span>Edit</span>
                                </button>
                                <button type="button" className="rxc-btn rxc-btn--ghost rxc-btn--sm" onClick={() => toggleActive(e)} disabled={!!togglingId}>
                                  {togglingId === e.id ? <span className="rxc-spinner rxc-spinner--inline" aria-hidden="true" /> : <Icon name={e.active ? 'power' : 'checkCircle'} size={14} />}
                                  <span>{e.active ? 'Deactivate' : 'Activate'}</span>
                                </button>
                                <button type="button" className="rxc-btn rxc-btn--ghost rxc-btn--sm" onClick={() => setDeleting(e)} aria-label={`Delete ${e.name}`} style={{ color: 'var(--rx-danger)' }}>
                                  <Icon name="trash" size={14} /><span>Delete</span>
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Pagination page={safePage} pageSize={PAGE_SIZE} total={rows.length} onPage={setPage} noun={rows.length === 1 ? 'insurance company' : 'insurance companies'} />
                </>
              )}
            </>
          )}
      </Card>

      {editing && (
        <CatalogEditor
          entry={editing}
          onClose={() => setEditing(null)}
          onSave={async (body, logoFile) => {
            try {
              if (editing.id) {
                await update.mutateAsync({ id: editing.id, body });
              } else {
                // Create first, then upload the chosen logo against the new id
                // (the create schema is strict and takes no file field).
                const created = await create.mutateAsync(body);
                if (logoFile && created?.id) await uploadLogo.mutateAsync({ id: created.id, file: logoFile });
              }
              toast.push(editing.id ? 'Insurance company updated.' : 'Insurance company added.');
              setEditing(null);
            } catch (e) {
              toast.push(e?.response?.data?.error?.message ?? 'The insurance company couldn’t be saved. Check the fields and try again.', 'negative');
            }
          }}
          onUploadLogo={async (id, file) => {
            const updated = await uploadLogo.mutateAsync({ id, file });
            toast.push('Logo uploaded.');
            return updated;
          }}
          uploading={uploadLogo.isPending}
          busy={create.isPending || update.isPending}
        />
      )}

      <ConfirmDialog
        open={!!deleting}
        title="Delete insurance company?"
        message={deleting ? `${deleting.name} will be removed from the catalog and no longer offered to companies. Existing client coverage records that reference it are kept.` : ''}
        confirmLabel="Delete"
        busyLabel="Deleting…"
        tone="danger"
        busy={remove.isPending}
        onConfirm={doDelete}
        onCancel={() => setDeleting(null)}
      />
    </section>
  );
}

/** Read a File into a base64 data URL for the JSON upload body. */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file.'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

const MAX_LOGO_BYTES = 2 * 1024 * 1024;

function CatalogEditor({ entry, onSave, onClose, onUploadLogo, uploading, busy }) {
  const isEdit = Boolean(entry?.id);
  const [form, setForm] = useState({ ...BLANK, ...entry, logoUrl: entry?.logoUrl ?? '', notes: entry?.notes ?? '' });
  const [err, setErr] = useState('');
  const [stateSearch, setStateSearch] = useState('');
  const toggleState = (code) => setForm((f) => ({ ...f, states: f.states.includes(code) ? f.states.filter((x) => x !== code) : [...f.states, code] }));

  const shown = US_STATES.filter((s) => s.name.toLowerCase().includes(stateSearch.trim().toLowerCase()));
  const allShownSelected = shown.length > 0 && shown.every((s) => form.states.includes(s.code));

  async function pickLogo(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    setErr('');
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { setErr('Choose a PNG, JPG or WebP image.'); return; }
    if (file.size > MAX_LOGO_BYTES) { setErr('The logo must be 2 MB or smaller.'); return; }
    try {
      const dataUrl = await fileToBase64(file);
      if (isEdit) {
        // Existing entry: upload immediately and reflect the returned URL.
        const updated = await onUploadLogo(entry.id, dataUrl);
        setForm((f) => ({ ...f, logoUrl: updated?.logoUrl ?? f.logoUrl }));
      } else {
        // New entry: preview locally; the file is uploaded right after create.
        setForm((f) => ({ ...f, logoFile: dataUrl, logoUrl: dataUrl }));
      }
    } catch (ex) {
      setErr(ex?.response?.data?.error?.message ?? 'That image couldn’t be uploaded.');
    }
  }

  function submit(e) {
    e?.preventDefault?.();
    if (busy) return;
    if (!form.name.trim()) { setErr('Enter an insurance company name.'); return; }
    if (form.states.length === 0) { setErr('Select at least one state.'); return; }
    const logo = form.logoUrl.trim();
    if (!form.logoFile && logo && !/^https?:\/\//i.test(logo)) { setErr('The logo URL must start with http:// or https://.'); return; }
    setErr('');
    const body = { name: form.name.trim(), states: form.states, active: form.active };
    // A pasted URL is still supported; a locally-previewed uploaded file (new
    // entry) is handed back separately and uploaded by the parent after create,
    // because the create schema is strict and accepts no file field.
    if (!form.logoFile && /^https?:\/\//i.test(logo)) body.logoUrl = logo;
    else if (isEdit && !logo) body.logoUrl = null;
    body.notes = form.notes.trim() ? form.notes.trim() : (isEdit ? null : undefined);
    onSave(body, form.logoFile || null);
  }

  return (
    <Modal
      title={isEdit ? 'Edit insurance company' : 'Add insurance company'}
      description="Companies operating in the selected states can choose this insurer."
      onClose={onClose}
      size="lg"
      closeDisabled={busy}
      footer={<>
        <span className="modal-foot__start">{form.states.length} state{form.states.length === 1 ? '' : 's'} selected</span>
        <button type="button" className="rxc-btn rxc-btn--secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" form="rxc-insurance-form" className="rxc-btn rxc-btn--primary" disabled={busy || uploading}>{busy ? 'Saving…' : 'Save'}</button>
      </>}
    >
      <form id="rxc-insurance-form" className="rxc-form" onSubmit={submit} noValidate>
        {err ? <p className="form-error" role="alert"><Icon name="alertCircle" size={16} /><span>{err}</span></p> : null}

        <Field label="Name">
          <input className="input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Blue Cross Blue Shield of Texas" autoFocus />
        </Field>

        <div className="rxc-field">
          <span className="rxc-field__label">Logo</span>
          <div className="rxc-logo-row">
            <span className="rxc-logo-box">
              {form.logoUrl ? <img src={form.logoUrl} alt="" /> : <Icon name="shield" size={22} />}
            </span>
            <span className="rxc-btn rxc-btn--secondary rxc-btn--sm rxc-file-btn" aria-disabled={uploading ? 'true' : undefined}>
              {uploading ? <span className="rxc-spinner rxc-spinner--inline" aria-hidden="true" /> : <Icon name="upload" size={14} />}
              <span>{uploading ? 'Uploading…' : (form.logoUrl ? 'Replace logo' : 'Upload logo')}</span>
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={pickLogo} disabled={uploading} aria-label="Upload logo" />
            </span>
            {form.logoUrl ? (
              <button type="button" className="rxc-btn rxc-btn--ghost rxc-btn--sm" onClick={() => setForm((f) => ({ ...f, logoUrl: '', logoFile: undefined }))}>Remove</button>
            ) : null}
          </div>
          <small className="rxc-field__hint">PNG, JPG or WebP, up to 2 MB — or paste an image URL below.</small>
          <input className="rxc-input" value={/^data:/.test(form.logoUrl) ? '' : form.logoUrl} placeholder="https://…" aria-label="Logo URL"
            onChange={(e) => setForm((f) => ({ ...f, logoUrl: e.target.value, logoFile: undefined }))} />
        </div>

        <div className="rxc-field">
          <span className="rxc-field__label">States available</span>
          <div className="rxc-state-picker">
            <div className="rxc-state-picker__bar">
              <div className="rxc-search">
                <Icon name="search" size={16} />
                <input type="search" className="rxc-search__input" placeholder="Filter states" value={stateSearch} onChange={(e) => setStateSearch(e.target.value)} aria-label="Filter states" />
              </div>
              <button type="button" className="rxc-btn rxc-btn--ghost rxc-btn--sm" disabled={shown.length === 0}
                onClick={() => setForm((f) => ({
                  ...f,
                  states: allShownSelected
                    ? f.states.filter((c) => !shown.some((s) => s.code === c))
                    : [...new Set([...f.states, ...shown.map((s) => s.code)])],
                }))}>
                {allShownSelected ? 'Clear shown' : 'Select shown'}
              </button>
              {form.states.length ? (
                <button type="button" className="rxc-btn rxc-btn--ghost rxc-btn--sm" onClick={() => setForm((f) => ({ ...f, states: [] }))}>Clear all</button>
              ) : null}
            </div>
            <div className="rxc-check-grid" role="group" aria-label="States available">
              {shown.length === 0 ? <span className="rxc-muted" style={{ padding: 8, fontSize: '.82rem' }}>No states match “{stateSearch}”.</span> : shown.map((s) => {
                const on = form.states.includes(s.code);
                return (
                  <label key={s.code} className={on ? 'is-on' : undefined}>
                    <input type="checkbox" checked={on} onChange={() => toggleState(s.code)} aria-label={s.name} />
                    {s.name}
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        <Field label="Notes" hint="Optional. Internal notes for platform operators.">
          <textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} rows={2} maxLength={1000} />
        </Field>

        <label className="rxc-switch">
          <span className="rxc-switch__text">
            <span className="rxc-switch__title">Active</span>
            <span className="rxc-switch__desc">Active insurers are visible to companies in the selected states.</span>
          </span>
          <input type="checkbox" role="switch" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} />
        </label>
      </form>
    </Modal>
  );
}

export default InsuranceCatalogRx;
