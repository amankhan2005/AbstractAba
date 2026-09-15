// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Modal, ConfirmDialog } from './Modal';

/**
 * Regression coverage for the critical modal/layering fix:
 *  - the modal renders through a portal to <body>, NOT inside the caller's
 *    subtree (so no transformed/overflow ancestor can clip it);
 *  - it carries the modal layer via the .modal-overlay/.modal classes;
 *  - Escape and the close button invoke onClose;
 *  - page scroll is locked while open and restored on close.
 */
let host;
let root;

afterEach(() => {
  if (root) act(() => root.unmount());
  if (host) host.remove();
  host = null;
  root = null;
  document.body.style.overflow = '';
});

function mount(ui) {
  host = document.createElement('div');
  // Give the caller's container a clipping/stacking context; a correctly
  // portalled modal must escape it and still land on document.body.
  host.style.transform = 'translateZ(0)';
  host.style.overflow = 'hidden';
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(ui));
}

describe('Modal — portal + layering + a11y', () => {
  it('renders into document.body, not inside the caller subtree', () => {
    mount(<Modal title="Test dialog"><p>Body</p></Modal>);
    const overlay = document.querySelector('.modal-overlay');
    expect(overlay).toBeTruthy();
    // Escaped the clipping host entirely.
    expect(host.contains(overlay)).toBe(false);
    expect(document.body.contains(overlay)).toBe(true);
    // Dialog semantics present.
    const dialog = overlay.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('locks body scroll while open and restores it on unmount', () => {
    expect(document.body.style.overflow).toBe('');
    mount(<Modal title="Scroll lock"><p>Body</p></Modal>);
    expect(document.body.style.overflow).toBe('hidden');
    act(() => root.unmount());
    root = null;
    expect(document.body.style.overflow).toBe('');
  });

  it('closes on Escape and on the close button', () => {
    let closed = 0;
    mount(<Modal title="Closable" onClose={() => { closed += 1; }}><p>Body</p></Modal>);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(closed).toBe(1);
    const x = document.querySelector('.modal-x');
    act(() => x.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(closed).toBe(2);
  });

  it('ConfirmDialog respects the open flag and fires onConfirm', () => {
    let confirmed = 0;
    mount(
      <ConfirmDialog open={false} title="Nope" message="hidden" onConfirm={() => { confirmed += 1; }} />,
    );
    expect(document.querySelector('.modal-overlay')).toBeNull();
    act(() => root.render(
      <ConfirmDialog open title="Yes" message="visible" confirmLabel="Do it" onConfirm={() => { confirmed += 1; }} />,
    ));
    const overlay = document.querySelector('.modal-overlay');
    expect(overlay).toBeTruthy();
    const confirmBtn = Array.from(overlay.querySelectorAll('button')).find((b) => /do it/i.test(b.textContent));
    act(() => confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(confirmed).toBe(1);
  });
});
