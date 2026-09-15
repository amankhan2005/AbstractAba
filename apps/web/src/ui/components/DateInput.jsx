import { DatePicker, DateRangePicker } from '@aba1on1/date-picker';

/**
 * DateInput / DateRangeInput — the tenant web app's bindings to the ONE shared
 * date picker in `packages/date-picker` (also used by the platform console).
 *
 * They exist so every screen keeps importing from `@/ui` and so the picker's
 * field adopts the RX form-control class (`rx-input`, `rx-input--error`) and
 * therefore lines up with TextInput/Select in the same forms. All behaviour —
 * MM/DD/YYYY masking, the calendar, keyboard support, org-timezone "Today" —
 * lives in the shared package, not here.
 *
 * Contract (unchanged):
 *   - DateInput:      `value` 'YYYY-MM-DD' | '';  `onChange({ target: { value } })`
 *   - DateRangeInput: `start`/`end` 'YYYY-MM-DD' | '';  `onChange({ start, end })`
 */

export { isoToDisplay, maskDisplay, displayToIso } from '@aba1on1/date-picker';

export function DateInput(props) {
  return <DatePicker fieldClassName="rx-input" errorClassName="rx-input--error" {...props} />;
}

export function DateRangeInput(props) {
  return <DateRangePicker fieldClassName="rx-input" errorClassName="rx-input--error" {...props} />;
}

export default DateInput;
