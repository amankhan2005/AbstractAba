import { SEMANTIC_PALETTE } from '@aba1on1/schemas';

/**
 * A semantic status badge — BR-UI-3. Colour comes from the locked state.* layer
 * (via the data-state attribute the stylesheet keys on) and can be changed by no
 * preference. A shape glyph and a text label always accompany it, so meaning
 * survives colour-blindness and any theme. Ported verbatim.
 */
const STATE_GLYPH = {
  approved: '✓',
  pending: '◐',
  denied: '✕',
  information: 'ℹ',
  draft: '◌',
};

export function StatusBadge({ state, children }) {
  return (
    <span className="ui-badge" data-state={state}>
      <span aria-hidden="true">{STATE_GLYPH[state]}</span>
      <span>{children ?? SEMANTIC_PALETTE[state].label}</span>
    </span>
  );
}
