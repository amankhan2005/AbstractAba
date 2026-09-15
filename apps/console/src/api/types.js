/**
 * The shapes the platform API returns to the console (documentation only — JS
 * has no interfaces). The console reads only operator-facing metadata.
 * @typedef {{ userId: string, isPlatformOperator: boolean }} OperatorPrincipal
 * @typedef {{ outcome: string, accessToken?: string, accessTokenExpiresAt?: string }} SignInResult
 * @typedef {{ name: string, status: 'up'|'down', detail?: string }} HealthCheck
 * @typedef {{ status: 'up'|'down', version: string, startedAt: string, checks: HealthCheck[] }} PlatformHealth
 * @typedef {{ id: string, slug: string, tradingName: string, state: string, planCode: string|null, createdAt: string }} TenantSummary
 * @typedef {{ id: string, slug: string, legalName: string, tradingName: string, state: string, countryCode: string, stateCode: string|null, timezone: string, planCode: string|null, customDomain: string|null, parentOrganizationId: string|null, agreementExecuted: boolean, activatedAt: string|null, offboardingAt: string|null, createdAt: string, version: number }} TenantDetail
 * @typedef {{ id: string, sequence: number, actorId: string|null, action: string, entityType: string, entityId: string|null, outcome: 'success'|'failure', occurredAt: string }} AuditRecord
 * @typedef {{ intact: boolean, count: number, brokenAtSequence: number|null }} ChainVerification
 */
export {};
