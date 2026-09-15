import { useEffect, useRef, useState } from 'react';
import { displayToIso, isoToDisplay, maskDisplay } from './dateMath.js';

/**
 * State for one typed MM/DD/YYYY segment bound to an internal `YYYY-MM-DD`
 * value. Typing emits the ISO value once it is a complete, real, permitted
 * date and '' otherwise (incomplete is quiet; complete-but-invalid is flagged).
 *
 * The visible text re-syncs only when `value` changes EXTERNALLY — never on the
 * echo of a value this segment just emitted — so typing is never clobbered.
 *
 * `check(iso)` returns an error message for a real date the field must not
 * accept (outside min/max, disabled, end before start), or '' when allowed.
 */
export function useMaskedDate({ value, emit, check }) {
  const [text, setText] = useState(() => isoToDisplay(value));
  const [error, setError] = useState('');
  const lastEmit = useRef(value ?? '');

  useEffect(() => {
    const incoming = value ?? '';
    if (incoming !== lastEmit.current) {
      setText(isoToDisplay(incoming));
      setError('');
      lastEmit.current = incoming;
    }
  }, [value]);

  function send(iso) {
    lastEmit.current = iso;
    emit(iso);
  }

  function onTextChange(e) {
    const masked = maskDisplay(e.target.value);
    setText(masked);
    if (masked === '') { setError(''); send(''); return; }
    const iso = displayToIso(masked);
    if (!iso) {
      setError(masked.length === 10 ? 'Enter a valid date (MM/DD/YYYY).' : '');
      send('');
      return;
    }
    const problem = check ? check(iso) : '';
    setError(problem);
    send(problem ? '' : iso);
  }

  /** Show a value chosen in the calendar without emitting (caller emits). */
  function sync(iso) {
    setText(isoToDisplay(iso));
    setError('');
    lastEmit.current = iso || '';
  }

  /** Programmatic commit from the calendar. */
  function commit(iso) {
    sync(iso);
    emit(iso || '');
  }

  return { text, error, onTextChange, commit, sync };
}
