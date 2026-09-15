/**
 * The single rule that governs tenant-application access: a signed-in principal
 * that belongs to an organization (has an active tenant) and is NOT a platform
 * operator. A platform operator's place is the console — a tenant principal's is
 * here. The mirror image of the console's canAccessConsole. Pure and trivially
 * testable.
 */
export function canAccessApp(principal) {
  return Boolean(principal?.activeTenantId) && !principal?.isPlatformOperator;
}
