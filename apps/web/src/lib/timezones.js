/**
 * The organization time zones offered in the product (onboarding and Company
 * Profile). The stored, canonical value is always the IANA identifier; `name`
 * is display text only. Daylight saving is applied by the browser's and the
 * server's tz database for the identifier — no offsets are defined here.
 *
 * The server validates any IANA identifier, so an organization created with a
 * zone outside this list (e.g. by a platform operator) still shows and saves
 * correctly: timeZoneOptions() includes the current value.
 */
export const ORGANIZATION_TIME_ZONES = Object.freeze([
  { value: 'America/New_York', name: 'Eastern Time' },
  { value: 'America/Chicago', name: 'Central Time' },
  { value: 'America/Denver', name: 'Mountain Time' },
  { value: 'America/Phoenix', name: 'Arizona Time' },
  { value: 'America/Los_Angeles', name: 'Pacific Time' },
  { value: 'America/Anchorage', name: 'Alaska Time' },
  { value: 'Pacific/Honolulu', name: 'Hawaii Time' },
]);

/** Friendly name for an IANA identifier ("Eastern Time"), or the identifier itself. */
export function timeZoneName(id) {
  return ORGANIZATION_TIME_ZONES.find((z) => z.value === id)?.name ?? id ?? '';
}

/** "Eastern Time — America/New_York"; an unlisted zone shows its identifier. */
export function timeZoneLabel(id) {
  if (!id) return '';
  const name = ORGANIZATION_TIME_ZONES.find((z) => z.value === id)?.name;
  return name ? `${name} — ${id}` : id;
}

/** Select options with full labels, always including `current` when it is unlisted. */
export function timeZoneOptions(current) {
  const options = ORGANIZATION_TIME_ZONES.map((z) => ({ value: z.value, label: timeZoneLabel(z.value) }));
  if (current && !options.some((o) => o.value === current)) options.push({ value: current, label: timeZoneLabel(current) });
  return options;
}
