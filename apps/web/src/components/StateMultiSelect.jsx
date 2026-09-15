import { useMemo, useState } from 'react';
import { US_STATES, usStateName } from '@aba1on1/schemas';

/**
 * Operating-states multi-select (spec Module 5.3). One component shared by
 * company onboarding and Company Settings so both write the same serviceStates
 * field the same way. Values are canonical US state CODES; the UI shows full
 * names (Module 5.2). `value` is an array of codes; `onChange(nextCodes)`.
 *
 * Visual values resolve through design tokens (BR-UI-1) — no literal hex or px.
 */
export function StateMultiSelect({ value = [], onChange, disabled = false }) {
  const [filter, setFilter] = useState('');
  const selected = Array.isArray(value) ? value : [];
  const shown = useMemo(
    () => US_STATES.filter((s) => s.name.toLowerCase().includes(filter.trim().toLowerCase())),
    [filter],
  );

  const toggle = (code) => {
    if (disabled) return;
    onChange(selected.includes(code) ? selected.filter((c) => c !== code) : [...selected, code]);
  };

  const chip = {
    display: 'inline-flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.8rem',
    padding: '0.125rem 0.5rem', borderRadius: '62.5rem',
    background: 'var(--rx-accent-soft, transparent)', color: 'var(--rx-ink, currentColor)',
  };
  const boxBorder = '0.0625rem solid var(--rx-line, currentColor)';

  return (
    <div style={{ display: 'grid', gap: '0.5rem' }}>
      {selected.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', alignItems: 'center' }}>
          {selected.map((code) => (
            <span key={code} style={chip}>
              {usStateName(code)}
              {!disabled && (
                <button type="button" aria-label={`Remove ${usStateName(code)}`} onClick={() => toggle(code)}
                  style={{ border: 0, background: 'transparent', cursor: 'pointer', lineHeight: 1, fontSize: '1rem', color: 'inherit' }}>×</button>
              )}
            </span>
          ))}
          {!disabled && (
            <button type="button" onClick={() => onChange([])}
              style={{ border: 0, background: 'transparent', cursor: 'pointer', fontSize: '0.75rem', color: 'var(--rx-ink-faint, currentColor)', textDecoration: 'underline' }}>
              Clear all
            </button>
          )}
        </div>
      )}
      <input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter states…"
        disabled={disabled}
        style={{ padding: '0.5rem 0.625rem', borderRadius: '0.5rem', border: boxBorder, fontSize: '0.85rem' }}
      />
      <div role="group" aria-label="Operating states"
        style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', maxHeight: '12.5rem', overflow: 'auto', padding: '0.375rem', border: boxBorder, borderRadius: '0.5rem' }}>
        {shown.map((s) => {
          const on = selected.includes(s.code);
          return (
            <label key={s.code}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.8rem', padding: '0.1875rem 0.5rem', borderRadius: '0.375rem', cursor: disabled ? 'default' : 'pointer', background: on ? 'var(--rx-accent-soft, transparent)' : 'transparent' }}>
              <input type="checkbox" checked={on} onChange={() => toggle(s.code)} disabled={disabled} aria-label={s.name} />
              {s.name}
            </label>
          );
        })}
        {shown.length === 0 && <span style={{ fontSize: '0.8rem', color: 'var(--rx-ink-faint, currentColor)' }}>No states match “{filter}”.</span>}
      </div>
    </div>
  );
}

export default StateMultiSelect;
