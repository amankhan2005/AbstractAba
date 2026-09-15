import { useState, useEffect } from 'react';
import { usePermissions } from '@/auth/permissions';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchBranding, saveBranding, uploadTenantLogo } from '@/api/client';
import { Card } from '@/components/Card';
import { Button } from '@/components/Button';
import { LoadingState, ErrorState } from '@/components/StateViews';
import { useToast } from '@/components/Toast';
import { BRAND_DEFAULTS } from '@aba1on1/schemas';

/**
 * Company branding — blueprint §6.14.
 *
 * Two brand colours and a logo. That is the whole surface the blueprint gives
 * a tenant, and it stops there deliberately: §6.14's BR-UI-2 locks the
 * SEMANTIC palette — success, warning, danger, blocked — so no clinic can
 * recolour "insurance verification failed" into something reassuring. Those
 * colours are not offered here because they are not a tenant's to change, and
 * the server would refuse the write regardless.
 *
 * Branding is stored per tenant and applied from the resolved theme, so a
 * BCBA and a technician in the same clinic see their own company's colours and
 * nothing of anyone else's.
 */

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Max decoded size the server accepts; checked here to fail fast and kindly. */
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp'];

export function BrandingPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { permissions: permissions, ready: authReady } = usePermissions();
  const canEdit = permissions.includes('organization.update');

  const query = useQuery({ queryKey: ['branding'], queryFn: fetchBranding });

  const [primary, setPrimary] = useState('');
  const [secondary, setSecondary] = useState('');
  const [logoError, setLogoError] = useState(null);

  // Seed the form once the saved values arrive, without clobbering edits in
  // progress on a background refetch.
  useEffect(() => {
    if (!query.data) return;
    setPrimary((v) => v || query.data.primary || BRAND_DEFAULTS.primary.light);
    setSecondary((v) => v || query.data.secondary || BRAND_DEFAULTS.secondary.light);
  }, [query.data]);

  const save = useMutation({
    mutationFn: () => saveBranding({ primary, secondary }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['branding'] });
      toast.push('Branding saved.');
    },
    onError: () => toast.push('We couldn’t save those colours. Please try again.'),
  });

  const upload = useMutation({
    mutationFn: (dataUrl) => uploadTenantLogo(dataUrl),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['branding'] });
      setLogoError(null);
      toast.push('Logo updated.');
    },
    onError: (err) => {
      // The server sends plain language for a rejected file (wrong format, too
      // large, uploads not configured). Show it — it tells the user what to do.
      const message = err?.response?.data?.error?.message;
      setLogoError(message || 'We couldn’t upload that image. Please try another file.');
    },
  });

  if (query.isPending) return <LoadingState label="Loading your branding…" />;
  if (query.isError) {
    return <ErrorState message="We couldn’t load your branding settings." onRetry={() => query.refetch()} />;
  }

  const primaryValid = HEX.test(primary);
  const secondaryValid = HEX.test(secondary);
  const logoUrl = query.data.logoUrl ?? null;

  const onFile = (file) => {
    setLogoError(null);
    if (!file) return;
    if (!ACCEPTED.includes(file.type)) {
      setLogoError('Please choose a PNG, JPG or WebP image. SVG files can’t be used for logos.');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError('That image is too large. Please use a logo under 2 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => upload.mutate(String(reader.result));
    reader.onerror = () => setLogoError('We couldn’t read that file. Please try another.');
    reader.readAsDataURL(file);
  };

  return (
    <div className="ui-stack">
      <h1>Branding</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Your logo and colours appear across the portal for everyone at your organization.
      </p>

      <Card>
        <h2>Company logo</h2>
        <div className="brand-logo">
          <div className="brand-logo__preview" aria-label="Current logo">
            {logoUrl
              ? <img src={logoUrl} alt="Your company logo" />
              : <span className="muted">No logo yet</span>}
          </div>
          {canEdit ? (
            <div className="brand-logo__actions">
              <label className="ui-button ui-button--ghost brand-logo__button">
                {upload.isPending ? 'Uploading…' : logoUrl ? 'Replace logo' : 'Upload logo'}
                <input
                  type="file"
                  accept={ACCEPTED.join(',')}
                  disabled={upload.isPending}
                  onChange={(e) => onFile(e.target.files?.[0])}
                  hidden
                />
              </label>
              <p className="muted brand-hint">PNG, JPG or WebP, up to 2 MB.</p>
            </div>
          ) : null}
        </div>
        {logoError ? <p className="form-error" role="alert">{logoError}</p> : null}
      </Card>

      <Card>
        <h2>Colours</h2>
        <div className="brand-colors">
          <ColorField
            label="Primary" value={primary} onChange={setPrimary}
            valid={primaryValid} disabled={!canEdit}
            hint="Buttons, links and highlights."
          />
          <ColorField
            label="Accent" value={secondary} onChange={setSecondary}
            valid={secondaryValid} disabled={!canEdit}
            hint="Secondary emphasis."
          />
        </div>

        <div className="brand-preview" aria-label="Preview">
          <span className="brand-preview__label">Preview</span>
          <span className="brand-preview__chip" style={{ background: primaryValid ? primary : undefined }}>
            Primary
          </span>
          <span className="brand-preview__chip" style={{ background: secondaryValid ? secondary : undefined }}>
            Accent
          </span>
          {/* Status colours are shown but NOT editable: BR-UI-2 locks them so a
              clinic cannot recolour a failure into something reassuring. */}
          <span className="brand-preview__chip brand-preview__chip--locked ui-badge--success">Verified</span>
          <span className="brand-preview__chip brand-preview__chip--locked ui-badge--danger">Needs attention</span>
        </div>
        <p className="muted brand-hint">
          Status colours stay the same for every organization so that “verified” and
          “needs attention” always look the same to everyone.
        </p>

        {canEdit ? (
          <div className="ui-row" style={{ gap: 'var(--space-2)' }}>
            <Button onClick={() => save.mutate()} disabled={save.isPending || !primaryValid || !secondaryValid}>
              {save.isPending ? 'Saving…' : 'Save colours'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => { setPrimary(BRAND_DEFAULTS.primary.light); setSecondary(BRAND_DEFAULTS.secondary.light); }}
              disabled={save.isPending}
            >
              Reset to default
            </Button>
          </div>
        ) : (
          <p className="muted">You don’t have permission to change your organization’s branding.</p>
        )}
      </Card>
    </div>
  );
}

function ColorField({ label, value, onChange, valid, disabled, hint }) {
  return (
    <label className="brand-field">
      <span>{label}</span>
      <div className="brand-field__row">
        <input
          type="color"
          value={valid ? value : '#000000'}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          disabled={disabled}
          aria-label={`${label} colour picker`}
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          disabled={disabled}
          spellCheck={false}
          aria-invalid={!valid}
        />
      </div>
      {!valid ? <span className="form-error">Use a six-digit colour like #1172A3.</span> : null}
      <span className="muted brand-hint">{hint}</span>
    </label>
  );
}
