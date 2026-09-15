import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DatePickerProvider, addMonths, monthGrid, todayIso, spanDays } from '@aba1on1/date-picker';
import { DateInput, DateRangeInput } from './DateInput.jsx';
import { Modal } from './Modal.jsx';

/**
 * The ONE shared date picker (packages/date-picker) as the web app mounts it.
 * Covers: opening, selection, month/year navigation, Today in the business
 * timezone, Cancel/Apply, keyboard, disabled dates, ranges, MM/DD/YYYY display,
 * and that the form receives the same `YYYY-MM-DD` contract as before.
 */

let host; let root;
const mount = (el) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(el));
};
afterEach(() => {
  act(() => root?.unmount()); host?.remove(); root = undefined; host = undefined;
  vi.useRealTimers();
});

const q = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)];
const dialog = () => q('.dp-pop[role="dialog"]');
const gridLabels = () => qa('.dp-pop [role="grid"]').map((g) => g.getAttribute('aria-label'));
const cell = (iso) => q(`.dp-pop [data-iso="${iso}"]`);
const btn = (re, scope = document) => [...scope.querySelectorAll('button')].find((b) => re.test(b.getAttribute('aria-label') || b.textContent.trim()));
const click = (el) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const mousedown = (el) => act(() => { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
const key = (el, k, opts = {}) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts })); });
const type = (el, raw) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, raw);
  act(() => { el.dispatchEvent(new Event('input', { bubbles: true })); });
};
const openBtn = () => btn(/^Open calendar$/);

/** A controlled form field, like every call site (`set(k)` reads e.target.value). */
function SingleHarness({ initial = '', onValue, ...rest }) {
  const [v, setV] = useState(initial);
  return <DateInput value={v} onChange={(e) => { setV(e.target.value); onValue?.(e.target.value); }} aria-label="Visit date" {...rest} />;
}
function RangeHarness({ start = '', end = '', onValue, ...rest }) {
  const [r, setR] = useState({ start, end });
  return <DateRangeInput start={r.start} end={r.end} onChange={(next) => { setR(next); onValue?.(next); }} startLabel="From" endLabel="To" {...rest} />;
}

describe('date math', () => {
  it('always renders six weeks so the popover never changes height', () => {
    for (let m = 1; m <= 12; m += 1) expect(monthGrid(2026, m)).toHaveLength(42);
    const feb = monthGrid(2026, 2);
    expect(feb.filter((c) => c.inMonth)).toHaveLength(28);
    expect(feb[0].iso).toBe('2026-02-01'); // Feb 1 2026 is a Sunday
  });

  it('clamps month arithmetic and counts inclusive spans', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(spanDays('2026-09-06', '2026-09-12')).toBe(7);
  });

  it('Today is the business day in the organization timezone, not the browser zone', () => {
    const now = new Date('2026-09-13T05:30:00Z'); // 01:30 in New York, 22:30 (Sep 12) in Los Angeles
    expect(todayIso('America/New_York', now)).toBe('2026-09-13');
    expect(todayIso('America/Los_Angeles', now)).toBe('2026-09-12');
    expect(todayIso('Not/AZone', now)).toMatch(/^\d{4}-\d{2}-\d{2}$/); // falls back safely
  });
});

describe('DatePicker (DateInput)', () => {
  it('shows MM/DD/YYYY, opens a calendar on the selected month with the day selected and focused', () => {
    mount(<SingleHarness initial="2026-09-13" />);
    expect(q('input[aria-label="Visit date"]').value).toBe('09/13/2026');
    expect(dialog()).toBeNull();
    click(openBtn());
    expect(dialog()).toBeTruthy();
    expect(gridLabels()).toEqual(['September 2026']);
    expect(cell('2026-09-13').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(cell('2026-09-13'));
    expect(document.body.textContent).not.toMatch(/2026-09-13/);
  });

  it('selecting a day sends YYYY-MM-DD to the form, shows MM/DD/YYYY and closes', () => {
    const onValue = vi.fn();
    mount(<SingleHarness initial="2026-09-13" onValue={onValue} />);
    click(openBtn());
    click(cell('2026-09-24'));
    expect(onValue).toHaveBeenLastCalledWith('2026-09-24');
    expect(q('input[aria-label="Visit date"]').value).toBe('09/24/2026');
    expect(dialog()).toBeNull();
  });

  it('keeps the original onChange event contract exactly', () => {
    const onChange = vi.fn();
    mount(<DateInput value="2026-09-13" onChange={onChange} />);
    click(openBtn());
    click(cell('2026-09-14'));
    expect(onChange).toHaveBeenLastCalledWith({ target: { value: '2026-09-14' } });
  });

  it('previous / next month navigate, including across years', () => {
    mount(<SingleHarness initial="2026-12-10" />);
    click(openBtn());
    click(btn(/^Next month$/));
    expect(gridLabels()).toEqual(['January 2027']);
    click(btn(/^Previous month$/));
    click(btn(/^Previous month$/));
    expect(gridLabels()).toEqual(['November 2026']);
  });

  it('changes month and year through the header (days → months → years)', () => {
    const onValue = vi.fn();
    mount(<SingleHarness initial="2026-09-13" onValue={onValue} />);
    click(openBtn());
    click(btn(/choose month and year/));
    click(btn(/choose year/));
    expect(q('.dp-cal__title--static').textContent).toBe('2016 – 2027');
    click(btn(/^Previous years$/));
    click([...qa('.dp-zoom__item')].find((b) => b.textContent === '2015'));
    click(btn(/^August 2015$/));
    expect(gridLabels()).toEqual(['August 2015']);
    click(cell('2015-08-27'));
    expect(onValue).toHaveBeenLastCalledWith('2015-08-27');
  });

  it('Today selects the organization business day from the provider timezone', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-13T05:30:00Z'));
    const onValue = vi.fn();
    mount(<DatePickerProvider timeZone="America/Los_Angeles"><SingleHarness onValue={onValue} /></DatePickerProvider>);
    click(openBtn());
    expect(gridLabels()).toEqual(['September 2026']);
    expect(cell('2026-09-12').getAttribute('aria-current')).toBe('date');
    click(btn(/^Today$/));
    expect(onValue).toHaveBeenLastCalledWith('2026-09-12');
    expect(q('input[aria-label="Visit date"]').value).toBe('09/12/2026');
  });

  it('confirm mode: a pick is staged; Cancel discards and Apply commits', () => {
    const onValue = vi.fn();
    mount(<SingleHarness initial="2026-09-13" onValue={onValue} confirm />);
    click(openBtn());
    click(cell('2026-09-20'));
    expect(dialog()).toBeTruthy();
    expect(cell('2026-09-20').getAttribute('aria-selected')).toBe('true');
    expect(onValue).not.toHaveBeenCalled();
    click(btn(/^Cancel$/));
    expect(dialog()).toBeNull();
    expect(q('input[aria-label="Visit date"]').value).toBe('09/13/2026');

    click(openBtn());
    expect(cell('2026-09-13').getAttribute('aria-selected')).toBe('true'); // draft reset
    click(cell('2026-09-21'));
    click(btn(/^Apply$/));
    expect(onValue).toHaveBeenLastCalledWith('2026-09-21');
    expect(q('input[aria-label="Visit date"]').value).toBe('09/21/2026');
  });

  it('keyboard: arrows / Home / End / PageUp / PageDown move focus, Enter and Space select', () => {
    const onValue = vi.fn();
    mount(<SingleHarness initial="2026-09-13" onValue={onValue} />);
    click(openBtn());
    const at = () => document.activeElement.getAttribute('data-iso');
    key(document.activeElement, 'ArrowRight'); expect(at()).toBe('2026-09-14');
    key(document.activeElement, 'ArrowDown'); expect(at()).toBe('2026-09-21');
    key(document.activeElement, 'ArrowLeft'); expect(at()).toBe('2026-09-20');
    key(document.activeElement, 'ArrowUp'); expect(at()).toBe('2026-09-13');
    key(document.activeElement, 'End'); expect(at()).toBe('2026-09-19');
    key(document.activeElement, 'Home'); expect(at()).toBe('2026-09-13');
    key(document.activeElement, 'PageDown'); expect(at()).toBe('2026-10-13');
    expect(gridLabels()).toEqual(['October 2026']);
    key(document.activeElement, 'PageUp', { shiftKey: true }); expect(at()).toBe('2025-10-13');
    key(document.activeElement, 'Enter');
    expect(onValue).toHaveBeenLastCalledWith('2025-10-13');
    expect(dialog()).toBeNull();

    click(openBtn());
    key(document.activeElement, 'ArrowRight');
    key(document.activeElement, ' ');
    expect(onValue).toHaveBeenLastCalledWith('2025-10-14');
  });

  it('ArrowDown in the field opens the calendar; Escape closes it and returns focus', () => {
    const onValue = vi.fn();
    mount(<SingleHarness initial="2026-09-13" onValue={onValue} />);
    const field = q('input[aria-label="Visit date"]');
    field.focus();
    key(field, 'ArrowDown');
    expect(dialog()).toBeTruthy();
    key(document.activeElement, 'Escape');
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(field);
    expect(onValue).not.toHaveBeenCalled();
  });

  it('Escape inside a modal closes only the calendar, not the modal', () => {
    const onClose = vi.fn();
    mount(<Modal open onClose={onClose} title="Edit"><SingleHarness initial="2026-09-13" /></Modal>);
    click(openBtn());
    key(document.activeElement, 'Escape');
    expect(dialog()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('clicking outside closes without changing the value', () => {
    const onValue = vi.fn();
    mount(<SingleHarness initial="2026-09-13" onValue={onValue} />);
    click(openBtn());
    mousedown(document.body);
    expect(dialog()).toBeNull();
    expect(onValue).not.toHaveBeenCalled();
  });

  it('disabled dates (min / max / predicate) cannot be picked; out-of-range typing is flagged, not sent', () => {
    const onValue = vi.fn();
    const weekend = (iso) => [0, 6].includes(new Date(`${iso}T00:00:00Z`).getUTCDay());
    mount(<SingleHarness initial="2026-09-15" onValue={onValue} min="2026-09-10" max="2026-09-25" isDateDisabled={weekend} />);
    click(openBtn());
    expect(cell('2026-09-09').getAttribute('aria-disabled')).toBe('true');
    expect(cell('2026-09-26').getAttribute('aria-disabled')).toBe('true');
    expect(cell('2026-09-19').getAttribute('aria-disabled')).toBe('true'); // Saturday
    click(cell('2026-09-09'));
    click(cell('2026-09-19'));
    expect(onValue).not.toHaveBeenCalled();
    expect(btn(/^Previous month$/).disabled).toBe(true);
    expect(btn(/^Next month$/).disabled).toBe(true);
    click(cell('2026-09-16'));
    expect(onValue).toHaveBeenLastCalledWith('2026-09-16');

    type(q('input[aria-label="Visit date"]'), '10012026');
    expect(onValue).toHaveBeenLastCalledWith('');
    expect(q('.dp-msg').textContent).toBe('Choose a date on or before 09/25/2026.');
    expect(q('input[aria-label="Visit date"]').getAttribute('aria-invalid')).toBe('true');
  });

  it('outside-month days are shown muted and selecting one moves to that month', () => {
    const onValue = vi.fn();
    mount(<SingleHarness initial="2026-09-13" onValue={onValue} confirm />);
    click(openBtn());
    const outside = cell('2026-10-01');
    expect(outside.className).toMatch(/is-outside/);
    click(outside);
    expect(gridLabels()).toEqual(['October 2026']);
    expect(cell('2026-10-01').className).not.toMatch(/is-outside/);
  });

  it('Clear empties the field', () => {
    const onValue = vi.fn();
    mount(<SingleHarness initial="2026-09-13" onValue={onValue} />);
    click(openBtn());
    click(btn(/^Clear$/));
    expect(onValue).toHaveBeenLastCalledWith('');
    expect(q('input[aria-label="Visit date"]').value).toBe('');
  });
});

describe('DateRangePicker (DateRangeInput)', () => {
  const from = () => q('input[aria-label="From"]');
  const to = () => q('input[aria-label="To"]');

  it('shows both ends as MM/DD/YYYY and opens two months', () => {
    mount(<RangeHarness start="2026-08-31" end="2026-09-06" />);
    expect(from().value).toBe('08/31/2026');
    expect(to().value).toBe('09/06/2026');
    click(openBtn());
    expect(gridLabels()).toEqual(['August 2026', 'September 2026']);
    expect(cell('2026-08-31').className).toMatch(/is-range-start/);
    expect(cell('2026-09-06').className).toMatch(/is-range-end/);
    expect(cell('2026-09-03').className).toMatch(/is-in-range/);
    expect(q('.dp-foot__summary').textContent).toBe('08/31/2026 – 09/06/2026 · 7 days');
  });

  it('start then end, previewed, committed only by Apply', () => {
    const onValue = vi.fn();
    mount(<RangeHarness start="2026-09-01" end="2026-09-02" onValue={onValue} />);
    click(openBtn());
    click(cell('2026-09-07'));
    expect(btn(/^Apply$/).disabled).toBe(true); // half a range can't be applied
    expect(q('.dp-foot__summary').textContent).toBe('09/07/2026 – select an end date');
    act(() => { cell('2026-09-10').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    expect(cell('2026-09-09').className).toMatch(/is-in-range/); // hover preview
    click(cell('2026-09-13'));
    expect(onValue).not.toHaveBeenCalled();
    click(btn(/^Apply$/));
    expect(onValue).toHaveBeenLastCalledWith({ start: '2026-09-07', end: '2026-09-13' });
    expect(from().value).toBe('09/07/2026');
    expect(to().value).toBe('09/13/2026');
    expect(dialog()).toBeNull();
  });

  it('prevents an inverted range: an earlier second click restarts the range', () => {
    const onValue = vi.fn();
    mount(<RangeHarness onValue={onValue} today="2026-09-13" />);
    click(openBtn());
    click(cell('2026-09-20'));
    click(cell('2026-09-15'));
    expect(cell('2026-09-15').className).toMatch(/is-range-start/);
    expect(btn(/^Apply$/).disabled).toBe(true);
    click(cell('2026-09-18'));
    click(btn(/^Apply$/));
    expect(onValue).toHaveBeenLastCalledWith({ start: '2026-09-15', end: '2026-09-18' });
  });

  it('typed inverted range is flagged and the bad end is not sent', () => {
    const onValue = vi.fn();
    mount(<RangeHarness start="2026-09-10" end="2026-09-12" onValue={onValue} />);
    type(to(), '09052026');
    expect(onValue).toHaveBeenLastCalledWith({ start: '2026-09-10', end: '' });
    expect(q('.dp-msg').textContent).toBe('End date must be on or after the start date.');
    type(to(), '09152026');
    expect(onValue).toHaveBeenLastCalledWith({ start: '2026-09-10', end: '2026-09-15' });
    expect(q('.dp-msg')).toBeNull();
  });

  it('Cancel discards; Clear + Apply empties the range', () => {
    const onValue = vi.fn();
    mount(<RangeHarness start="2026-09-01" end="2026-09-05" onValue={onValue} />);
    click(openBtn());
    click(cell('2026-09-20'));
    click(btn(/^Cancel$/));
    expect(onValue).not.toHaveBeenCalled();
    expect(from().value).toBe('09/01/2026');

    click(openBtn());
    click(btn(/^Clear$/));
    expect(q('.dp-foot__summary').textContent).toBe('Select a start date');
    click(btn(/^Apply$/));
    expect(onValue).toHaveBeenLastCalledWith({ start: '', end: '' });
    expect(from().value).toBe('');
    expect(to().value).toBe('');
  });

  it('respects min / max in the calendar', () => {
    mount(<RangeHarness start="2026-09-10" end="2026-09-12" max="2026-09-13" />);
    click(openBtn());
    expect(cell('2026-09-14').getAttribute('aria-disabled')).toBe('true');
    expect(btn(/^Next month$/).disabled).toBe(true);
  });
});
