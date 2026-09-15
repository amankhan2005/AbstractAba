/** Format integer minor units as a currency string (display only). */
export function formatMoney(minor, currency = 'usd') {
  const n = (Number(minor) || 0) / 100;
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: (currency || 'usd').toUpperCase() }).format(n); }
  catch { return `$${n.toFixed(2)}`; }
}
/** Format minutes as "Xh Ym" for display. */
export function formatMinutes(minutes) {
  const m = Number(minutes) || 0;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
