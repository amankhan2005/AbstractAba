export function formatMoney(minor, currency = 'usd') {
  const n = (Number(minor) || 0) / 100;
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: (currency || 'usd').toUpperCase() }).format(n); }
  catch { return `$${n.toFixed(2)}`; }
}
