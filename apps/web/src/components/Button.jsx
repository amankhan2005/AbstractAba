/**
 * A button that reads its colour, radius and padding from tokens. The accent
 * variant paints with the resolved accent and its derived accessible foreground,
 * so it stays legible under every scheme and accent without naming a colour.
 */
export function Button({ variant = 'accent', children, ...rest }) {
  const className = variant === 'ghost' ? 'ui-button ui-button--ghost' : 'ui-button';
  return (
    <button className={className} {...rest}>{children}</button>
  );
}
