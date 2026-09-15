import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * REGRESSION — RecurringSeriesPage.jsx:209
 *   "Cannot read properties of null (reading 'kind')"
 *
 * The root cause was never a missing null check. ConfirmDialog accepted
 * { title, message, onConfirm, onClose } and had NO `open` prop, so it rendered
 * whenever it was mounted. Two call sites (RecurringSeriesPage, DataToolsPage)
 * passed `open={...}` and `onCancel={...}`, both of which were silently
 * discarded. The consequences:
 *
 *   1. The dialog was on screen from page load, with its target state null.
 *   2. Clicking its confirm button ran the handler against that null → the
 *      reported TypeError.
 *   3. `onClose` was undefined, so Escape and the backdrop threw
 *      "onClose is not a function".
 *
 * Guarding with `confirm?.kind` would have silenced the exception while leaving
 * a permanently-visible phantom modal. These tests pin the contract instead.
 */

let host;
let root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (props) =>
  act(() => {
    root.render(<ConfirmDialog title="Cancel entire series?" message="Are you sure?" {...props} />);
  });

describe('ConfirmDialog open contract', () => {
  it('renders nothing when open is false', () => {
    render({ open: false, onConfirm: vi.fn(), onCancel: vi.fn() });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders when open is true', () => {
    render({ open: true, onConfirm: vi.fn(), onCancel: vi.fn() });
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('still renders when open is omitted, preserving the mount-conditionally callers', () => {
    render({ onConfirm: vi.fn(), onClose: vi.fn() });
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('never fires onConfirm while closed — the exact path that read .kind off null', () => {
    const onConfirm = vi.fn();
    render({ open: false, onConfirm, onCancel: vi.fn() });
    // No dialog means no button to press: the handler is unreachable.
    expect(host.querySelector('button')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('ConfirmDialog dismissal', () => {
  it('accepts onCancel as the dismissal handler', () => {
    const onCancel = vi.fn();
    render({ open: true, onConfirm: vi.fn(), onCancel });
    const cancelButton = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Cancel');
    act(() => cancelButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('accepts onClose as the dismissal handler', () => {
    const onClose = vi.fn();
    render({ open: true, onConfirm: vi.fn(), onClose });
    const cancelButton = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Cancel');
    act(() => cancelButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not throw on Escape when only onCancel was supplied', () => {
    const onCancel = vi.fn();
    render({ open: true, onConfirm: vi.fn(), onCancel });
    expect(() => {
      act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    }).not.toThrow();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape while busy so a mutation in flight cannot be orphaned', () => {
    const onCancel = vi.fn();
    render({ open: true, busy: true, onConfirm: vi.fn(), onCancel });
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(onCancel).not.toHaveBeenCalled();
  });
});
