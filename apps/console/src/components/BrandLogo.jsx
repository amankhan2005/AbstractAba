import { useState } from 'react';
import { PLATFORM_BRAND } from '@aba1on1/schemas';

/**
 * The Abstract ABA product logo for the Platform Console — the existing
 * `/logo.png` in the console's public folder (PLATFORM_BRAND.logoUrl). The
 * transparent padding around the artwork is cropped by CSS (the file itself is
 * never altered) and the logo is sized by width to keep its proportions. The
 * product name stays available as text for assistive technology; if the image
 * can't be loaded the console's gradient "AA" mark is shown instead.
 */
export function BrandLogo({ size = 'md', tone = 'onLight', fallback }) {
  const [failed, setFailed] = useState(false);
  if (failed) return fallback ?? <span className="rxc__mark" aria-hidden="true">{PLATFORM_BRAND.productMark}</span>;
  return (
    <span className={`rxc-logo rxc-logo--${size} rxc-logo--${tone}`}>
      <span className="rxc-logo__frame">
        <img className="rxc-logo__img" src={PLATFORM_BRAND.logoUrl} alt="" onError={() => setFailed(true)} decoding="async" draggable="false" />
      </span>
      <span className="sr-only">{PLATFORM_BRAND.productName}</span>
    </span>
  );
}

export default BrandLogo;
