import { createContext, createElement, useContext, useMemo } from 'react';

/**
 * Supplies the business timezone the picker uses for "Today". The web app
 * mounts it once with the authenticated organization's IANA zone (the same
 * `organizationTimezone` every other business-date surface reads); anywhere
 * without a provider — e.g. the platform console, whose operators have no
 * organization — falls back to the browser's calendar day.
 */
const DatePickerContext = createContext({ timeZone: null });

export function DatePickerProvider({ timeZone = null, children }) {
  const value = useMemo(() => ({ timeZone }), [timeZone]);
  return createElement(DatePickerContext.Provider, { value }, children);
}

export function useDatePickerTimeZone() {
  return useContext(DatePickerContext).timeZone;
}
