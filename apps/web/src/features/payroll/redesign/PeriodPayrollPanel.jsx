import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  previewPeriodPayroll, getGeneratedPeriodPayroll, generatePeriodPayroll,
  downloadPeriodPayrollXlsx, downloadPeriodPayrollPdf,
} from '@/api/client';
import { useToast } from '@/components';
import { Card, Button, Badge, Icon, Confirm, DateInput, Field, ErrorState } from '@/ui';
import { formatMoney, formatDate, formatPersonName } from '@/lib/format';
import { useOrgTimezone } from '@/auth/store';

/**
 * COMPANY ADMIN · PAYROLL.
 *
 * Choose a payroll period — Weekly (the latest completed Monday–Sunday week),
 * Bi-weekly (the latest completed two-week period) or a Custom From–To range —
 * and the server calculates each staff member's payout: actual worked time from
 * their completed sessions × their Staff Profile hourly rate applicable on each
 * work date. Generate Payroll saves it once for the period; Download Excel and
 * Download PDF are built from that saved payroll. The server resolves every
 * period in the organization's timezone and computes every figure — the page
 * only presents them. The period lives in the URL, so a refresh reopens it.
 */

export const PAYROLL_PREVIEW_KEY = (params) => ['payroll-period', params];
export const PAYROLL_GENERATED_KEY = (params) => ['payroll-generated', params];
const MODES = [{ id: 'weekly', label: 'Weekly' }, { id: 'biweekly', label: 'Bi-weekly' }, { id: 'custom', label: 'Custom' }];
const MODE_HINT = {
  weekly: 'Weekly payroll covers a completed Monday to Sunday week.',
  biweekly: 'Bi-weekly payroll covers two completed Monday to Sunday weeks.',
  custom: 'Both dates are included in the payroll period.',
};
const money = (cents) => (cents == null ? '—' : formatMoney(cents));
const hm = (min) => { const m = Math.max(0, Math.round(Number(min) || 0)); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const person = (n) => (n ? formatPersonName(n) : 'Unnamed staff member');
const rateText = (rates) => (rates?.length ? rates.map((c) => `${formatMoney(c)}/hr`).join(' / ') : 'Hourly rate not available');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isDateKey = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
const serverMessage = (e) => (e?.response?.status && e.response.status < 500 ? e?.response?.data?.error?.message : null);

/** From / To validation: both required, From on or before To. */
export function validateCustomRange({ from, to }) {
  if (!from || !to) return { valid: false, message: '' };
  if (from > to) return { valid: false, message: 'From Date must be on or before To Date.' };
  return { valid: true, message: '' };
}

function readUrl(searchParams) {
  const mode = MODES.some((m) => m.id === searchParams.get('mode')) ? searchParams.get('mode') : 'weekly';
  const anchor = isDateKey(searchParams.get('anchor')) ? searchParams.get('anchor') : '';
  const from = isDateKey(searchParams.get('from')) ? searchParams.get('from') : '';
  const to = isDateKey(searchParams.get('to')) ? searchParams.get('to') : '';
  return { mode, anchor, from, to };
}

export function PeriodPayrollPanel() {
  const toast = useToast();
  const qc = useQueryClient();
  const tz = useOrgTimezone() || undefined;
  const [searchParams, setSearchParams] = useSearchParams();
  const [state, setState] = useState(() => readUrl(searchParams));
  const [confirmGen, setConfirmGen] = useState(false);
  const [lastRun, setLastRun] = useState(null);
  const { mode, anchor, from, to } = state;
  const range = validateCustomRange({ from, to });

  const params = mode === 'custom'
    ? (range.valid ? { mode, from, to } : null)
    : { mode, ...(anchor ? { anchor } : {}) };

  const update = (next) => {
    const merged = { ...state, ...next };
    setState(merged);
    setLastRun(null);
    const q = { mode: merged.mode };
    if (merged.mode === 'custom') { if (merged.from) q.from = merged.from; if (merged.to) q.to = merged.to; } else if (merged.anchor) q.anchor = merged.anchor;
    setSearchParams(q, { replace: true });
  };

  const preview = useQuery({
    queryKey: PAYROLL_PREVIEW_KEY(params),
    queryFn: () => previewPeriodPayroll(params),
    enabled: Boolean(params),
    staleTime: 30_000,
  });
  const generatedQuery = useQuery({
    queryKey: PAYROLL_GENERATED_KEY(params),
    queryFn: () => getGeneratedPeriodPayroll(params),
    enabled: Boolean(params),
    staleTime: 30_000,
  });

  const data = preview.data;
  const generated = generatedQuery.data ?? null;
  const summary = data?.summary;
  const period = data?.period ?? generated?.period ?? null;
  const upToDate = Boolean(generated) && data?.generatedUpToDate !== false;
  const payableStaff = (data?.staff ?? []).filter((s) => (s.hourlyRates?.length ?? 0) > 0);
  const unpaidStaff = (data?.staff ?? []).filter((s) => s.missingRate);
  const canGenerate = Boolean(params) && !preview.isFetching && payableStaff.length > 0 && !(generated && upToDate);
  const actionLabel = generated && !upToDate ? 'Update Payroll' : 'Generate Payroll';

  const generate = useMutation({
    mutationFn: (p) => generatePeriodPayroll(p),
    onSuccess: (res, p) => {
      setConfirmGen(false);
      setLastRun(res);
      qc.setQueryData(PAYROLL_GENERATED_KEY(p), res.generated ?? null);
      qc.invalidateQueries({ queryKey: PAYROLL_PREVIEW_KEY(p) });
      const label = res.period?.label ?? '';
      toast.push(res.alreadyGenerated ? 'Payroll for this period has already been generated.' : res.updated ? `Payroll updated for ${label}.` : `Payroll generated for ${label}.`);
    },
    onError: (e) => { setConfirmGen(false); toast.push(serverMessage(e) || 'Unable to generate payroll. Please try again.', 'error'); },
  });
  const excel = useMutation({
    mutationFn: (p) => downloadPeriodPayrollXlsx(p),
    onSuccess: () => toast.push('Excel file downloaded.'),
    onError: () => toast.push('Unable to download payroll. Please try again.', 'error'),
  });
  const pdf = useMutation({
    mutationFn: (p) => downloadPeriodPayrollPdf(p),
    onSuccess: () => toast.push('PDF downloaded.'),
    onError: () => toast.push('Unable to download payroll. Please try again.', 'error'),
  });

  const loading = Boolean(params) && (preview.isLoading || generatedQuery.isLoading);
  const loadError = preview.isError ? preview.error : generatedQuery.isError ? generatedQuery.error : null;
  // What the summary and table show: the saved payroll once generated, otherwise the calculated preview.
  const view = generated
    ? { staff: generated.staff, staffPaid: generated.summary.staffCount, bcba: generated.summary.bcbaCount, rbt: generated.summary.rbtCount, minutes: generated.summary.totalMinutes, total: generated.summary.totalAmount }
    : summary && { staff: data.staff, staffPaid: summary.paidStaffCount, bcba: summary.bcbaCount, rbt: summary.rbtCount, minutes: summary.paidMinutes, total: summary.totalAmount };
  const nothingWorked = Boolean(data) && data.staff.length === 0 && !generated;

  let hint = MODE_HINT[mode];
  if (mode === 'custom' && (!from || !to)) hint = 'Select a From Date and a To Date.';
  else if (generated && upToDate) hint = 'Payroll has already been generated for this period.';

  return (
    <div className="rx-pr">
      <header className="rx-st__head">
        <div className="rx-st__head-text">
          <h1 className="rx-st__title">Payroll</h1>
          <p className="rx-st__subtitle">Calculate staff payouts from actual worked hours and each staff member’s hourly rate.</p>
        </div>
      </header>

      <section className="rx-card rx-card--pad rx-pr__period" aria-labelledby="pr-period">
        <div className="rx-pr__period-top">
          <div className="rx-pr__period-block">
            <h2 id="pr-period" className="rx-pr__label">Payroll Period</h2>
            <div className="rx-segmented" role="group" aria-label="Payroll period type">
              {MODES.map((m) => (
                <button key={m.id} type="button" className={`rx-segmented__item${mode === m.id ? ' is-active' : ''}`} aria-pressed={mode === m.id}
                  onClick={() => update({ mode: m.id, anchor: '' })}>{m.label}</button>
              ))}
            </div>
          </div>
          <Button icon={Icon.Wallet} onClick={() => setConfirmGen(true)} disabled={!canGenerate} loading={generate.isPending}>{actionLabel}</Button>
        </div>

        {mode === 'custom' ? (
          <div className="rx-pr__custom">
            <Field label="From Date" htmlFor="pr-from" required>
              <DateInput id="pr-from" aria-label="From Date" required value={from} error={Boolean(range.message)} onChange={(e) => update({ from: e.target.value })} />
            </Field>
            <Field label="To Date" htmlFor="pr-to" required error={range.message}>
              <DateInput id="pr-to" aria-label="To Date" required value={to} error={Boolean(range.message)} onChange={(e) => update({ to: e.target.value })} />
            </Field>
          </div>
        ) : (
          <div className="rx-pr__range" aria-live="polite">
            <button type="button" className="rx-pr__nav" onClick={() => update({ anchor: period?.previousAnchor })} disabled={!period?.previousAnchor} aria-label="Previous payroll period">
              <span aria-hidden="true">‹</span>
            </button>
            <div className="rx-pr__range-text">
              <span className="rx-pr__range-label">{MODES.find((m) => m.id === mode)?.label} period</span>
              <strong>{period?.label ?? (loadError ? '—' : 'Loading…')}</strong>
            </div>
            <button type="button" className="rx-pr__nav" onClick={() => update({ anchor: period?.nextAnchor })} disabled={!period?.nextAnchor} aria-label="Next payroll period">
              <span aria-hidden="true">›</span>
            </button>
          </div>
        )}
        {!range.message && <p className="rx-pr__hint">{hint}</p>}
      </section>

      {!params ? null : loading ? <PayrollSkeleton /> : loadError ? (
        <Card pad={false}>
          <ErrorState title="Unable to load payroll" body={serverMessage(loadError) || 'Please try again.'} onRetry={() => { preview.refetch(); generatedQuery.refetch(); }} />
        </Card>
      ) : nothingWorked ? (
        <Card pad={false}>
          <div className="rx-st__empty">
            <span className="rx-st__empty-icon" aria-hidden="true"><Icon.Inbox size={22} /></span>
            <div className="rx-st__empty-title">No staff worked during this payroll period</div>
            <p className="rx-st__empty-body">No completed sessions were recorded between {period?.label?.replace(' – ', ' and ')}.</p>
          </div>
        </Card>
      ) : view ? (
        <>
          {lastRun && !lastRun.alreadyGenerated && (
            <section className="rx-pr__run" role="status">
              <Icon.CheckCircle size={20} aria-hidden="true" />
              <div>
                <strong>{lastRun.updated ? 'Payroll updated' : 'Payroll generated'}</strong>
                <div className="rx-pr__run-meta">{plural(lastRun.generated?.summary?.staffCount ?? 0, 'staff member')} · {money(lastRun.generated?.summary?.totalAmount)}</div>
              </div>
            </section>
          )}

          <section className="rx-pr__summary" aria-label="Payroll summary">
            <Stat tone="violet" className="rx-pr__stat--period" icon={Icon.Calendar} label="Payroll Period" value={period?.label} hint={MODES.find((m) => m.id === (period?.mode ?? mode))?.label} />
            <Stat tone="blue" icon={Icon.Users} label="Staff Paid" value={view.staffPaid} hint={`${view.bcba} BCBA · ${view.rbt} RBT`} />
            <Stat tone="teal" icon={Icon.Clock} label="Total Worked Hours" value={hm(view.minutes)} />
            <Stat tone="green" icon={Icon.Wallet} label="Total Company Payroll" value={money(view.total)} />
          </section>

          {unpaidStaff.length > 0 && (
            <section className="rx-pr__notice" role="status" aria-label="Incomplete payroll information">
              <Icon.Bell size={18} aria-hidden="true" />
              <div>
                <strong>Some payroll information is incomplete.</strong>
                <span> The hourly rate is not available for {plural(unpaidStaff.length, 'staff member')}, so their payout is not included yet.</span>
                <ul>{unpaidStaff.map((s) => <li key={s.staffProfileId}>{person(s.staffName)}{s.role ? ` (${s.role})` : ''} — {hm(s.workedMinutes)} worked</li>)}</ul>
                <Link to="/staff">Add the hourly rate on the staff profile</Link>
              </div>
            </section>
          )}

          {generated && (
            <section className="rx-card rx-card--pad rx-pr__generated" aria-labelledby="pr-generated">
              <div className="rx-pr__generated-head">
                <div>
                  <Badge tone="approved">Generated</Badge>
                  <h2 id="pr-generated" className="rx-pr__title">Generated Payroll</h2>
                  <p className="rx-pr__sub">
                    Payroll Period {generated.period.label} · {plural(generated.summary.staffCount, 'staff member')} · {hm(generated.summary.totalMinutes)} worked
                    {generated.generatedAt ? ` · Generated on ${formatDate(generated.generatedAt, tz)}` : ''}
                  </p>
                </div>
                <div className="rx-pr__actions">
                  <Button variant="ghost" icon={Icon.Doc} onClick={() => excel.mutate(params)} loading={excel.isPending}>Download Excel</Button>
                  <Button icon={Icon.Doc} onClick={() => pdf.mutate(params)} loading={pdf.isPending}>Download PDF</Button>
                </div>
              </div>
              {!upToDate && (
                <div className="rx-pr__notice rx-pr__notice--inline" role="status" aria-label="Payroll has changed">
                  <Icon.Bell size={18} aria-hidden="true" />
                  <div>
                    <strong>This payroll has changed since it was generated.</strong>
                    <span> The payroll for this period now totals {money(summary?.totalAmount)}. The downloads contain the payroll as it was generated.</span>
                    <div><Button icon={Icon.Wallet} onClick={() => setConfirmGen(true)} disabled={!canGenerate} loading={generate.isPending}>Update Payroll</Button></div>
                  </div>
                </div>
              )}
            </section>
          )}

          <section className="rx-card rx-pr__table-card" aria-labelledby="pr-table">
            <div className="rx-pr__table-head">
              <h2 id="pr-table" className="rx-pr__title">Payroll Summary</h2>
              {!generated && <Badge tone="pending">Not generated yet</Badge>}
            </div>
            <div className="rx-pr__scroll">
              <table className="rx-pr__table" aria-label="Staff payroll">
                <thead>
                  <tr><th scope="col">Staff Name</th><th scope="col">Role</th><th scope="col" className="is-num">Hourly Rate</th><th scope="col" className="is-num">Hours Worked</th><th scope="col" className="is-num">Payout</th></tr>
                </thead>
                <tbody>
                  {view.staff.map((s) => {
                    const unpaid = !(s.hourlyRates?.length);
                    return (
                      <tr key={s.staffProfileId} className={unpaid ? 'is-unpaid' : undefined}>
                        <td className="rx-pr__name">{person(s.staffName)}</td>
                        <td>{s.role ? <span className={`rx-st__role rx-st__role--${String(s.role).split(' ')[0].toLowerCase()}`}>{s.role}</span> : 'Staff'}</td>
                        <td className="is-num">{rateText(s.hourlyRates)}</td>
                        <td className="is-num">{hm(s.workedMinutes)}</td>
                        <td className="is-num rx-pr__payout">{unpaid ? '—' : money(s.amount)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={3}>Total company payroll</th>
                    <td className="is-num">{hm(view.minutes)}</td>
                    <td className="is-num rx-pr__total">{money(view.total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
        </>
      ) : null}

      <Confirm
        open={confirmGen}
        title={generated ? 'Update payroll for this period?' : 'Generate payroll for this period?'}
        message={summary && period ? [
          `${generated ? 'This updates' : 'This saves'} the payroll for ${period.label}: ${plural(summary.paidStaffCount, 'staff member')}, ${hm(summary.paidMinutes)} worked, total ${money(summary.totalAmount)}.`,
          unpaidStaff.length ? `${plural(unpaidStaff.length, 'staff member')} without an hourly rate ${unpaidStaff.length === 1 ? 'is' : 'are'} not included.` : '',
        ].filter(Boolean).join(' ') : ''}
        confirmLabel={actionLabel}
        onConfirm={() => generate.mutate(params)}
        onCancel={() => setConfirmGen(false)}
        busy={generate.isPending}
      />
    </div>
  );
}

function Stat({ tone, icon: IconCmp, label, value, hint, className = '' }) {
  return (
    <div className={`rx-cl__stat rx-cl__stat--${tone} ${className}`.trim()}>
      <span className="rx-cl__stat-icon" aria-hidden="true"><IconCmp size={18} /></span>
      <span className="rx-cl__stat-body">
        <span className="rx-cl__stat-label">{label}</span>
        <span className="rx-cl__stat-value">{value}</span>
        {hint ? <span className="rx-cl__stat-hint">{hint}</span> : null}
      </span>
    </div>
  );
}

function PayrollSkeleton() {
  return (
    <div className="rx-pr__skeleton" aria-busy="true" aria-label="Loading payroll">
      <div className="rx-pr__summary">{[0, 1, 2, 3].map((i) => <div key={i} className="rx-skel rx-cl__stat-skel" />)}</div>
      <div className="rx-skel" style={{ height: 240, borderRadius: 16 }} />
    </div>
  );
}

export default PeriodPayrollPanel;
