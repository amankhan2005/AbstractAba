import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  previewCompanyBilling, generateCompanyBilling, getGeneratedBill, listGeneratedBills,
  downloadCompanyBillingXlsx, downloadCompanyBillingPdf,
} from '@/api/client';
import { useToast } from '@/components';
import { Card, Button, Badge, Icon, Confirm, DateInput, Field, ErrorState } from '@/ui';
import { formatMoney, formatTime, formatDate, formatPersonName } from '@/lib/format';
import { useOrgTimezone } from '@/auth/store';
import { useBusinessDate } from '@/lib/useBusinessDate';

/**
 * COMPANY ADMIN · INSURANCE BILLING.
 *
 * From Date + To Date (organization business dates) → the server's billing
 * preview for the period → Generate Bill → the GENERATED BILL, read back from
 * the persisted claims, with Download Excel / Download PDF built from that same
 * persisted bill. Completed sessions are billing-ready automatically — no review
 * or approval step. Each clinician's worked time (SessionTimeRecord) is billed at
 * their Staff Profile hourly rate, BCBA and RBT separately, client by client.
 * The period lives in the URL, so a refresh or a return visit reopens the same
 * bill; an already generated period is never generated twice.
 */

export const BILLING_QUERY_KEY = (from, to) => ['insurance-billing', from, to];
export const GENERATED_BILL_KEY = (from, to) => ['insurance-bill', from, to];
export const GENERATED_BILLS_KEY = ['bills'];
const money = (cents) => (cents == null ? '—' : formatMoney(cents));
const rate = (cents) => (cents == null ? 'Hourly rate not available' : `${formatMoney(cents)}/hr`);
const hm = (min) => { const m = Math.max(0, Math.round(Number(min) || 0)); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const person = (n) => (n ? formatPersonName(n) : '—');
const usDate = (key) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || ''); return m ? `${m[2]}/${m[3]}/${m[1]}` : '—'; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isDateKey = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
const errorMessage = (e, fallback) => e?.response?.data?.error?.message || fallback;

const STATUS = {
  READY: { label: 'Ready to bill', tone: 'approved' },
  BILLED: { label: 'Billed', tone: 'info' },
  INCOMPLETE: { label: 'Incomplete', tone: 'pending' },
};
// Issues about a clinician name the clinicians; issues about a client name the clients.
const STAFF_ISSUES = new Set(['MISSING_HOURLY_RATE', 'CLINICIAN_ROLE_UNKNOWN', 'MISSING_TIME_RECORD']);
// Nothing billable yet (every session incomplete) shows "—", never a $0.00 charge.
const chargeOf = (cents, billableCount) => (billableCount > 0 ? money(cents) : '—');
// Where each billing-data gap is fixed.
const FIX = {
  MISSING_HOURLY_RATE: { to: '/staff', label: 'Add the hourly rate on the staff profile' },
  CLINICIAN_ROLE_UNKNOWN: { to: '/clients', label: 'Assign the clinician to the client’s care team' },
  MISSING_PAYER: { to: '/clients', label: 'Add the client’s insurance' },
  INSURANCE_NOT_ACTIVE: { to: '/clients', label: 'Update the client’s insurance' },
  COVERAGE_NOT_EFFECTIVE: { to: '/clients', label: 'Check the insurance effective dates' },
  AUTHORIZATION_EXPIRED: { to: '/clients', label: 'Check the authorization dates' },
  AUTHORIZATION_NOT_STARTED: { to: '/clients', label: 'Check the authorization dates' },
};

/** The most recently completed Monday→Sunday on the ORGANIZATION's calendar (civil dates). */
export function lastCompletedWeek(todayKey) {
  const [y, m, d] = String(todayKey).split('-').map(Number);
  const sinceMonday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  const key = (offset) => new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
  return { from: key(-sinceMonday - 7), to: key(-sinceMonday - 1) };
}

/** From / To validation: both required, From on or before To. */
export function validatePeriod({ from, to }) {
  if (!from || !to) return { valid: false, message: '' };
  if (from > to) return { valid: false, message: 'From Date must be on or before To Date.' };
  return { valid: true, message: '' };
}

export function ClaimsRedesign() {
  const toast = useToast();
  const qc = useQueryClient();
  const tz = useOrgTimezone() || undefined;
  const todayKey = useBusinessDate(tz);
  const [searchParams, setSearchParams] = useSearchParams();
  const initial = useMemo(() => {
    const from = searchParams.get('from'); const to = searchParams.get('to');
    return isDateKey(from) && isDateKey(to) && from <= to ? { from, to } : lastCompletedWeek(todayKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft] = useState(initial);   // what the date fields show
  const [period, setPeriod] = useState(initial); // the last valid period — what is loaded
  const [confirmGen, setConfirmGen] = useState(false);
  const [lastRun, setLastRun] = useState(null);
  const check = validatePeriod(draft);

  const applyPeriod = (next) => {
    setDraft(next);
    if (!validatePeriod(next).valid) return;
    if (next.from !== period.from || next.to !== period.to) setLastRun(null);
    setPeriod(next);
    setSearchParams({ from: next.from, to: next.to }, { replace: true });
  };

  const preview = useQuery({
    queryKey: BILLING_QUERY_KEY(period.from, period.to),
    queryFn: () => previewCompanyBilling({ from: period.from, to: period.to }),
    staleTime: 30_000,
  });
  const billQuery = useQuery({
    queryKey: GENERATED_BILL_KEY(period.from, period.to),
    queryFn: () => getGeneratedBill({ from: period.from, to: period.to }),
    staleTime: 30_000,
  });
  const billsQuery = useQuery({ queryKey: GENERATED_BILLS_KEY, queryFn: listGeneratedBills, staleTime: 30_000 });

  const data = preview.data;
  const summary = data?.summary;
  const bill = billQuery.data ?? null;
  const hasActivity = Boolean(summary && summary.totalSessions > 0);
  const readyToBill = summary?.readyToBill ?? 0;
  const canGenerate = check.valid && !preview.isFetching && readyToBill > 0;
  // A generated bill that does not yet hold every ready session (e.g. the RBT's
  // hourly rate was added after generation) must never pass for the complete
  // bill: the Excel and PDF contain only what is on it.
  const billOutdated = Boolean(bill && readyToBill > 0);
  const pending = billOutdated ? readyByClinician(data) : [];
  const actionLabel = billOutdated ? 'Update Bill' : 'Generate Bill';
  // The preview adds nothing once every completed session is on the generated bill.
  const showPreview = hasActivity && (!bill || readyToBill > 0 || (summary?.incomplete ?? 0) > 0);

  const generate = useMutation({
    mutationFn: ({ from, to }) => generateCompanyBilling({ from, to }),
    onSuccess: (res, { from, to }) => {
      setConfirmGen(false);
      setLastRun(res);
      qc.setQueryData(BILLING_QUERY_KEY(from, to), res);
      qc.setQueryData(GENERATED_BILL_KEY(from, to), res.bill ?? null);
      qc.invalidateQueries({ queryKey: GENERATED_BILLS_KEY });
      toast.push(res.alreadyGenerated
        ? 'A bill for this period already exists.'
        : res.updatedClaimCount > 0
          ? `Bill updated — ${plural(res.addedSessionCount, 'session')} added.`
          : `Bill generated for ${plural(res.clientCount, 'client')}.`);
    },
    onError: (e) => { setConfirmGen(false); toast.push(errorMessage(e, 'Unable to generate the bill. Please try again.'), 'error'); },
  });
  const excel = useMutation({
    mutationFn: (p) => downloadCompanyBillingXlsx(p),
    onSuccess: () => toast.push('Excel file downloaded.'),
    onError: () => toast.push('Unable to download the bill. Please try again.', 'error'),
  });
  const pdf = useMutation({
    mutationFn: (p) => downloadCompanyBillingPdf(p),
    onSuccess: () => toast.push('PDF downloaded.'),
    onError: () => toast.push('Unable to download the bill. Please try again.', 'error'),
  });

  let hint = 'Both dates are included in the billing period.';
  if (!draft.from || !draft.to) hint = 'Select a From Date and a To Date.';
  else if (bill && readyToBill === 0 && check.valid) hint = 'A bill has already been generated for this period.';
  else if (billOutdated && check.valid) hint = `${plural(readyToBill, 'completed session')} ${readyToBill === 1 ? 'is' : 'are'} ready but not on the generated bill yet. Select Update Bill to add ${readyToBill === 1 ? 'it' : 'them'}.`;

  const loading = preview.isLoading || billQuery.isLoading;
  const loadError = preview.isError ? preview.error : billQuery.isError ? billQuery.error : null;

  return (
    <div className="rx-ib">
      <header className="rx-st__head">
        <div className="rx-st__head-text">
          <h1 className="rx-st__title">Billing</h1>
          <p className="rx-st__subtitle">Generate and review  billing for client services within a selected date range.</p>
        </div>
      </header>

      <section className="rx-card rx-card--pad rx-ib__period" aria-labelledby="ib-period">
        <h2 id="ib-period" className="rx-ib__label">Billing Period</h2>
        <div className="rx-ib__period-row">
          <div className="rx-ib__period-fields">
            <Field label="From Date" htmlFor="ib-from" required>
              <DateInput id="ib-from" aria-label="From Date" required value={draft.from} error={Boolean(check.message)}
                onChange={(e) => applyPeriod({ ...draft, from: e.target.value })} />
            </Field>
            <Field label="To Date" htmlFor="ib-to" required error={check.message}>
              <DateInput id="ib-to" aria-label="To Date" required value={draft.to} error={Boolean(check.message)}
                onChange={(e) => applyPeriod({ ...draft, to: e.target.value })} />
            </Field>
          </div>
          <Button icon={Icon.Wallet} onClick={() => setConfirmGen(true)} disabled={!canGenerate} loading={generate.isPending}>{actionLabel}</Button>
        </div>
        {!check.message && <p className="rx-ib__hint">{hint}</p>}
      </section>

      {loading ? <BillingSkeleton /> : loadError ? (
        <Card pad={false}>
          <ErrorState title="Unable to load billing for this period" body={errorMessage(loadError, 'Please try again.')}
            onRetry={() => { preview.refetch(); billQuery.refetch(); }} />
        </Card>
      ) : (
        <>
          {lastRun && <RunResult run={lastRun} />}

          {bill && (
            <GeneratedBill
              bill={bill}
              tz={tz}
              onExcel={() => excel.mutate({ from: bill.period.from, to: bill.period.to })}
              onPdf={() => pdf.mutate({ from: bill.period.from, to: bill.period.to })}
              excelBusy={excel.isPending}
              pdfBusy={pdf.isPending}
              pending={billOutdated ? pending : []}
              pendingCount={readyToBill}
              pendingAmount={summary?.readyAmount ?? 0}
              onUpdate={() => setConfirmGen(true)}
              canUpdate={canGenerate}
              updating={generate.isPending}
            />
          )}

          {showPreview && <BillingPreview data={data} hasBill={Boolean(bill)} tz={tz} />}

          {data && !hasActivity && !bill && (
            <Card pad={false}>
              <div className="rx-st__empty">
                <span className="rx-st__empty-icon" aria-hidden="true"><Icon.Inbox size={22} /></span>
                <div className="rx-st__empty-title">No completed sessions</div>
                <p className="rx-st__empty-body">No completed sessions were recorded for any client between {usDate(data.period?.from)} and {usDate(data.period?.to)}.</p>
              </div>
            </Card>
          )}
        </>
      )}

      <GeneratedBillsList bills={billsQuery.data ?? []} current={period} tz={tz} onOpen={(p) => applyPeriod({ from: p.from, to: p.to })} />

      <Confirm
        open={confirmGen}
        title={billOutdated ? 'Update the bill for this period?' : 'Generate the bill for this period?'}
        message={summary ? [
          billOutdated
            ? `This adds ${plural(readyToBill, 'completed session')} (${money(summary.readyAmount)}) to the bill for ${usDate(period.from)} – ${usDate(period.to)}: ${pendingText(pending)}.`
            : `This creates the  bill for ${usDate(period.from)} – ${usDate(period.to)}: ${plural(readyToBill, 'completed session')} across ${plural((data?.clients ?? []).filter((c) => c.readyCount > 0).length, 'client')}, ${money(summary.readyAmount)}.`,
          summary.incomplete > 0 ? `${plural(summary.incomplete, 'session')} with incomplete billing information ${summary.incomplete === 1 ? 'is' : 'are'} not included.` : '',
          'Sessions already billed are never billed again.',
        ].filter(Boolean).join(' ') : ''}
        confirmLabel={actionLabel}
        onConfirm={() => generate.mutate({ from: period.from, to: period.to })}
        onCancel={() => setConfirmGen(false)}
        busy={generate.isPending}
      />
    </div>
  );
}

function Stat({ tone, icon: IconCmp, label, value, hint }) {
  return (
    <div className={`rx-cl__stat rx-cl__stat--${tone}`}>
      <span className="rx-cl__stat-icon" aria-hidden="true"><IconCmp size={18} /></span>
      <span className="rx-cl__stat-body">
        <span className="rx-cl__stat-label">{label}</span>
        <span className="rx-cl__stat-value">{value}</span>
        {hint ? <span className="rx-cl__stat-hint">{hint}</span> : null}
      </span>
    </div>
  );
}

/** Ready (not yet billed) sessions per client, role and clinician — the server's own counts, for display. */
function readyByClinician(data) {
  return (data?.clients ?? []).flatMap((c) => [...(c.bcbaStaff ?? []), ...(c.rbtStaff ?? []), ...(c.unassignedStaff ?? [])]
    .filter((st) => (st.readyCount ?? 0) > 0)
    .map((st) => ({ clientName: c.clientName, role: st.role, staffName: st.staffName, sessions: st.readyCount })));
}
const pendingText = (pending) => pending.map((p) => `${person(p.clientName)} — ${p.role ?? 'Staff member'} ${person(p.staffName)} (${plural(p.sessions, 'session')})`).join('; ');

/** THE GENERATED BILL — the saved bill for the period; the Excel and PDF downloads contain exactly this. */

function GeneratedBill({ bill, tz, onExcel, onPdf, excelBusy, pdfBusy, pending = [], pendingCount = 0, pendingAmount = 0, onUpdate, canUpdate, updating }) {
  const sm = bill.summary;
  return (
    <section className="rx-ib__generated" aria-labelledby="ib-generated">
      <div className="rx-card rx-card--pad rx-ib__generated-card">
        <header className="rx-ib__generated-head">
          <div>
            <div className="rx-ib__eyebrow"><Badge tone="approved">Generated</Badge></div>
            <h2 id="ib-generated" className="rx-ib__generated-title">Generated Bill</h2>
            <p className="rx-ib__sub">
              Billing Period {bill.period?.label}
              {bill.generatedAt ? ` · Generated on ${formatDate(bill.generatedAt, tz)}` : ''}
            </p>
          </div>
        </header>
        {pending.length > 0 && (
          <div className="rx-ib__notice rx-ib__notice--bill" role="status" aria-label="Sessions not on this bill">
            <Icon.Bell size={18} aria-hidden="true" />
            <div>
              <strong>Not on this bill yet: {plural(pendingCount, 'completed session')} ({money(pendingAmount)}).</strong>
              <span> They became ready after the bill was generated. The Excel and PDF contain only what is on the bill.</span>
              <ul>{pending.map((p) => <li key={`${p.clientName}|${p.role}|${p.staffName}`}>{person(p.clientName)} — {p.role ?? 'Staff member'} {person(p.staffName)} · {plural(p.sessions, 'session')}</li>)}</ul>
              <Button icon={Icon.Wallet} onClick={onUpdate} disabled={!canUpdate} loading={updating}>Update Bill</Button>
            </div>
          </div>
        )}
        <div className="rx-ib__summary" aria-label="Generated bill summary">
          <Stat tone="violet" icon={Icon.Users} label="Clients" value={sm.totalClients} />
          <Stat tone="blue" icon={Icon.Clipboard} label="Sessions" value={sm.totalSessions} hint={`${sm.bcbaSessions} BCBA · ${sm.rbtSessions} RBT`} />
          <Stat tone="teal" icon={Icon.Clock} label="Total worked time" value={hm(sm.totalWorkedMinutes)} hint={`BCBA ${hm(sm.bcbaWorkedMinutes)} · RBT ${hm(sm.rbtWorkedMinutes)}`} />
          <Stat tone="green" icon={Icon.Wallet} label="Total bill" value={money(sm.totalBillableAmount)} hint={`BCBA ${money(sm.bcbaCharge)} · RBT ${money(sm.rbtCharge)}`} />
        </div>
      </div>

      <div className="rx-ib__bills" aria-label="Generated client bills">
        {bill.clients.map((c) => <ClientBill key={c.clientId} c={c} tz={tz} idPrefix="bill" summaryOnly />)}
      </div>

      <div className="rx-ib__total rx-ib__total--bill" aria-label="Total company  bill">
        <div>
          <div className="rx-ib__total-label">Total bill</div>
          <div className="rx-ib__total-ctx">{plural(sm.totalClients, 'client')} · BCBA {money(sm.bcbaCharge)} · RBT {money(sm.rbtCharge)}</div>
        </div>
        <div className="rx-ib__total-value">{money(sm.totalBillableAmount)}</div>
        <div className="rx-ib__actions rx-ib__downloads">
          <Button variant="ghost" icon={Icon.Doc} onClick={onExcel} loading={excelBusy}>Download Excel</Button>
          <Button icon={Icon.Doc} onClick={onPdf} loading={pdfBusy}>Download PDF</Button>
        </div>
      </div>
    </section>
  );
}

/** The period's live billing figures — NOT a generated bill until Generate Bill is selected. */
function BillingPreview({ data, hasBill, tz }) {
  const summary = data.summary;
  return (
    <section className="rx-ib__preview" aria-labelledby="ib-preview">
      <div className="rx-ib__section-head">
        <h2 id="ib-preview" className="rx-ib__generated-title">Billing preview</h2>
        <p className="rx-ib__sub">
          {hasBill
            ? 'All completed sessions in this period, including those already on the generated bill. Sessions shown as ready to bill or incomplete are not billed yet.'
            : 'Not generated yet. These figures become the bill when you select Generate Bill.'}
        </p>
      </div>
      <div className="rx-ib__summary" aria-label="Billing preview summary">
        <Stat tone="blue" icon={Icon.Clipboard} label="Completed sessions" value={summary.totalSessions} hint={`${summary.bcbaSessions} BCBA · ${summary.rbtSessions} RBT`} />
        <Stat tone="violet" icon={Icon.Users} label="Clients" value={summary.totalClients} />
        <Stat tone="teal" icon={Icon.Clock} label="Total worked time" value={hm(summary.totalWorkedMinutes)} hint={`BCBA ${hm(summary.bcbaWorkedMinutes)} · RBT ${hm(summary.rbtWorkedMinutes)}`} />
        <Stat tone="green" icon={Icon.CheckCircle} label="Ready to bill" value={summary.readyToBill} hint={money(summary.readyAmount)} />
        <Stat tone="blue" icon={Icon.Wallet} label="Billed" value={summary.alreadyBilled} hint={money(summary.billedAmount)} />
        <Stat tone="violet" icon={Icon.Chart} label="Preview total" value={money(summary.totalBillableAmount)} hint={`BCBA ${money(summary.bcbaCharge)} · RBT ${money(summary.rbtCharge)}`} />
      </div>

      <IncompleteNotice summary={summary} />

      <div className="rx-ib__bills" aria-label="Client billing preview">
        {data.clients.map((c) => <ClientBill key={c.clientId} c={c} tz={tz} idPrefix="preview" />)}
      </div>

      <div className="rx-ib__total rx-ib__total--preview" aria-label="Billing preview total">
        <div>
          <div className="rx-ib__total-label">Preview total</div>
          <div className="rx-ib__total-ctx">
            {plural(summary.totalClients, 'client')} · {plural(summary.totalSessions, 'completed session')} · {hm(summary.totalWorkedMinutes)} worked · {summary.readyToBill} ready · {summary.alreadyBilled} billed
          </div>
        </div>
        <div className="rx-ib__total-value">{money(summary.totalBillableAmount)}</div>
      </div>
    </section>
  );
}

/** Billing-data gaps (not a review queue): what is missing and where to fix it. */
function IncompleteNotice({ summary }) {
  if (!summary.incomplete) return null;
  return (
    <section className="rx-ib__notice" role="status" aria-label="Incomplete billing data">
      <Icon.Bell size={18} aria-hidden="true" />
      <div>
        <strong>Some billing information is incomplete for {plural(summary.incomplete, 'session')}.</strong>
        <span> These sessions are included automatically once the missing information is added.</span>
        <ul>
          {(summary.issues ?? []).map((i) => (
            <li key={i.code}>
              {i.label}{(() => { const who = STAFF_ISSUES.has(i.code) ? i.staff : i.clients; return who?.length ? ` — ${who.map(person).join(', ')}` : ''; })()} <span className="rx-ib__count">{plural(i.count, 'session')}</span>
              {FIX[i.code] && <> · <Link to={FIX[i.code].to}>{FIX[i.code].label}</Link></>}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function RunResult({ run }) {
  return (
    <section className="rx-ib__run" role="status">
      <Icon.CheckCircle size={20} aria-hidden="true" />
      <div>
        <strong>{run.alreadyGenerated ? 'A bill for this period already exists' : run.updatedClaimCount > 0 ? 'Bill updated' : 'Bill generated'}</strong>
        <div className="rx-ib__run-meta">
          {run.alreadyGenerated
            ? 'Every completed session in this period is already on the bill below.'
            : run.updatedClaimCount > 0
              ? `${plural(run.addedSessionCount, 'session')} added · ${money(run.generatedAmount)}`
              : `${plural(run.clientCount, 'client')} · ${money(run.generatedAmount)}`}
        </div>
      </div>
    </section>
  );
}

/** Periods that already have a generated bill — reopen one to see it and download it again. */
function GeneratedBillsList({ bills, current, tz, onOpen }) {
  if (!bills.length) return null;
  return (
    <section className="rx-card rx-ib__history" aria-labelledby="ib-history">
      <h2 id="ib-history" className="rx-ib__section-title rx-ib__history-title">Generated bills</h2>
      <ul className="rx-ib__history-list">
        {bills.map((b) => {
          const isCurrent = b.from === current.from && b.to === current.to;
          return (
            <li key={`${b.from}|${b.to}`} className={`rx-ib__history-item${isCurrent ? ' is-current' : ''}`}>
              <div>
                <div className="rx-ib__strong">{b.label}</div>
                <div className="rx-ib__sub">{plural(b.clientCount, 'client')}{b.generatedAt ? ` · Generated on ${formatDate(b.generatedAt, tz)}` : ''}</div>
              </div>
              {isCurrent ? <Badge tone="info">Open</Badge> : (
                <button type="button" className="rx-st__action" onClick={() => onOpen(b)} aria-label={`Open the bill for ${b.label}`}>Open bill</button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** One client's bill: BCBA and RBT charges calculated separately, then the client total. */
function ClientBill({ c, tz, idPrefix, summaryOnly = false }) {
  const [open, setOpen] = useState(false);
  const detailId = `ib-${idPrefix}-${c.clientId}`;
  const unassigned = c.unassignedStaff ?? [];
  return (
    <article className="rx-card rx-ib__bill" aria-labelledby={`${detailId}-name`}>
      <header className="rx-ib__bill-head">
        <div>
          <h3 id={`${detailId}-name`} className="rx-ib__client-name">{person(c.clientName)}</h3>
          <p className="rx-ib__sub">{plural(c.totalSessions, 'completed session')} · {hm(c.totalWorkedMinutes)} worked{c.payerName ? ` · ${c.payerName}` : ''}</p>
        </div>
        {!summaryOnly && <div className="rx-ib__badges">
          {c.readyCount > 0 && <Badge tone="approved">{c.readyCount} ready</Badge>}
          {c.billedCount > 0 && <Badge tone="info">{c.billedCount} billed</Badge>}
          {c.incompleteCount > 0 && <Badge tone="pending">{c.incompleteCount} incomplete</Badge>}
        </div>}
      </header>

      <div className="rx-ib__roles">
        <RoleCharge role="BCBA" staff={c.bcbaStaff} charge={c.bcbaCharge} />
        <RoleCharge role="RBT" staff={c.rbtStaff} charge={c.rbtCharge} />
      </div>
      {unassigned.length > 0 && (
        <p className="rx-ib__reason">BCBA or RBT role not set: {unassigned.map((s) => `${person(s.staffName)} (${plural(s.sessions, 'session')})`).join(', ')}</p>
      )}

      <footer className="rx-ib__bill-foot">
        {summaryOnly ? <span /> : (
          <button type="button" className="rx-st__action" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide session activity' : 'View session activity'}
          </button>
        )}
        <div className="rx-ib__client-total"><span>Client total</span><strong>{chargeOf(c.clientTotal, c.readyCount + c.billedCount)}</strong></div>
      </footer>

      {open && !summaryOnly && (
        <div id={detailId} className="rx-ib__detail">
          <SessionTable title="BCBA Session Activity" rows={c.sessions.filter((r) => r.role === 'BCBA')} tz={tz} />
          <SessionTable title="RBT Session Activity" rows={c.sessions.filter((r) => r.role === 'RBT')} tz={tz} />
          {c.sessions.some((r) => !r.role) && <SessionTable title="Sessions without a BCBA or RBT role" rows={c.sessions.filter((r) => !r.role)} tz={tz} />}
        </div>
      )}
    </article>
  );
}

function RoleCharge({ role, staff, charge }) {
  const billable = staff.reduce((t, s) => t + (s.readyCount ?? 0) + (s.billedCount ?? 0), 0);
  return (
    <section className={`rx-ib__role rx-ib__role--${role.toLowerCase()}`} aria-label={`${role} billing`}>
      <div className="rx-ib__role-head"><span className={`rx-st__role rx-st__role--${role.toLowerCase()}`}>{role}</span><span className="rx-ib__role-charge">{staff.length ? chargeOf(charge, billable) : '—'}</span></div>
      {staff.length === 0 ? <p className="rx-st__muted rx-ib__none">No {role} sessions in this period.</p> : (
        <dl className="rx-ib__clinicians">
          {staff.map((s) => (
            <div key={s.staffProfileId} className="rx-ib__clinician">
              <dt>{person(s.staffName)}</dt>
              <dd>
                <span>{s.hourlyRate != null ? rate(s.hourlyRate) : (s.hourlyRates?.length > 1 ? s.hourlyRates.map(rate).join(' / ') : rate(null))}</span>
                <span>{hm(s.workedMinutes)} worked</span>
                <span className="rx-ib__strong">{chargeOf(s.charge, (s.readyCount ?? 0) + (s.billedCount ?? 0))}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function SessionTable({ title, rows, tz }) {
  return (
    <div className="rx-ib__section">
      <h4 className="rx-ib__section-title">{title}</h4>
      {rows.length === 0 ? <p className="rx-st__muted rx-ib__none">No sessions in this period.</p> : (
        <div className="rx-ib__scroll">
          <table className="rx-ib__sessions" aria-label={title}>
            <thead>
              <tr>
                <th scope="col">Service date</th><th scope="col">Clinician</th><th scope="col">Role</th><th scope="col">Session start</th><th scope="col">Session end</th>
                <th scope="col" className="is-num">Worked time</th><th scope="col">Authorization</th><th scope="col">Billing code</th>
                <th scope="col" className="is-num">Hourly rate</th><th scope="col" className="is-num">Billable amount</th><th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const st = STATUS[r.billingStatus] ?? STATUS.INCOMPLETE;
                const incomplete = r.billingStatus === 'INCOMPLETE';
                return (
                  <tr key={r.sessionId}>
                    <td>{usDate(r.serviceDate)}</td>
                    <td>{person(r.staffName)}</td>
                    <td>{r.role ?? '—'}</td>
                    <td>{r.clockInAt ? formatTime(r.clockInAt, tz) : '—'}</td>
                    <td>{r.clockOutAt ? formatTime(r.clockOutAt, tz) : '—'}</td>
                    <td className="is-num">{hm(r.workedMinutes)}</td>
                    <td>{r.authorizationNumber || '—'}</td>
                    <td>{r.billingCode || '—'}</td>
                    <td className="is-num">{r.hourlyRate != null ? rate(r.hourlyRate) : '—'}</td>
                    <td className="is-num rx-ib__strong">{incomplete ? '—' : money(r.amount)}</td>
                    <td>
                      <Badge tone={st.tone}>{st.label}</Badge>
                      {incomplete && r.issues?.length > 0 && <div className="rx-ib__reason">{r.issues.map((x) => x.label).join(' · ')}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BillingSkeleton() {
  return (
    <div className="rx-ib__skeleton" aria-busy="true" aria-label="Loading billing">
      <div className="rx-ib__summary">{[0, 1, 2, 3].map((i) => <div key={i} className="rx-skel rx-cl__stat-skel" />)}</div>
      <div className="rx-skel" style={{ height: 240, borderRadius: 16 }} />
    </div>
  );
}

export default ClaimsRedesign;
