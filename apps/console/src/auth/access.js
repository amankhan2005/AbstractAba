/**
 * The single rule that governs console access: a signed-in principal that is a
 * platform operator. Tenant principals — however privileged within their
 * organization — can never reach the console. Pure and trivially testable.
 */
export function canAccessConsole(principal) {
  return principal?.isPlatformOperator ?? false;
}
