import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { Select } from './Select.jsx';

/**
 * Select `portal` mode — the menu escapes clipping containers.
 *
 * jsdom has no layout, so the trigger rect, viewport and menu sizes are stubbed
 * to reproduce the onboarding case: a field inside an overflow-hidden card,
 * near the bottom of the viewport.
 */
let container; let root; let clip;
const OPTS = Array.from({ length: 7 }, (_, i) => ({ value: `v${i}`, label: `Option ${i + 1}` }));
const LIST_CONTENT = 7 * 38 + 12; // seven options plus list padding
const CHROME = 2; // menu borders

function stubLayout({ triggerTop, triggerHeight = 42, viewport = 800 }) {
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(viewport);
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
    if (this.classList.contains('rx-select__trigger')) {
      return { top: triggerTop, bottom: triggerTop + triggerHeight, left: 300, right: 620, width: 320, height: triggerHeight, x: 300, y: triggerTop, toJSON() {} };
    }
    if (this.classList.contains('rx-select')) {
      // The wrapper stretched by a grid row (as in the onboarding form) — must NOT be used for placement.
      return { top: triggerTop, bottom: triggerTop + triggerHeight + 15, left: 300, right: 620, width: 320, height: triggerHeight + 15, x: 300, y: triggerTop, toJSON() {} };
    }
    return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} };
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function h() {
    return this.classList.contains('rx-select__list') ? LIST_CONTENT : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function h() {
    if (this.classList.contains('rx-select__list')) return Math.min(LIST_CONTENT, 240);
    if (this.classList.contains('rx-select__menu')) return Math.min(LIST_CONTENT, 240) + CHROME;
    return 0;
  });
}

beforeEach(() => {
  // A clipping parent, like the onboarding card.
  clip = document.createElement('div');
  clip.style.overflow = 'hidden';
  container = document.createElement('div');
  clip.appendChild(container);
  document.body.appendChild(clip);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  clip.remove();
  vi.restoreAllMocks();
});

const menu = () => document.querySelector('.rx-select__menu');
const open = () => act(() => container.querySelector('.rx-select__trigger').click());

describe('Select — portal mode', () => {
  it('renders the menu in <body>, outside the clipping container, with every option', () => {
    stubLayout({ triggerTop: 200 });
    act(() => root.render(<Select portal value="" onChange={() => {}} options={OPTS} searchable={false} />));
    open();
    expect(menu()).toBeTruthy();
    expect(container.querySelector('.rx-select__menu')).toBeNull();
    expect(clip.contains(menu())).toBe(false);
    expect(menu().classList.contains('rx-select__menu--floating')).toBe(true);
    expect(document.querySelectorAll('.rx-select__opt')).toHaveLength(7);
  });

  it('opens below the field when there is room', () => {
    stubLayout({ triggerTop: 200 });
    act(() => root.render(<Select portal value="" onChange={() => {}} options={OPTS} searchable={false} />));
    open();
    expect(menu().style.top).toBe(`${200 + 42 + 6}px`);
    expect(menu().style.left).toBe('300px');
    expect(menu().style.width).toBe('320px');
    expect(menu().style.visibility).not.toBe('hidden');
  });

  it('opens above the field when there is not enough room below, fully inside the viewport', () => {
    stubLayout({ triggerTop: 700 }); // 800px viewport: ~40px below, ~680px above
    act(() => root.render(<Select portal value="" onChange={() => {}} options={OPTS} searchable={false} />));
    open();
    const top = parseInt(menu().style.top, 10);
    expect(top).toBe(700 - 6 - (LIST_CONTENT + CHROME));
    expect(top).toBeGreaterThanOrEqual(12);
    expect(top + LIST_CONTENT + CHROME).toBeLessThanOrEqual(700);
    // A short list is shown in full: the list is not capped below its content height.
    expect(parseInt(document.querySelector('.rx-select__list').style.maxHeight, 10)).toBe(LIST_CONTENT);
  });

  it('limits the list height to the space available, so all options stay reachable by scrolling', () => {
    stubLayout({ triggerTop: 150, viewport: 330 }); // ~126px above, ~120px below
    act(() => root.render(<Select portal value="" onChange={() => {}} options={OPTS} searchable={false} />));
    open();
    const listMax = parseInt(document.querySelector('.rx-select__list').style.maxHeight, 10);
    const top = parseInt(menu().style.top, 10);
    expect(listMax).toBeGreaterThan(0);
    expect(listMax + CHROME).toBeLessThanOrEqual(150 - 6 - 12);
    expect(top).toBeGreaterThanOrEqual(12);
  });

  it('follows the field when the page scrolls', async () => {
    stubLayout({ triggerTop: 200 });
    act(() => root.render(<Select portal value="" onChange={() => {}} options={OPTS} searchable={false} />));
    open();
    stubLayout({ triggerTop: 120 });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(); return 1; });
    await act(async () => { window.dispatchEvent(new Event('scroll')); });
    expect(menu().style.top).toBe(`${120 + 42 + 6}px`);
  });

  it('selects an option from the portalled menu and closes; outside clicks close it too', () => {
    stubLayout({ triggerTop: 200 });
    const onChange = vi.fn();
    act(() => root.render(<Select portal value="" onChange={onChange} options={OPTS} searchable={false} />));
    open();
    act(() => document.querySelectorAll('.rx-select__opt')[6].click());
    expect(onChange).toHaveBeenCalledWith('v6');
    open();
    // A click inside the menu is not an outside click.
    act(() => menu().dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(menu()).toBeTruthy();
    act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(container.querySelector('.rx-select__trigger').getAttribute('aria-expanded')).toBe('false');
  });

  it('without portal the menu stays inline, as before', () => {
    act(() => root.render(<Select value="" onChange={() => {}} options={OPTS} searchable={false} />));
    open();
    expect(container.querySelector('.rx-select__menu')).toBeTruthy();
    expect(container.querySelector('.rx-select__menu--floating')).toBeNull();
  });

  it('Escape closes the portalled menu even when focus is outside the field, without reaching a dialog behind it', () => {
    stubLayout({ triggerTop: 200 });
    const behind = vi.fn();
    document.addEventListener('keydown', behind);
    act(() => root.render(<Select portal value="" onChange={() => {}} options={OPTS} searchable={false} />));
    open();
    document.body.focus();
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(container.querySelector('.rx-select__trigger').getAttribute('aria-expanded')).toBe('false');
    expect(behind).not.toHaveBeenCalled();
    document.removeEventListener('keydown', behind);
  });
});
