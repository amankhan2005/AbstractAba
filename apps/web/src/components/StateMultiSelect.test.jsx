// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { StateMultiSelect } from './StateMultiSelect.jsx';

/**
 * Spec Module 5.2/5.3 — the operating-states picker shared by onboarding and
 * Company Settings. Full state NAMES are shown; the value emitted is canonical
 * CODES. This is the one selector both flows use, so it is tested once here.
 */
let host; let root;
afterEach(() => { if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined; });

const mount = (props) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(<StateMultiSelect {...props} />));
};
const click = (el) => act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));

describe('StateMultiSelect', () => {
  it('renders full state names, not codes', () => {
    mount({ value: [], onChange: vi.fn() });
    expect(host.textContent).toMatch(/California/);
    expect(host.textContent).toMatch(/New Jersey/);
  });

  it('emits the canonical CODE when a state is toggled on', () => {
    const onChange = vi.fn();
    mount({ value: [], onChange });
    const cb = host.querySelector('input[aria-label="California"]');
    click(cb);
    expect(onChange).toHaveBeenCalledWith(['CA']);
  });

  it('shows selected states as removable chips and can remove one', () => {
    const onChange = vi.fn();
    mount({ value: ['CA', 'TX'], onChange });
    expect(host.textContent).toMatch(/California/);
    expect(host.textContent).toMatch(/Texas/);
    const remove = host.querySelector('button[aria-label="Remove Texas"]');
    click(remove);
    expect(onChange).toHaveBeenCalledWith(['CA']);
  });
});
