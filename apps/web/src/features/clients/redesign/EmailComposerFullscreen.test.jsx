import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { EmailComposerFullscreen } from './EmailComposerFullscreen.jsx';

/**
 * Full-screen email composer — structural + interaction contract.
 *   - editor (left) and preview (right) both render
 *   - top bar shows the server-resolved recipient + company
 *   - X calls onClose, Back calls onBack
 *   - a variable chip calls onInsertVar
 *   - Send is gated by canSend and calls onSend
 *   - the responsive grid class is present (mobile stacks via CSS)
 */

let host;
let root;

const PREVIEW = {
  isPending: false,
  isError: false,
  data: {
    recipient: { available: true, name: 'Jamie Rivera', email: 'jamie@example.com' },
    sender: { name: 'ABC Behavioral Health', resolved: 'server' },
    subject: 'Your child Aman has been approved',
    bodyText: 'Hello Jamie,\n\n...\n\nRegards,\n\nABC Behavioral Health\n(555) 123-4567',
    unavailableVariables: [],
  },
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  // The composer portals into document.body; clear any stragglers.
  document.querySelectorAll('.rx-emailfs').forEach((n) => n.remove());
});

function render(props) {
  const base = {
    templateName: 'Child Approved',
    subject: 'Your child Aman has been approved',
    body: 'Hello',
    variables: ['childFirstName', 'parentFirstName', 'companyName'],
    preview: PREVIEW,
    sending: false,
    canSend: true,
    onSubjectChange: vi.fn(),
    onBodyChange: vi.fn(),
    onInsertVar: vi.fn(),
    onSend: vi.fn(),
    onBack: vi.fn(),
    onClose: vi.fn(),
  };
  const merged = { ...base, ...props };
  act(() => root.render(<EmailComposerFullscreen {...merged} />));
  return merged;
}

describe('EmailComposerFullscreen', () => {
  it('renders both editor and preview panes with the responsive grid', () => {
    render();
    expect(document.querySelector('.rx-emailfs__editor')).toBeTruthy();
    expect(document.querySelector('.rx-emailfs__preview')).toBeTruthy();
    expect(document.querySelector('.rx-emailfs__body')).toBeTruthy();
    expect(document.querySelector('textarea')).toBeTruthy();
  });

  it('shows the server-resolved recipient and company in the top bar', () => {
    render();
    const text = document.body.textContent;
    expect(text).toContain('jamie@example.com');
    expect(text).toContain('ABC Behavioral Health');
    expect(text).toContain('Recipient');
    expect(text).toContain('Company');
  });

  it('X calls onClose and Back calls onBack', () => {
    const props = render();
    act(() => document.querySelector('button[aria-label="Close"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    act(() => document.querySelector('button[aria-label="Back"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it('clicking a variable chip inserts that variable', () => {
    const props = render();
    const chip = [...document.querySelectorAll('.rx-emailfs__chip')].find((b) => b.textContent.includes('childFirstName'));
    act(() => chip.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onInsertVar).toHaveBeenCalledWith('childFirstName');
  });

  it('Send is disabled when canSend is false and fires onSend when enabled', () => {
    const disabled = render({ canSend: false });
    const btnDisabled = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Send email');
    expect(btnDisabled.disabled).toBe(true);
    expect(disabled.onSend).not.toHaveBeenCalled();

    const props = render({ canSend: true });
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Send email');
    act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onSend).toHaveBeenCalledTimes(1);
  });

  it('marks the recipient row when the guardian email is unavailable', () => {
    render({ preview: { ...PREVIEW, data: { ...PREVIEW.data, recipient: { available: false } } } });
    expect(document.querySelector('.rx-emailfs__warn')).toBeTruthy();
    expect(document.body.textContent).toContain('Guardian email not available');
  });
});
