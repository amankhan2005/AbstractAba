/** A surface that reads its background, border and radius from tokens. */
export function Card({ children, className }) {
  return <section className={className ? `ui-card ${className}` : 'ui-card'}>{children}</section>;
}
