import { ACCENTS, COLOR_SCHEMES, DENSITIES, FONT_SIZES, RADII } from '@aba1on1/schemas';
import { useAppearance } from '@/theme';
import { Button } from './Button';
import { Card } from './Card';

/**
 * The preference editor (pref.* layer). Each control writes one key through
 * useAppearance, which applies it instantly and persists it. Only the safe
 * accents are offered, and no control can reach the locked semantic palette —
 * the editor simply has no field for it. Ported verbatim.
 */
function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function Field({ label, children }) {
  return (
    <label className="ui-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function AppearanceSettings() {
  const { preferences, setPreference, reset } = useAppearance();

  const onSelect = (key) => (event) => { setPreference(key, event.target.value); };
  const onToggle = (key) => (event) => { setPreference(key, event.target.checked); };

  return (
    <Card>
      <h2>Appearance</h2>
      <div className="ui-fields">
        <Field label="Colour scheme">
          <select value={preferences.colorScheme} onChange={onSelect('colorScheme')}>
            {COLOR_SCHEMES.map((scheme) => <option key={scheme} value={scheme}>{titleCase(scheme)}</option>)}
          </select>
        </Field>

        <Field label="Accent">
          <select value={preferences.accent} onChange={onSelect('accent')}>
            {ACCENTS.map((accent) => <option key={accent} value={accent}>{titleCase(accent)}</option>)}
          </select>
        </Field>

        <Field label="Density">
          <select value={preferences.density} onChange={onSelect('density')}>
            {DENSITIES.map((density) => <option key={density} value={density}>{titleCase(density)}</option>)}
          </select>
        </Field>

        <Field label="Font size">
          <select value={preferences.fontSize} onChange={onSelect('fontSize')}>
            {FONT_SIZES.map((size) => <option key={size} value={size}>{titleCase(size)}</option>)}
          </select>
        </Field>

        <Field label="Corners">
          <select value={preferences.radius} onChange={onSelect('radius')}>
            {RADII.map((radius) => <option key={radius} value={radius}>{titleCase(radius)}</option>)}
          </select>
        </Field>

        <label className="ui-check">
          <input type="checkbox" checked={preferences.highContrast} onChange={onToggle('highContrast')} />
          <span>High contrast</span>
        </label>

        <label className="ui-check">
          <input type="checkbox" checked={preferences.reducedMotion} onChange={onToggle('reducedMotion')} />
          <span>Reduced motion</span>
        </label>
      </div>

      <Button variant="ghost" onClick={reset}>Reset to default</Button>
    </Card>
  );
}
