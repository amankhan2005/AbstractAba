import { useId, useRef, useState } from 'react';
import { Calendar } from './Calendar.jsx';
import { Popover } from './Popover.jsx';
import { ArrowRight, CalendarIcon } from './icons.jsx';
import { useDatePickerTimeZone } from './context.js';
import { useMaskedDate } from './useMaskedDate.js';
import { boundsMessage } from './DatePicker.jsx';
import { dayIsDisabled, isoToDisplay, spanDays, todayIso } from './dateMath.js';

const NARROW_QUERY = '(max-width: 680px)';

/**
 * DateRangePicker — the ONE start/end date control, same design language as
 * DatePicker. Both ends are typed as MM/DD/YYYY or picked on a two-month
 * calendar (one month on phones): first click sets the start, second the end,
 * with a live preview of the span. The range is staged and committed by Apply;
 * Cancel discards, Clear empties.
 *
 * Contract: `start` / `end` are `YYYY-MM-DD` (or ''); `onChange({ start, end })`.
 * An end before the start can never be committed — the calendar reorders the
 * pick, and a typed inverted range is flagged and not emitted.
 */
export function DateRangePicker({
  start,
  end,
  onChange,
  id,
  disabled = false,
  required = false,
  error = false,
  min,
  max,
  isDateDisabled,
  timeZone,
  today: todayProp,
  weekStartsOn = 0,
  months,
  startLabel = 'Start date',
  endLabel = 'End date',
  fieldClassName = '',
  errorClassName = '',
}) {
  const ctxZone = useDatePickerTimeZone();
  const anchorRef = useRef(null);
  const startRef = useRef(null);
  const openerRef = useRef(null);
  const msgId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ start: '', end: '' });
  const [narrow, setNarrow] = useState(false);
  const bounds = { min, max, isDateDisabled };
  const curStart = (start ?? '').slice(0, 10);
  const curEnd = (end ?? '').slice(0, 10);

  const startSeg = useMaskedDate({
    value: curStart,
    emit: (iso) => onChange?.({ start: iso, end: curEnd }),
    check: (iso) => boundsMessage(iso, bounds) || (curEnd && iso > curEnd ? 'Start date must be on or before the end date.' : ''),
  });
  const endSeg = useMaskedDate({
    value: curEnd,
    emit: (iso) => onChange?.({ start: curStart, end: iso }),
    check: (iso) => boundsMessage(iso, bounds) || (curStart && iso < curStart ? 'End date must be on or after the start date.' : ''),
  });

  const today = open ? (todayProp || todayIso(timeZone ?? ctxZone)) : '';

  function openCalendar(opener) {
    if (disabled) return;
    openerRef.current = opener;
    setDraft({ start: curStart, end: curEnd && curStart && curEnd >= curStart ? curEnd : '' });
    setNarrow(typeof window !== 'undefined' && Boolean(window.matchMedia?.(NARROW_QUERY).matches));
    setOpen(true);
  }
  function close({ restoreFocus = true } = {}) {
    setOpen(false);
    if (restoreFocus) (openerRef.current || startRef.current)?.focus();
  }
  function pick(iso) {
    setDraft((d) => {
      if (!d.start || d.end || iso < d.start) return { start: iso, end: '' };
      return { start: d.start, end: iso };
    });
  }
  function apply() {
    startSeg.sync(draft.start);
    endSeg.sync(draft.end);
    onChange?.({ start: draft.start, end: draft.end });
    close();
  }
  function onFieldKey(e) {
    if (e.key === 'ArrowDown' && !open) { e.preventDefault(); openCalendar(e.currentTarget); }
  }

  const message = startSeg.error || endSeg.error;
  const invalid = error || Boolean(message);
  const partial = Boolean(draft.start) !== Boolean(draft.end);
  let summary;
  if (!draft.start) summary = 'Select a start date';
  else if (!draft.end) summary = `${isoToDisplay(draft.start)} – select an end date`;
  else {
    const n = spanDays(draft.start, draft.end);
    summary = `${isoToDisplay(draft.start)} – ${isoToDisplay(draft.end)} · ${n} day${n === 1 ? '' : 's'}`;
  }

  const fieldProps = (seg, label, part, ref) => ({
    ref,
    className: 'dp-field__input dp-field__input--part',
    type: 'text',
    inputMode: 'numeric',
    autoComplete: 'off',
    placeholder: 'MM/DD/YYYY',
    'aria-label': label,
    'aria-invalid': invalid || undefined,
    'aria-describedby': message ? msgId : undefined,
    'data-dp-part': part,
    value: seg.text,
    disabled,
    required,
    onChange: seg.onTextChange,
    onKeyDown: onFieldKey,
  });

  return (
    <div className="dp-root">
      <div
        ref={anchorRef}
        role="group"
        aria-label={`${startLabel} to ${endLabel}`}
        className={`dp-field dp-field--range ${fieldClassName}${invalid ? ` dp-field--error ${errorClassName}` : ''}${disabled ? ' is-disabled' : ''}${open ? ' is-open' : ''}`.trim()}
      >
        <input id={id} {...fieldProps(startSeg, startLabel, 'start', startRef)} />
        <div className="dp-field__sep" aria-hidden="true"><ArrowRight /></div>
        <input {...fieldProps(endSeg, endLabel, 'end')} />
        <button
          type="button"
          className="dp-field__btn"
          onClick={(e) => (open ? close() : openCalendar(e.currentTarget))}
          disabled={disabled}
          aria-label={open ? 'Close calendar' : 'Open calendar'}
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <CalendarIcon />
        </button>
      </div>
      {message && <div id={msgId} className="dp-msg" role="alert">{message}</div>}

      {open && (
        <Popover anchorRef={anchorRef} onClose={close} label="Choose date range" wide={(months ?? (narrow ? 1 : 2)) > 1}>
          <Calendar
            mode="range"
            rangeStart={draft.start}
            rangeEnd={draft.end}
            onSelect={pick}
            min={min}
            max={max}
            isDateDisabled={isDateDisabled}
            today={today}
            weekStartsOn={weekStartsOn}
            months={months ?? (narrow ? 1 : 2)}
            autoFocus
          />
          <div className="dp-foot dp-foot--range">
            <div className="dp-foot__summary" aria-live="polite">{summary}</div>
            <div className="dp-foot__row">
              <div className="dp-foot__left">
                <button type="button" className="dp-link" onClick={() => pick(today)} disabled={dayIsDisabled(today, bounds)}>Today</button>
                {(draft.start || draft.end) && (
                  <button type="button" className="dp-link dp-link--muted" onClick={() => setDraft({ start: '', end: '' })}>Clear</button>
                )}
              </div>
              <div className="dp-foot__right">
                <button type="button" className="dp-btn dp-btn--ghost" onClick={() => close()}>Cancel</button>
                <button type="button" className="dp-btn dp-btn--primary" onClick={apply} disabled={partial}>Apply</button>
              </div>
            </div>
          </div>
        </Popover>
      )}
    </div>
  );
}

export default DateRangePicker;
