import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { DateInput, isoToDisplay, maskDisplay, displayToIso } from './DateInput.jsx';

/**
 * DateInput — locale-INDEPENDENT MM/DD/YYYY control. These tests pin the visible
 * format and the internal <-> display conversion so no browser/OS locale can turn
 * the field into dd/mm/yyyy, and so invalid dates never leak Invalid Date/NaN.
 */

describe('DateInput pure conversions', () => {
  it('isoToDisplay: YYYY-MM-DD -> MM/DD/YYYY', () => {
    expect(isoToDisplay('2015-08-27')).toBe('08/27/2015');
    expect(isoToDisplay('2026-01-05')).toBe('01/05/2026');
    expect(isoToDisplay('')).toBe('');
    expect(isoToDisplay(null)).toBe('');
    expect(isoToDisplay('2026-08-01T00:00:00.000Z')).toBe('08/01/2026'); // tolerates datetime
  });

  it('maskDisplay: progressive digit mask with slashes', () => {
    expect(maskDisplay('0')).toBe('0');
    expect(maskDisplay('08')).toBe('08');
    expect(maskDisplay('0827')).toBe('08/27');
    expect(maskDisplay('08272015')).toBe('08/27/2015');
    expect(maskDisplay('08/27/2015')).toBe('08/27/2015'); // idempotent
    expect(maskDisplay('0827201599')).toBe('08/27/2015'); // capped at 8 digits
  });

  it('displayToIso: MM/DD/YYYY -> YYYY-MM-DD, timezone-safe, rejects impossible dates', () => {
    expect(displayToIso('08/27/2015')).toBe('2015-08-27');
    expect(displayToIso('02/29/2024')).toBe('2024-02-29'); // leap year OK
    expect(displayToIso('02/29/2023')).toBe(null); // not a leap year
    expect(displayToIso('13/40/2026')).toBe(null);
    expect(displayToIso('00/00/2026')).toBe(null);
    expect(displayToIso('02/31/2026')).toBe(null);
    expect(displayToIso('08/27')).toBe(null); // incomplete
    expect(displayToIso('')).toBe(null);
  });
});

let host; let root;
const mount = (props) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(<DateInput {...props} />));
};
const rerender = (props) => act(() => root.render(<DateInput {...props} />));
const textInput = () => host.querySelector('input[type="text"]');
const wrapper = () => host.querySelector('.rx-input');
// Drive the controlled input the way React sees a real change event.
const type = (raw) => {
  const el = textInput();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, raw);
  act(() => { el.dispatchEvent(new Event('input', { bubbles: true })); });
};

beforeEach(() => {});
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = undefined; host = undefined; });

describe('DateInput component', () => {
  it('renders an existing internal value visibly as MM/DD/YYYY (not YYYY-MM-DD)', () => {
    mount({ value: '2015-08-27', onChange: () => {} });
    expect(textInput().value).toBe('08/27/2015');
    expect(host.textContent).not.toMatch(/2015-08-27/);
    expect(textInput().getAttribute('placeholder')).toBe('MM/DD/YYYY');
    expect(textInput().getAttribute('type')).toBe('text'); // never a native date input
  });

  it('typing MM/DD/YYYY emits the internal YYYY-MM-DD value', () => {
    const onChange = vi.fn();
    mount({ value: '', onChange });
    type('08272015');
    expect(textInput().value).toBe('08/27/2015');
    expect(onChange).toHaveBeenLastCalledWith({ target: { value: '2015-08-27' } });
  });

  it('an incomplete entry emits empty (no Invalid Date), a complete-but-impossible one flags an error', () => {
    const onChange = vi.fn();
    mount({ value: '', onChange });
    type('0827');
    expect(textInput().value).toBe('08/27');
    expect(onChange).toHaveBeenLastCalledWith({ target: { value: '' } });
    expect(wrapper().className).not.toMatch(/rx-input--error/);

    type('13402026'); // 13/40/2026
    expect(textInput().value).toBe('13/40/2026');
    expect(onChange).toHaveBeenLastCalledWith({ target: { value: '' } });
    expect(wrapper().className).toMatch(/rx-input--error/);
    expect(host.textContent).not.toMatch(/Invalid Date|NaN|undefined|null/);
  });

  it('re-syncs the visible text when the internal value changes externally', () => {
    mount({ value: '2015-08-27', onChange: () => {} });
    expect(textInput().value).toBe('08/27/2015');
    rerender({ value: '2020-12-31', onChange: () => {} });
    expect(textInput().value).toBe('12/31/2020');
  });

  it('clearing the field emits empty and shows the placeholder', () => {
    const onChange = vi.fn();
    mount({ value: '2015-08-27', onChange });
    type('');
    expect(textInput().value).toBe('');
    expect(onChange).toHaveBeenLastCalledWith({ target: { value: '' } });
  });
});
