import { useState } from 'react';
import { PLATFORM_BRAND } from '@aba1on1/schemas';
import { Icon } from './icons.jsx';

/**
 * The Abstract ABA product logo — the existing `/logo.png` asset from the app's
 * public folder (PLATFORM_BRAND.logoUrl). Used only where the PRODUCT brand is
 * shown (sign-in, onboarding, auth cards, the sidebar product signature); a
 * customer organization's own name and logo are rendered elsewhere and never
 * replaced by this.
 *
 * The transparent padding around the artwork is cropped by CSS (the file itself
 * is never altered) and the logo is sized by WIDTH to keep its proportions. The product name is always present as text for assistive
 * technology. If the image cannot be loaded, the brand-gradient mark plus the
 * visible product name are shown instead, so a missing asset never renders
 * broken.
 *
 * `tone="onDark"` sets the image on a white chip so it stays legible on
 * brand-coloured grounds (e.g. the Company sidebar rail).
 */
export function BrandLogo({ size = 'md', tone = 'onLight', showNameFallback = true, className = '' }) {
  const [failed, setFailed] = useState(false);
  const cls = ['rx-logo', `rx-logo--${size}`, `rx-logo--${tone}`, className].filter(Boolean).join(' ');
  if (failed) {
    return (
      <span className={`${cls} rx-logo--fallback`}>
        <span className="rx-logo__mark" aria-hidden="true"><Icon.Sparkle size={size === 'sm' ? 14 : 18} /></span>
        {showNameFallback ? <span className="rx-logo__name">{PLATFORM_BRAND.productName}</span> : <span className="rx-sr">{PLATFORM_BRAND.productName}</span>}
      </span>
    );
  }
  return (
    <span className={cls}>
      <span className="rx-logo__frame">
        <img className="rx-logo__img" src={PLATFORM_BRAND.logoUrl} alt="" onError={() => setFailed(true)} decoding="async" draggable="false" />
      </span>
      <span className="rx-sr">{PLATFORM_BRAND.productName}</span>
    </span>
  );
}

export default BrandLogo;
