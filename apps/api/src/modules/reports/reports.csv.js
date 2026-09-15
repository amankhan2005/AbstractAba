/**
 * Minimal, dependency-free CSV serialization. Values are escaped per RFC 4180:
 * fields containing comma, quote, or newline are double-quoted with embedded
 * quotes doubled. Money is expected pre-formatted or in minor units by the
 * caller; this function does not do financial math.
 */
export function toCsv(headers, rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(',')];
  for (const row of rows) lines.push(row.map(esc).join(','));
  return lines.join('\r\n');
}
