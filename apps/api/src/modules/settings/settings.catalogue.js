import { z } from 'zod';

/**
 * The settings catalogue — the Phase 1 "settings skeleton" (§13.2). Only
 * foundation-level settings appear; clinical/billing/payroll settings are owned
 * by their modules in later phases and register by extending this catalogue.
 * These two entries match the values seeded into every organization at
 * provisioning, so the registry default and the seeded value agree.
 *
 * @typedef {{ namespace: string, key: string, schema: import('zod').ZodType, default: unknown }} SettingDescriptor
 * @type {readonly SettingDescriptor[]}
 */
export const SETTINGS_CATALOGUE = [
  { namespace: 'security', key: 'sessionIdleTimeoutMinutes', schema: z.number().int().min(5).max(1440), default: 15 },
  { namespace: 'security', key: 'mfaRequiredForPrivilegedRoles', schema: z.boolean(), default: true },

  // Staffing — the company-configured weekly work requirement the BCBA panel
  // shows progress toward (BCBA panel spec §K/§L). A target of 0 means "not
  // configured": the weekly-progress block is simply not shown. weekStartsOn
  // (0 = Sunday … 6 = Saturday) anchors the company week; the week is measured
  // in the organization's own timezone, never a rolling 7-day window (§L).
  { namespace: 'staffing', key: 'weeklyHoursTarget', schema: z.number().min(0).max(168), default: 0 },
  { namespace: 'staffing', key: 'weekStartsOn', schema: z.number().int().min(0).max(6), default: 0 },
];
