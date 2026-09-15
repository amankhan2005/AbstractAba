import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  MONTH_NAMES, MONTH_SHORT, WEEKDAY_SHORT, addDays, addMonths, clampIso, dayIsDisabled,
  daysInMonth, longLabel, monthGrid, parseIso, toIso, todayIso, weekday,
} from './dateMath.js';
import { ChevronLeft, ChevronRight, ChevronDown } from './icons.jsx';

const monthIndex = (y, m) => y * 12 + (m - 1);
const fromIndex = (idx) => ({ y: Math.floor(idx / 12), m: (idx % 12) + 1 });

/**
 * Calendar grid shared by DatePicker and DateRangePicker.
 *
 * Views: days → months → years (click the header title to zoom out).
 * Keyboard (days, WAI-ARIA date-picker pattern): ←/→ ±1 day, ↑/↓ ±1 week,
 * Home/End start/end of week, PageUp/PageDown ±1 month (with Shift ±1 year),
 * Enter/Space select. One roving tab stop per grid.
 *
 * Purely presentational over `YYYY-MM-DD` strings: it never converts to an
 * instant, so no timezone can move a day.
 */
export function Calendar({
  mode = 'single',
  value = '',
  rangeStart = '',
  rangeEnd = '',
  onSelect,
  min,
  max,
  isDateDisabled,
  today: todayProp,
  months = 1,
  weekStartsOn = 0,
  autoFocus = false,
}) {
  const today = todayProp || todayIso();
  const anchor = (mode === 'range' ? (rangeEnd && !rangeStart ? rangeEnd : rangeStart) : value) || '';
  const initialFocus = clampIso(parseIso(anchor) ? anchor.slice(0, 10) : today, min, max);
  const [focused, setFocused] = useState(initialFocus);
  const [display, setDisplay] = useState(() => {
    const p = parseIso(initialFocus);
    return { y: p.y, m: p.m };
  });
  const [view, setView] = useState('days');
  const [hover, setHover] = useState('');
  const rootRef = useRef(null);
  const pendingFocus = useRef(autoFocus);

  const bounds = useMemo(() => ({ min, max, isDateDisabled }), [min, max, isDateDisabled]);
  const firstIdx = monthIndex(display.y, display.m);

  const ensureVisible = useCallback((iso) => {
    const p = parseIso(iso);
    if (!p) return;
    const idx = monthIndex(p.y, p.m);
    setDisplay((d) => {
      const first = monthIndex(d.y, d.m);
      if (idx < first) return { y: p.y, m: p.m };
      if (idx > first + months - 1) return fromIndex(idx - (months - 1));
      return d;
    });
  }, [months]);

  // Follow EXTERNAL anchor changes (e.g. "Today" in a confirm-mode footer).
  const lastAnchor = useRef(anchor);
  useEffect(() => {
    if (anchor === lastAnchor.current) return;
    lastAnchor.current = anchor;
    if (parseIso(anchor)) {
      const iso = anchor.slice(0, 10);
      setFocused(iso);
      ensureVisible(iso);
      setView('days');
    }
  }, [anchor, ensureVisible]);

  // The one tabbable day: the focused day when on screen, else the 1st shown.
  const focusedP = parseIso(focused);
  const focusedIdx = focusedP ? monthIndex(focusedP.y, focusedP.m) : -1;
  const focusVisible = focusedIdx >= firstIdx && focusedIdx <= firstIdx + months - 1;
  const tabIso = focusVisible ? focused : clampIso(toIso(display.y, display.m, 1), min, max);

  useLayoutEffect(() => {
    if (!pendingFocus.current || !rootRef.current) return;
    pendingFocus.current = false;
    const target = rootRef.current.querySelector('[data-focus-target="true"]');
    target?.focus();
  });

  function moveFocus(iso) {
    const next = clampIso(iso, min, max);
    pendingFocus.current = true;
    setFocused(next);
    ensureVisible(next);
  }

  function select(iso) {
    if (dayIsDisabled(iso, bounds)) return;
    setFocused(iso);
    ensureVisible(iso);
    setHover('');
    onSelect?.(iso);
  }

  function onGridKey(e) {
    const from = focusVisible ? focused : tabIso;
    const dow = (weekday(from) - weekStartsOn + 7) % 7;
    const map = {
      ArrowLeft: () => addDays(from, -1),
      ArrowRight: () => addDays(from, 1),
      ArrowUp: () => addDays(from, -7),
      ArrowDown: () => addDays(from, 7),
      Home: () => addDays(from, -dow),
      End: () => addDays(from, 6 - dow),
      PageUp: () => addMonths(from, e.shiftKey ? -12 : -1),
      PageDown: () => addMonths(from, e.shiftKey ? 12 : 1),
    };
    if (map[e.key]) {
      e.preventDefault();
      moveFocus(map[e.key]());
      if (mode === 'range') setHover(clampIso(map[e.key](), min, max));
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select(from);
    }
  }

  // Header navigation per view.
  const step = view === 'days' ? 1 : view === 'months' ? 12 : 144;
  const minP = parseIso(min);
  const maxP = parseIso(max);
  const minIdx = minP ? monthIndex(minP.y, minP.m) : -Infinity;
  const maxIdx = maxP ? monthIndex(maxP.y, maxP.m) : Infinity;
  const yearPageStart = display.y - (((display.y % 12) + 12) % 12);
  let prevDisabled;
  let nextDisabled;
  if (view === 'days') { prevDisabled = firstIdx <= minIdx; nextDisabled = firstIdx + months - 1 >= maxIdx; }
  else if (view === 'months') { prevDisabled = minP ? display.y <= minP.y : false; nextDisabled = maxP ? display.y >= maxP.y : false; }
  else { prevDisabled = minP ? yearPageStart <= minP.y : false; nextDisabled = maxP ? yearPageStart + 11 >= maxP.y : false; }

  function shift(dir) {
    const delta = dir * step;
    if (view === 'days') {
      setDisplay(fromIndex(firstIdx + delta));
      setFocused((f) => clampIso(addMonths(f, delta), min, max));
    } else {
      setDisplay((d) => fromIndex(monthIndex(d.y, d.m) + delta));
    }
  }

  const lastShown = fromIndex(firstIdx + months - 1);
  let title;
  if (view === 'days') {
    title = months === 1
      ? `${MONTH_NAMES[display.m - 1]} ${display.y}`
      : display.y === lastShown.y
        ? `${MONTH_NAMES[display.m - 1]} – ${MONTH_NAMES[lastShown.m - 1]} ${display.y}`
        : `${MONTH_SHORT[display.m - 1]} ${display.y} – ${MONTH_SHORT[lastShown.m - 1]} ${lastShown.y}`;
  } else if (view === 'months') {
    title = String(display.y);
  } else {
    title = `${yearPageStart} – ${yearPageStart + 11}`;
  }
  const unit = view === 'days' ? 'month' : view === 'months' ? 'year' : 'years';

  function zoomOut() {
    pendingFocus.current = true;
    setView(view === 'days' ? 'months' : 'years');
  }
  function chooseMonth(m) {
    const day = Math.min(focusedP?.d ?? 1, daysInMonth(display.y, m));
    const iso = clampIso(toIso(display.y, m, day), min, max);
    setDisplay({ y: display.y, m });
    setFocused(iso);
    pendingFocus.current = true;
    setView('days');
  }
  function chooseYear(y) {
    setDisplay((d) => ({ y, m: d.m }));
    pendingFocus.current = true;
    setView('months');
  }

  const panels = [];
  for (let i = 0; i < months; i += 1) panels.push(fromIndex(firstIdx + i));

  const rangeSelectingEnd = mode === 'range' && Boolean(rangeStart) && !rangeEnd;
  const previewEnd = rangeSelectingEnd && hover && hover >= rangeStart ? hover : '';

  return (
    <div className="dp-cal" ref={rootRef}>
      <div className="dp-cal__head">
        <button type="button" className="dp-iconbtn" onClick={() => shift(-1)} disabled={prevDisabled} aria-label={`Previous ${unit}`}>
          <ChevronLeft />
        </button>
        {view === 'years' ? (
          <div className="dp-cal__title dp-cal__title--static" aria-live="polite">{title}</div>
        ) : (
          <button
            type="button"
            className="dp-cal__title"
            onClick={zoomOut}
            aria-live="polite"
            aria-label={`${title}, choose ${view === 'days' ? 'month and year' : 'year'}`}
          >
            {title}
            <ChevronDown />
          </button>
        )}
        <button type="button" className="dp-iconbtn" onClick={() => shift(1)} disabled={nextDisabled} aria-label={`Next ${unit}`}>
          <ChevronRight />
        </button>
      </div>

      {view === 'days' && (
        <div className={`dp-cal__panels${months > 1 ? ' dp-cal__panels--multi' : ''}`}>
          {panels.map((p) => (
            <MonthPanel
              key={`${p.y}-${p.m}`}
              year={p.y}
              month={p.m}
              caption={months > 1}
              hideOutside={months > 1}
              weekStartsOn={weekStartsOn}
              tabIso={tabIso}
              today={today}
              mode={mode}
              value={value}
              rangeStart={rangeStart}
              rangeEnd={rangeEnd || previewEnd}
              previewing={Boolean(previewEnd)}
              bounds={bounds}
              onSelect={select}
              onHover={rangeSelectingEnd ? setHover : undefined}
              onKeyDown={onGridKey}
            />
          ))}
        </div>
      )}

      {view === 'months' && (
        <div className="dp-zoom" role="group" aria-label={`Months of ${display.y}`} onKeyDown={(e) => arrowNav(e, 3)}>
          {MONTH_SHORT.map((label, i) => {
            const m = i + 1;
            const idx = monthIndex(display.y, m);
            const disabled = idx < minIdx || idx > maxIdx;
            const current = m === display.m;
            return (
              <button
                key={label}
                type="button"
                className={`dp-zoom__item${current ? ' is-current' : ''}`}
                disabled={disabled}
                aria-pressed={current}
                aria-label={`${MONTH_NAMES[i]} ${display.y}`}
                data-focus-target={current ? 'true' : undefined}
                onClick={() => chooseMonth(m)}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {view === 'years' && (
        <div className="dp-zoom" role="group" aria-label="Years" onKeyDown={(e) => arrowNav(e, 3)}>
          {Array.from({ length: 12 }, (_, i) => yearPageStart + i).map((y) => {
            const disabled = (minP && y < minP.y) || (maxP && y > maxP.y);
            const current = y === display.y;
            return (
              <button
                key={y}
                type="button"
                className={`dp-zoom__item${current ? ' is-current' : ''}`}
                disabled={Boolean(disabled)}
                aria-pressed={current}
                data-focus-target={current ? 'true' : undefined}
                onClick={() => chooseYear(y)}
              >
                {y}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Arrow-key movement among the month/year buttons (3 columns). */
function arrowNav(e, cols) {
  const deltas = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols };
  if (!(e.key in deltas)) return;
  const items = [...e.currentTarget.querySelectorAll('button:not([disabled])')];
  const i = items.indexOf(document.activeElement);
  if (i === -1) return;
  e.preventDefault();
  const next = items[Math.max(0, Math.min(items.length - 1, i + deltas[e.key]))];
  next?.focus();
}

function MonthPanel({
  year, month, caption, hideOutside, weekStartsOn, tabIso, today, mode, value,
  rangeStart, rangeEnd, previewing, bounds, onSelect, onHover, onKeyDown,
}) {
  const cells = useMemo(() => monthGrid(year, month, weekStartsOn), [year, month, weekStartsOn]);
  const weekdays = useMemo(() => WEEKDAY_SHORT.map((_, i) => WEEKDAY_SHORT[(i + weekStartsOn) % 7]), [weekStartsOn]);
  const label = `${MONTH_NAMES[month - 1]} ${year}`;
  const rows = [];
  for (let r = 0; r < 6; r += 1) rows.push(cells.slice(r * 7, r * 7 + 7));

  return (
    <div className="dp-month">
      {caption && <div className="dp-month__caption" aria-hidden="true">{label}</div>}
      <div role="grid" aria-label={label} className="dp-grid" onKeyDown={onKeyDown} onMouseLeave={onHover ? () => onHover('') : undefined}>
        <div role="row" className="dp-grid__row dp-grid__row--head">
          {weekdays.map((w) => <div key={w} role="columnheader" className="dp-grid__wd" aria-label={w}>{w}</div>)}
        </div>
        {rows.map((row) => (
          <div role="row" className="dp-grid__row" key={row[0].iso}>
            {row.map((c) => {
              if (hideOutside && !c.inMonth) return <div key={c.iso} role="gridcell" className="dp-day dp-day--blank" aria-hidden="true" />;
              const disabled = dayIsDisabled(c.iso, bounds);
              const isToday = c.iso === today;
              let selected = false;
              let cls = 'dp-day';
              if (mode === 'range') {
                const isStart = Boolean(rangeStart) && c.iso === rangeStart;
                const isEnd = Boolean(rangeEnd) && c.iso === rangeEnd;
                const inside = Boolean(rangeStart && rangeEnd) && c.iso > rangeStart && c.iso < rangeEnd;
                selected = isStart || (isEnd && !previewing);
                if (isStart) cls += ' is-range-start';
                if (isEnd) cls += ` is-range-end${previewing ? ' is-preview' : ''}`;
                if (inside) cls += ` is-in-range${previewing ? ' is-preview' : ''}`;
                if (rangeStart && rangeEnd && rangeStart !== rangeEnd) cls += ' has-range';
              } else {
                selected = Boolean(value) && c.iso === value.slice(0, 10);
              }
              if (selected) cls += ' is-selected';
              if (isToday) cls += ' is-today';
              if (!c.inMonth) cls += ' is-outside';
              if (disabled) cls += ' is-disabled';
              const focusTarget = c.iso === tabIso;
              return (
                <div
                  key={c.iso}
                  role="gridcell"
                  className={cls}
                  data-iso={c.iso}
                  data-focus-target={focusTarget ? 'true' : undefined}
                  tabIndex={focusTarget ? 0 : -1}
                  aria-selected={selected}
                  aria-disabled={disabled || undefined}
                  aria-current={isToday ? 'date' : undefined}
                  aria-label={`${longLabel(c.iso)}${isToday ? ', today' : ''}`}
                  onClick={() => onSelect(c.iso)}
                  onMouseEnter={onHover && !disabled ? () => onHover(c.iso) : undefined}
                >
                  <span className="dp-day__num">{c.day}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
