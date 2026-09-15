import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { BrandLogo } from './BrandLogo.jsx';

/** The Abstract ABA product logo uses the existing /logo.png and never renders a broken image. */
let host; let root;
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); root = undefined; host = undefined; });
const mount = (ui) => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); act(() => root.render(ui)); };

describe('BrandLogo', () => {
  it('loads the existing /logo.png and keeps the product name for assistive technology', () => {
    mount(<BrandLogo />);
    const img = host.querySelector('img.rx-logo__img');
    expect(img.getAttribute('src')).toBe('/logo.png');
    expect(img.getAttribute('alt')).toBe('');
    expect(host.textContent).toBe('Abstract ABA');
  });

  it('falls back to the brand mark and visible product name if the image cannot load', () => {
    mount(<BrandLogo tone="onDark" />);
    act(() => { host.querySelector('img').dispatchEvent(new Event('error')); });
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.rx-logo--fallback .rx-logo__mark')).toBeTruthy();
    expect(host.querySelector('.rx-logo__name').textContent).toBe('Abstract ABA');
  });
});
