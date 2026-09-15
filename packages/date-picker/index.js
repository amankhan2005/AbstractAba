/**
 * @aba1on1/date-picker — the ONE date-selection system for ABA1ON1.
 *
 * Consumed by apps/web (through its `DateInput` / `DateRangeInput` wrappers in
 * `@/ui`) and by apps/console, both via a Vite alias to this folder — the same
 * pattern as `@aba1on1/schemas`. Values are always civil `YYYY-MM-DD` strings;
 * users always see MM/DD/YYYY.
 */
import './src/date-picker.css';

export { DatePicker, boundsMessage } from './src/DatePicker.jsx';
export { DateRangePicker } from './src/DateRangePicker.jsx';
export { Calendar } from './src/Calendar.jsx';
export { DatePickerProvider, useDatePickerTimeZone } from './src/context.js';
export {
  isoToDisplay, maskDisplay, displayToIso, parseIso, toIso, addDays, addMonths,
  monthGrid, todayIso, dayIsDisabled, spanDays, longLabel,
} from './src/dateMath.js';
