import { useState } from 'react';
import { PLATFORM_BRAND } from '@aba1on1/schemas';
import { Icon } from './Icon.jsx';

/**
 * The existing Abstract ABA logo (/logo.png in this app's public folder, the
 * same artwork the web panel and console ship). The transparent padding around
 * the artwork is cropped by CSS and the logo is sized by width, so it is never
 * stretched. The product name is always available to assistive technology; if
 * the image fails to load a brand mark plus the name is shown instead.
 */
export function BrandLogo({ className = '' }) {
  const [failed, setFailed] = useState(false);
  const cls = ['site-logo', failed ? 'site-logo--fallback' : '', className].filter(Boolean).join(' ');
  if (failed) {
    return (
      <span className={cls}>
        <span className="site-logo__mark" aria-hidden="true"><Icon.Sparkle size={16} /></span>
        <span className="site-logo__name">{PLATFORM_BRAND.productName}</span>
      </span>
    );
  }
  return (
    <span className={cls}>
      <span className="site-logo__frame">
        <img className="site-logo__img" src={PLATFORM_BRAND.logoUrl} alt="" onError={() => setFailed(true)} decoding="async" draggable="false" />
      </span>
      <span className="site-sr">{PLATFORM_BRAND.productName}</span>
    </span>
  );
}
