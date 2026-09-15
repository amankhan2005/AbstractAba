/** Format integer minor units as a currency string for display only. */
export function formatMoney(minor, currency = 'usd') {
  const n = (Number(minor) || 0) / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}
