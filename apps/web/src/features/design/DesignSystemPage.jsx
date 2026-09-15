import { SEMANTIC_STATES } from '@aba1on1/schemas';
import { fetchSettings } from '@/api/client';
import { AppearanceSettings, Button, Card, SettingsPanel, StatusBadge } from '@/components';
import { PLATFORM_BRAND } from '@aba1on1/schemas';

/**
 * The design-system surface: the locked semantic states, the token-reading
 * primitives, and the per-user appearance editor. Preserved verbatim from the
 * original App demo, now hosted as a route inside the tenant shell so the theme
 * contract stays exercised end-to-end.
 */
export function DesignSystemPage() {
  return (
    <div className="ui-stack">
      <h1>{PLATFORM_BRAND.productName} · Design System</h1>

      <Card>
        <h2>Semantic states</h2>
        <p>Locked platform meaning — colour, glyph and label together.</p>
        <div className="ui-row">
          {SEMANTIC_STATES.map((state) => <StatusBadge key={state} state={state} />)}
        </div>
      </Card>

      <Card>
        <h2>Actions</h2>
        <div className="ui-row">
          <Button>Primary action</Button>
          <Button variant="ghost">Secondary</Button>
        </div>
      </Card>

      <AppearanceSettings />

      <SettingsPanel load={fetchSettings} />
    </div>
  );
}
