// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthLayout } from './AuthLayout.jsx';

/** Platform Console public pages carry the Abstract ABA product brand and its provider. */
let host; let root;
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); root = undefined; host = undefined; });

describe('Console auth branding', () => {
  it('shows the Abstract ABA logo (existing /logo.png) and "Product of WebieApp Solutions LLC" — never ABA1ON1', () => {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    act(() => root.render(<AuthLayout><p>form</p></AuthLayout>));
    const text = host.textContent;
    expect(text).toMatch(/Abstract ABA/);
    expect(text).toMatch(/Product of WebieApp Solutions LLC/);
    expect(text).not.toMatch(/Powered by/);
    const logos = [...host.querySelectorAll('img.rxc-logo__img')];
    expect(logos.length).toBeGreaterThan(0);
    expect(logos.every((img) => img.getAttribute('src') === '/logo.png')).toBe(true);
    expect([...host.querySelectorAll('.rxc__mark')].every((m) => m.textContent === 'AA')).toBe(true);
    expect(text).not.toMatch(/ABA1ON1|A1\b/);
  });
});
