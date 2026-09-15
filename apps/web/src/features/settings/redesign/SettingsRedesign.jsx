import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchBranding, uploadTenantLogo } from '@/api/client';
import { useToast } from '@/components';
import { PageHeader, Card, Button, Icon, Spinner, ErrorState } from '@/ui';

/**
 * Settings — company identity ONLY. The application's visual theme is centrally
 * controlled and cannot be customized by a tenant, so there is deliberately no
 * colour picker, no CSS field, no layout/dashboard builder here (removed from
 * the previous Branding page). A company may upload a logo — the one approved
 * identity element — which appears on their sign-in and documents.
 */
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export function SettingsRedesign() {
  const qc = useQueryClient();
  const toast = useToast();
  const [logoError, setLogoError] = useState(null);
  const query = useQuery({ queryKey: ['branding'], queryFn: fetchBranding });

  const upload = useMutation({
    mutationFn: (dataUrl) => uploadTenantLogo(dataUrl),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['branding'] }); toast.push('Logo updated.'); },
    onError: () => toast.push('Could not upload the logo. Please try again.', 'negative'),
  });

  function onFile(file) {
    setLogoError(null);
    if (!file) return;
    if (!ACCEPTED.includes(file.type)) { setLogoError('Please choose a PNG, JPG or WebP image.'); return; }
    if (file.size > MAX_LOGO_BYTES) { setLogoError('That image is too large. Please use a logo under 2 MB.'); return; }
    const reader = new FileReader();
    reader.onload = () => upload.mutate(String(reader.result));
    reader.onerror = () => setLogoError('We couldn’t read that file. Please try another.');
    reader.readAsDataURL(file);
  }

  if (query.isLoading) return <Spinner />;
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} />;
  const logoUrl = query.data?.logoUrl ?? null;

  return (
    <>
      <PageHeader title="Settings" subtitle="Your organization’s identity. The application design is standardized across all clinics." />

      <div className="rx-cols-2">
        <Card title="Company logo" hint="PNG, JPG or WebP · under 2 MB">
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
            <div style={{ width: 96, height: 96, borderRadius: 16, border: '1px dashed var(--rx-line)', display: 'grid', placeItems: 'center', overflow: 'hidden', background: 'var(--rx-canvas)' }}>
              {logoUrl ? <img src={logoUrl} alt="Company logo" style={{ maxWidth: '100%', maxHeight: '100%' }} /> : <Icon.Building size={30} />}
            </div>
            <div>
              <label className="rx-btn rx-btn--ghost" style={{ cursor: 'pointer' }}>
                <Icon.Plus size={16} /> {upload.isPending ? 'Uploading…' : logoUrl ? 'Replace logo' : 'Upload logo'}
                <input type="file" accept={ACCEPTED.join(',')} style={{ display: 'none' }} onChange={(e) => onFile(e.target.files?.[0])} disabled={upload.isPending} />
              </label>
              {logoError && <p className="rx-formfield__err" style={{ marginTop: 8 }}>{logoError}</p>}
            </div>
          </div>
        </Card>

        <Card title="Application appearance">
          <div className="rx-list">
            <div className="rx-row">
              <div className="rx-state__icon" style={{ width: 40, height: 40, marginBottom: 0 }}><Icon.Palette size={20} /></div>
              <div className="rx-row__main">
                <div className="rx-row__title">Centrally managed</div>
                <div className="rx-row__meta">Colours, layout and components are standardized across all organizations for a consistent, accessible experience. There is no per-company theme editor.</div>
              </div>
            </div>
          </div>
        </Card>

      </div>
    </>
  );
}


export default SettingsRedesign;
