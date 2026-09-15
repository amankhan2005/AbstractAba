import { useId, useRef, useState } from 'react';
import { Calendar } from './Calendar.jsx';
import { Popover } from './Popover.jsx';
import { CalendarIcon } from './icons.jsx';
import { useDatePickerTimeZone } from './context.js';
import { useMaskedDate } from './useMaskedDate.js';
import { dayIsDisabled, isoToDisplay, todayIso } from './dateMath.js';

/**
 * DatePicker — the ONE single-date control for Abstract ABA (tenant web + console).
 *
 * The user always sees and types MM/DD/YYYY, on every OS/browser/locale; the
 * calendar is our own (never the browser's locale-formatted native picker).
 *
 * Contract (unchanged from the original DateInput, so every form keeps working):
 *   - `value`    : internal `YYYY-MM-DD` (or ''), exactly what forms store/send.
 *   - `onChange` : `onChange({ target: { value } })` with a valid, permitted
 *                  `YYYY-MM-DD`, or '' while empty/incomplete/invalid.
 *
 * Behaviour: typing with a digit mask; calendar button (or ↓ in the field)
 * opens the calendar; picking a day commits and closes. With `confirm` the
 * pick is staged and committed by Apply (Cancel discards). "Today" is the
 * business day in the organization timezone when one is provided.
 */
export function DatePicker({
  value,
  onChange,
  id,
  name,
  disabled = false,
  required = false,
  error = false,
  min,
  max,
  isDateDisabled,
  confirm = false,
  timeZone,
  today: todayProp,
  weekStartsOn = 0,
  placeholder = 'MM/DD/YYYY',
  fieldClassName = '',
  errorClassName = '',
  'aria-label': ariaLabel,
  'aria-describedby': describedBy,
}) {
  const ctxZone = useDatePickerTimeZone();
  const anchorRef = useRef(null);
  const inputRef = useRef(null);
  const openerRef = useRef(null);
  const msgId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const bounds = { min, max, isDateDisabled };

  const seg = useMaskedDate({
    value,
    emit: (iso) => onChange?.({ target: name ? { value: iso, name } : { value: iso } }),
    check: (iso) => boundsMessage(iso, bounds),
  });

  const today = open ? (todayProp || todayIso(timeZone ?? ctxZone)) : '';
  const current = (value ?? '').slice(0, 10);

  function openCalendar(opener) {
    if (disabled) return;
    openerRef.current = opener;
    setDraft(current);
    setOpen(true);
  }
  function close({ restoreFocus = true } = {}) {
    setOpen(false);
    if (restoreFocus) (openerRef.current || inputRef.current)?.focus();
  }
  function choose(iso) {
    if (confirm) { setDraft(iso); return; }
    seg.commit(iso);
    close();
  }
  function onFieldKey(e) {
    if (e.key === 'ArrowDown' && !open) { e.preventDefault(); openCalendar(e.currentTarget); }
  }

  const shown = confirm ? draft : current;
  const message = seg.error;
  const invalid = error || Boolean(message);

  return (
    <div className="dp-root">
      <div
        ref={anchorRef}
        className={`dp-field ${fieldClassName}${invalid ? ` dp-field--error ${errorClassName}` : ''}${disabled ? ' is-disabled' : ''}${open ? ' is-open' : ''}`.trim()}
      >
        <input
          ref={inputRef}
          id={id}
          className="dp-field__input"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-invalid={invalid || undefined}
          aria-describedby={[describedBy, message ? msgId : null].filter(Boolean).join(' ') || undefined}
          value={seg.text}
          disabled={disabled}
          required={required}
          onChange={seg.onTextChange}
          onKeyDown={onFieldKey}
        />
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
        {name && <input type="hidden" name={name} value={current} />}
      </div>
      {message && <div id={msgId} className="dp-msg" role="alert">{message}</div>}

      {open && (
        <Popover anchorRef={anchorRef} onClose={close} label={`Choose ${ariaLabel ? ariaLabel.toLowerCase() : 'date'}`}>
          <Calendar
            mode="single"
            value={shown}
            onSelect={choose}
            min={min}
            max={max}
            isDateDisabled={isDateDisabled}
            today={today}
            weekStartsOn={weekStartsOn}
            autoFocus
          />
          <div className="dp-foot">
            <div className="dp-foot__left">
              <button type="button" className="dp-link" onClick={() => choose(today)} disabled={dayIsDisabled(today, bounds)}>Today</button>
              {shown && <button type="button" className="dp-link dp-link--muted" onClick={() => choose('')}>Clear</button>}
            </div>
            {confirm && (
              <div className="dp-foot__right">
                <button type="button" className="dp-btn dp-btn--ghost" onClick={() => close()}>Cancel</button>
                <button type="button" className="dp-btn dp-btn--primary" onClick={() => { seg.commit(draft); close(); }}>Apply</button>
              </div>
            )}
          </div>
        </Popover>
      )}
    </div>
  );
}

export function boundsMessage(iso, { min, max, isDateDisabled } = {}) {
  if (min && iso < min) return `Choose a date on or after ${isoToDisplay(min)}.`;
  if (max && iso > max) return `Choose a date on or before ${isoToDisplay(max)}.`;
  if (isDateDisabled?.(iso)) return 'That date is not available.';
  return '';
}

export default DatePicker;
